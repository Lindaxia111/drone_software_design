"""端到端示例：为"悬停抗风 + 长航时"任务自动寻优一架四旋翼。

运行：  python examples/demo.py            （约 1~2 分钟，2 核）
产物：  out/report.md   out/run.json   out/best_replay.json
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dronedesign import (  # noqa: E402
    Budget,
    Constraint,
    DesignGoal,
    DomainRandomization,
    Environment,
    EvolutionStrategyOptimizer,
    L1Evaluator,
    L2Evaluator,
    Mission,
    Objective,
    Orchestrator,
    ResultCache,
    SearchDimension,
    TestScenario,
    Wind,
    make_multirotor,
)
from dronedesign.evaluators import evaluate_l1_sync  # noqa: E402
from dronedesign.report import build_report, export_replay  # noqa: E402


def main() -> None:
    out = Path(__file__).resolve().parents[1] / "out"
    out.mkdir(exist_ok=True)

    goal = DesignGoal(
        goal_id="demo-endurance",
        name="抗风悬停 · 长航时四旋翼",
        search_space=[
            SearchDimension(param_path="rotors[*].arm_length_m", type="continuous", bounds=(0.18, 0.40)),
            SearchDimension(param_path="rotors[*].max_thrust_n", type="continuous", bounds=(8.0, 20.0)),
            SearchDimension(param_path="rotors[*].prop_radius_m", type="continuous", bounds=(0.09, 0.15)),
            SearchDimension(param_path="power.capacity_wh_coupled", type="continuous", bounds=(40.0, 150.0)),
        ],
        constraints=[
            Constraint(metric="total_mass_kg", operator="<=", limit=3.0),
            Constraint(metric="thrust_to_weight_ratio", operator=">=", limit=2.0),
            Constraint(metric="min_rotor_clearance_m", operator=">=", limit=0.02),
            Constraint(metric="discharge_margin", operator=">=", limit=1.0),  # 电池放电能力须覆盖满推力峰值
            Constraint(metric="crash_rate", operator="<=", limit=0.0),  # 质量扰动下不得坠毁
            Constraint(metric="max_tilt_deg", operator="<=", limit=25.0),
        ],
        objectives=[
            Objective(metric="flight_time_min", direction="maximize", weight=1.0),
            Objective(metric="tracking_rmse_m", direction="minimize", weight=20.0),
        ],
        budget=Budget(max_generations=10, max_l1_evals=600, max_l2_evals=80, max_l3_evals=0, timeout_sec=240),
    )
    scenarios = [
        TestScenario(
            scenario_id="hover_wind_dr", duration_s=8, sim_dt_s=0.005,
            mission=Mission(type="hover"),
            environment=Environment(wind=Wind(type="constant", velocity_m_s=(3.0, 1.0, 0.0))),
            domain_randomization=DomainRandomization(enabled=True, trials=2, mass_variance_pct=10.0),
        ),
        TestScenario(
            scenario_id="step_gust", duration_s=10, sim_dt_s=0.005,
            mission=Mission(type="step_response", step_m=(2.0, 0.0, 0.0)),
            environment=Environment(wind=Wind(type="gust", velocity_m_s=(4.0, 0.0, 0.0))),
        ),
    ]

    seed = make_multirotor()
    base = evaluate_l1_sync(seed, scenarios[0]).metrics
    print(f"种子机型：航时≈{base['flight_time_min']:.1f} min  质量 {base['total_mass_kg']:.2f} kg  "
          f"放电余量 {base['discharge_margin']:.2f}（<1 表示满推力时电池放不动）")

    orch = Orchestrator(
        goal, scenarios, EvolutionStrategyOptimizer(mu=6, seed=7), seed,
        {"L1": L1Evaluator(), "L2": L2Evaluator(max_workers=2)},
        cache=ResultCache(str(out / "cache.sqlite")),
        batch_size=16, concurrency=2,
        on_generation=lambda s, r: print(
            f"  第{s.generation:>2}代  新方案 {s.new:>2}  L1通过 {s.l1_passed:>2}  L2晋级/通过 {s.l2_promoted:>2}/{s.l2_passed:<2} "
            f" 历史最优 {s.best_fitness_so_far if s.best_fitness_so_far is not None else float('nan'):7.3f}  {s.elapsed_s:4.1f}s"
        ),
    )
    run = orch.run_sync()
    print(f"\n结束状态：{run.state.value}  预算使用：{run.budget_used}  缓存命中：{run.cache_hits}")

    (out / "report.md").write_text(build_report(run), encoding="utf-8")
    (out / "run.json").write_text(run.model_dump_json(indent=1), encoding="utf-8")
    if run.best_hash:
        best = run.candidates[run.best_hash]
        m = best.final.metrics
        print(f"最优方案 {best.ir_hash[:10]}：航时 {m['flight_time_min']:.1f} min，悬停 RMSE {m['tracking_rmse_m']:.3f} m，"
              f"质量 {m['total_mass_kg']:.2f} kg，TWR {m['thrust_to_weight_ratio']:.2f}")
        export_replay(best.ir, scenarios[1], out / "best_replay.json")
    print(f"产物已写入 {out}/")


if __name__ == "__main__":
    main()
