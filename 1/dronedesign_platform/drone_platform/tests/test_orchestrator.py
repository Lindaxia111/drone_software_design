import pytest

from dronedesign import (
    Budget,
    Constraint,
    DesignGoal,
    DomainRandomization,
    Environment,
    EvolutionStrategyOptimizer,
    L1Evaluator,
    L2Evaluator,
    Objective,
    Orchestrator,
    RandomSearchOptimizer,
    ResultCache,
    RunState,
    SearchDimension,
    TestScenario,
    Wind,
    make_multirotor,
)
from dronedesign.orchestrator import aggregate_scenarios, compute_fitness, pareto_front
from dronedesign.schema import EvalResult, Violation
from dronedesign.spi import IEvaluator

SPACE = [
    SearchDimension(param_path="rotors[*].arm_length_m", type="continuous", bounds=(0.18, 0.40)),
    SearchDimension(param_path="rotors[*].max_thrust_n", type="continuous", bounds=(8, 20)),
    SearchDimension(param_path="power.capacity_wh_coupled", type="continuous", bounds=(40, 150)),
]
SC = [TestScenario(
    scenario_id="wind", duration_s=5, sim_dt_s=0.01,
    environment=Environment(wind=Wind(type="constant", velocity_m_s=(3, 0, 0))),
    domain_randomization=DomainRandomization(enabled=True, trials=1, mass_variance_pct=10))]


def make_goal(**budget) -> DesignGoal:
    return DesignGoal(
        goal_id="g", name="t", search_space=SPACE,
        constraints=[Constraint(metric="total_mass_kg", operator="<=", limit=3.0),
                     Constraint(metric="thrust_to_weight_ratio", operator=">=", limit=2.0),
                     Constraint(metric="crash_rate", operator="<=", limit=0.0)],
        objectives=[Objective(metric="flight_time_min", direction="maximize"),
                    Objective(metric="tracking_rmse_m", direction="minimize", weight=20.0)],
        budget=Budget(**{"max_generations": 3, "max_l1_evals": 100, "max_l2_evals": 30, "max_l3_evals": 3,
                         "timeout_sec": 120, **budget}),
    )


def build(goal, cache=None, seed=1, evaluators=None, **kw):
    return Orchestrator(goal, SC, RandomSearchOptimizer(seed=seed), make_multirotor(),
                        evaluators or {"L1": L1Evaluator(), "L2": L2Evaluator()},
                        cache=cache, batch_size=8, **kw)


def test_full_run_produces_feasible_best_and_consistent_lineage():
    run = build(make_goal()).run_sync()
    assert run.state in (RunState.MAX_GENERATIONS, RunState.BUDGET_EXHAUSTED)
    assert run.best_hash is not None
    best = run.candidates[run.best_hash]
    assert best.final.feasible and best.final_level == "L2"
    assert best.final.metrics["total_mass_kg"] <= 3.0 and best.final.metrics["crash_rate"] == 0.0
    chain = run.lineage(run.best_hash)
    assert chain[-1] == run.best_hash
    root_parent = run.candidates[chain[0]].parent_ir_hash
    assert root_parent is None or root_parent not in run.candidates  # 谱系链确实追溯到了根
    assert all(run.candidates[b].parent_ir_hash == a for a, b in zip(chain, chain[1:]))
    assert set(run.pareto_hashes) <= set(run.candidates)
    assert run.best_hash in run.pareto_hashes  # 正权重加权和的最优解必然非支配


def test_budget_guard_never_overspends():
    run = build(make_goal(max_l1_evals=5, max_l2_evals=3)).run_sync()
    assert run.budget_used["L1"] <= 5 and run.budget_used["L2"] <= 3
    assert run.state == RunState.BUDGET_EXHAUSTED


def test_cache_makes_identical_rerun_free():
    cache = ResultCache()
    first = build(make_goal(), cache=cache).run_sync()
    second = build(make_goal(), cache=cache).run_sync()
    assert first.budget_used["L1"] > 0 and first.budget_used["L2"] > 0
    assert second.budget_used["L1"] == 0 and second.budget_used["L2"] == 0  # 全部命中缓存
    assert sum(second.cache_hits.values()) > 0
    assert second.best_hash == first.best_hash


def test_state_machine_rejects_illegal_transitions():
    run = build(make_goal(max_generations=1)).run_sync()
    with pytest.raises(RuntimeError):
        run.transition(RunState.RUNNING)


def test_l1_only_experiment_and_evolution_strategy_progress():
    goal = DesignGoal(goal_id="g", name="l1", search_space=SPACE,
                      constraints=[Constraint(metric="thrust_to_weight_ratio", operator=">=", limit=2.0),
                                   Constraint(metric="discharge_margin", operator=">=", limit=1.0)],
                      objectives=[Objective(metric="flight_time_min", direction="maximize")],
                      budget=Budget(max_generations=8, max_l1_evals=1000, timeout_sec=60))
    orch = Orchestrator(goal, SC, EvolutionStrategyOptimizer(mu=4, seed=3), make_multirotor(),
                        {"L1": L1Evaluator()}, batch_size=16)
    run = orch.run_sync()
    best = [s.best_fitness_so_far for s in run.generations if s.best_fitness_so_far is not None]
    assert best and all(b2 >= b1 for b1, b2 in zip(best, best[1:]))  # 历史最优单调不降
    assert best[-1] > best[0] or len(best) == 1
    assert run.candidates[run.best_hash].final_level == "L1"


class StubL3(IEvaluator):
    level = "L3"
    version = "stub"

    def __init__(self):
        self.calls = 0

    async def evaluate(self, ir, scenario):
        self.calls += 1
        return EvalResult(ir_hash=ir.ir_hash, scenario_id=scenario.scenario_id, evaluator_level="L3",
                          status="PASSED", metrics={"tracking_rmse_m": 0.05})


def test_l3_reviews_only_top_k_and_respects_budget():
    l3 = StubL3()
    run = build(make_goal(max_l3_evals=2), evaluators={"L1": L1Evaluator(), "L2": L2Evaluator(), "L3": l3},
                top_k_l3=5).run_sync()
    assert l3.calls == 2 and run.budget_used["L3"] == 2
    verified = [r for r in run.candidates.values() if r.final_level == "L3"]
    assert len(verified) == 2 and run.best_hash in {r.ir_hash for r in verified}


# ----------------------------- 纯函数 -------------------------------------
def _res(sid, status="PASSED", **m):
    return EvalResult(ir_hash="h", scenario_id=sid, evaluator_level="L2", status=status, metrics=m)


def test_aggregate_uses_worst_case_for_goal_metrics_and_worst_status():
    goal = make_goal()
    agg = aggregate_scenarios([_res("a", tracking_rmse_m=0.1, crash_rate=0.0, mean_power_w=100.0),
                               _res("b", status="CRASHED", tracking_rmse_m=0.4, crash_rate=1.0, mean_power_w=200.0)], goal)
    assert agg.status == "CRASHED"
    assert agg.metrics["tracking_rmse_m"] == 0.4 and agg.metrics["crash_rate"] == 1.0
    assert agg.metrics["mean_power_w"] == 150.0  # 非目标/约束指标取均值


def test_fitness_ranks_feasible_above_rejected_above_crashed():
    goal = make_goal()
    ok = compute_fitness({"flight_time_min": 20, "tracking_rmse_m": 0.1}, goal, "PASSED", [])
    bad = compute_fitness({}, goal, "REJECTED_CONSTRAINT", [Violation(rule="r", actual=1.0, limit=2.0)])
    worse = compute_fitness({}, goal, "REJECTED_CONSTRAINT", [Violation(rule="r", actual=0.1, limit=2.0)])
    crashed = compute_fitness({}, goal, "CRASHED", [])
    assert ok > bad > worse > crashed  # 违约越轻分越高 → 进化算法可爬坡


def test_pareto_front_handles_directions():
    goal = make_goal()  # maximize flight_time, minimize rmse
    items = {"a": {"flight_time_min": 20, "tracking_rmse_m": 0.10},
             "b": {"flight_time_min": 25, "tracking_rmse_m": 0.20},
             "c": {"flight_time_min": 19, "tracking_rmse_m": 0.15}}  # 被 a 支配
    assert sorted(pareto_front(items, goal)) == ["a", "b"]
