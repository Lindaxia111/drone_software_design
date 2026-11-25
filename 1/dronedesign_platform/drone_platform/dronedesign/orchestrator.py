"""核心编排引擎：实验状态机 + 预算守卫 + 缓存拦截器 + 漏斗分发/汇聚器（文档第三、四章）。

一代（generation）的流程：
  suggest → 去重/谱系登记 → [L1 缓存拦截→评估] → 目标约束检查 → 按 L1 适应度排序晋级
          → [L2 多场景评估，最坏情况聚合] → 约束+适应度 → observe → 收敛/预算判定
全部代数结束后，对 Top-K 可行方案做 L3 终审（若注册了 L3 评估器），最后计算帕累托前沿。
"""
from __future__ import annotations

import asyncio
import time
import uuid
from enum import Enum
from typing import Callable, Optional

from pydantic import BaseModel, Field

from .cache import ResultCache
from .schema import (
    Budget,
    DesignGoal,
    DroneIR,
    EvalResult,
    Level,
    TestScenario,
    Violation,
    make_cache_key,
)
from .spi import IEvaluator, IOptimizer

PENALTY_REJECTED = -1e6
PENALTY_FAILED = -3e6


# --------------------------------------------------------------------------
# 适应度 / 约束 / 聚合 / 帕累托
# --------------------------------------------------------------------------
def compute_fitness(metrics: dict[str, float], goal: DesignGoal, status: str, violations: list[Violation]) -> float:
    """越大越好。可行：目标加权和；不可行：分级惩罚（便于进化类算法爬坡）。"""
    if status in ("CRASHED", "TIMEOUT"):
        return PENALTY_FAILED
    if status == "REJECTED_CONSTRAINT" or violations:
        rel = sum(abs(v.actual - v.limit) / max(abs(v.limit), 1e-2) for v in violations)
        return PENALTY_REJECTED - 1e3 * min(rel, 1e3)
    s = 0.0
    for o in goal.objectives:
        if o.metric in metrics:
            s += (o.weight if o.direction == "maximize" else -o.weight) * metrics[o.metric]
    return s


def apply_goal_constraints(res: EvalResult, goal: DesignGoal, extra: Optional[dict[str, float]] = None) -> EvalResult:
    """把 DesignGoal 的约束叠加到评估结果上（缓存里的原始结果不受影响）。"""
    metrics = {**(extra or {}), **res.metrics}
    viols = list(res.violations)
    for c in goal.constraints:
        v = c.check(metrics)
        if v is not None:
            viols.append(v)
    status = res.status
    if status == "PASSED" and viols:
        status = "REJECTED_CONSTRAINT"
    return res.model_copy(update={"violations": viols, "status": status, "metrics": metrics})


_SEVERITY = {"PASSED": 0, "REJECTED_CONSTRAINT": 1, "CRASHED": 2, "TIMEOUT": 3}


def _worst_directions(goal: DesignGoal) -> dict[str, str]:
    d: dict[str, str] = {}
    for o in goal.objectives:
        d[o.metric] = "min" if o.direction == "maximize" else "max"
    for c in goal.constraints:  # 约束优先于目标
        if c.operator == "<=":
            d[c.metric] = "max"
        elif c.operator == ">=":
            d[c.metric] = "min"
    return d


def aggregate_scenarios(results: list[EvalResult], goal: DesignGoal) -> EvalResult:
    """多场景聚合：状态取最差；受约束/目标约束的指标取最坏情况，其余取均值。"""
    if len(results) == 1:
        return results[0]
    worst = _worst_directions(goal)
    names = sorted({k for r in results for k in r.metrics})
    metrics: dict[str, float] = {}
    for k in names:
        vals = [r.metrics[k] for r in results if k in r.metrics]
        mode = worst.get(k)
        metrics[k] = max(vals) if mode == "max" else min(vals) if mode == "min" else sum(vals) / len(vals)
    status = max((r.status for r in results), key=lambda s: _SEVERITY[s])
    viols: list[Violation] = []
    for r in results:
        for v in r.violations:
            viols.append(v.model_copy(update={"message": (v.message + f" [{r.scenario_id}]").strip()}))
    return EvalResult(
        ir_hash=results[0].ir_hash,
        scenario_id="+".join(r.scenario_id for r in results),
        evaluator_level=results[0].evaluator_level,
        execution_time_ms=sum(r.execution_time_ms for r in results),
        status=status,
        violations=viols,
        metrics=metrics,
        error="; ".join(r.error for r in results if r.error) or None,
    )


def pareto_front(items: dict[str, dict[str, float]], goal: DesignGoal) -> list[str]:
    """非支配集。items: ir_hash → 指标。"""
    def vec(m: dict[str, float]) -> Optional[list[float]]:
        try:
            return [m[o.metric] if o.direction == "maximize" else -m[o.metric] for o in goal.objectives]
        except KeyError:
            return None

    vecs = {h: v for h, m in items.items() if (v := vec(m)) is not None}
    front = []
    for h, v in vecs.items():
        dominated = any(
            all(a >= b for a, b in zip(w, v)) and any(a > b for a, b in zip(w, v))
            for h2, w in vecs.items()
            if h2 != h
        )
        if not dominated:
            front.append(h)
    return front


# --------------------------------------------------------------------------
# 状态机与记录
# --------------------------------------------------------------------------
class RunState(str, Enum):
    CREATED = "CREATED"
    RUNNING = "RUNNING"
    CONVERGED = "CONVERGED"
    BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
    TIMEOUT = "TIMEOUT"
    MAX_GENERATIONS = "MAX_GENERATIONS"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


_TERMINAL = {
    RunState.CONVERGED, RunState.BUDGET_EXHAUSTED, RunState.TIMEOUT,
    RunState.MAX_GENERATIONS, RunState.FAILED, RunState.CANCELLED,
}
_ALLOWED = {
    RunState.CREATED: {RunState.RUNNING, RunState.CANCELLED},
    RunState.RUNNING: _TERMINAL,
}


class CandidateRecord(BaseModel):
    ir_hash: str
    parent_ir_hash: Optional[str] = None
    generation: int
    ir: DroneIR
    l1: Optional[EvalResult] = None
    l2: Optional[EvalResult] = None
    l3: Optional[EvalResult] = None
    final_level: Level = "L1"
    final: Optional[EvalResult] = None


class GenerationStats(BaseModel):
    generation: int
    suggested: int
    new: int
    l1_executed: int
    l1_passed: int
    l2_promoted: int
    l2_passed: int
    cache_hits: int
    gen_best_fitness: Optional[float] = None
    best_fitness_so_far: Optional[float] = None
    elapsed_s: float


class ExperimentRun(BaseModel):
    run_id: str
    goal: DesignGoal
    scenarios: list[TestScenario]
    state: RunState = RunState.CREATED
    error: Optional[str] = None
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    generations: list[GenerationStats] = Field(default_factory=list)
    candidates: dict[str, CandidateRecord] = Field(default_factory=dict)
    budget_used: dict[str, int] = Field(default_factory=dict)
    cache_hits: dict[str, int] = Field(default_factory=dict)
    best_hash: Optional[str] = None
    pareto_hashes: list[str] = Field(default_factory=list)

    def transition(self, new: RunState) -> None:
        if new not in _ALLOWED.get(self.state, set()):
            raise RuntimeError(f"illegal transition {self.state.value} → {new.value}")
        self.state = new
        if new == RunState.RUNNING:
            self.started_at = time.time()
        if new in _TERMINAL:
            self.finished_at = time.time()

    def lineage(self, ir_hash: str) -> list[str]:
        """从种子到该方案的谱系链（hash 列表，种子在前）。"""
        chain, cur = [], ir_hash
        while cur:
            chain.append(cur)
            rec = self.candidates.get(cur)
            cur = rec.parent_ir_hash if rec else None
            if cur in chain:
                break
        return list(reversed(chain))


class BudgetGuard:
    def __init__(self, budget: Budget):
        self.budget = budget
        self.used = {"L1": 0, "L2": 0, "L3": 0}
        self._t0 = time.monotonic()
        self._limits = {"L1": budget.max_l1_evals, "L2": budget.max_l2_evals, "L3": budget.max_l3_evals}

    def remaining(self, level: str) -> int:
        return max(0, self._limits[level] - self.used[level])

    def charge(self, level: str, n: int) -> None:
        self.used[level] += n

    def timed_out(self) -> bool:
        return time.monotonic() - self._t0 >= self.budget.timeout_sec


# --------------------------------------------------------------------------
# 编排器
# --------------------------------------------------------------------------
class Orchestrator:
    def __init__(
        self,
        goal: DesignGoal,
        scenarios: list[TestScenario],
        optimizer: IOptimizer,
        seed_ir: DroneIR,
        evaluators: dict[str, IEvaluator],
        cache: Optional[ResultCache] = None,
        batch_size: int = 16,
        concurrency: int = 4,
        top_k_l3: int = 3,
        run_id: Optional[str] = None,
        on_generation: Optional[Callable[[GenerationStats, "ExperimentRun"], None]] = None,
    ):
        if "L1" not in evaluators:
            raise ValueError("an L1 evaluator is required")
        if not scenarios:
            raise ValueError("at least one TestScenario is required")
        self.goal, self.scenarios, self.optimizer = goal, scenarios, optimizer
        self.seed_ir = seed_ir.finalize()
        self.evaluators = evaluators
        self.cache = cache if cache is not None else ResultCache()  # 注意：空缓存 len==0 为假值
        self.batch_size, self.top_k_l3, self.on_generation = batch_size, top_k_l3, on_generation
        self.budget = BudgetGuard(goal.budget)
        self._sem = asyncio.Semaphore(concurrency)
        self._truncated = False
        self.run_record = ExperimentRun(
            run_id=run_id or uuid.uuid4().hex[:12],
            goal=goal,
            scenarios=scenarios,
            cache_hits={"L1": 0, "L2": 0, "L3": 0},
        )
        # 完整评估所用的最高层级（L3 只做 Top-K 终审）
        self._full_level: Level = "L2" if "L2" in evaluators else "L1"

    # ---- 缓存拦截 ---------------------------------------------------------
    def _key(self, level: str, ir: DroneIR, scenario: TestScenario) -> str:
        return make_cache_key(ir.ir_hash, scenario, level, self.evaluators[level].version)

    async def _eval(self, level: str, ir: DroneIR, scenario: TestScenario) -> tuple[EvalResult, bool]:
        key = self._key(level, ir, scenario)
        hit = self.cache.get(key)
        if hit is not None:
            self.run_record.cache_hits[level] += 1
            return hit, False
        async with self._sem:
            res = await self.evaluators[level].evaluate(ir, scenario)
        res = res.model_copy(update={"cache_key": key})
        self.cache.put(res)
        return res, True

    def _misses(self, level: str, ir: DroneIR, scenarios: list[TestScenario]) -> int:
        return sum(1 for s in scenarios if not self.cache.has(self._key(level, ir, s)))

    async def _eval_level(self, level: str, ir: DroneIR, scenarios: list[TestScenario]) -> tuple[list[EvalResult], int]:
        out = await asyncio.gather(*[self._eval(level, ir, s) for s in scenarios])
        return [r for r, _ in out], sum(1 for _, ex in out if ex)

    # ---- 主循环 -----------------------------------------------------------
    async def run(self) -> ExperimentRun:
        run = self.run_record
        run.transition(RunState.RUNNING)
        try:
            self.optimizer.init(self.goal, self.seed_ir)
            reason = RunState.MAX_GENERATIONS
            while True:
                stop = self._stop_reason(len(run.generations))
                if stop is not None:
                    reason = stop
                    break
                await self._generation()
                if self.optimizer.isConverged():
                    reason = RunState.CONVERGED
                    break
                if self._truncated:  # 本代已因预算被截断：不再开新一代
                    reason = RunState.BUDGET_EXHAUSTED
                    break
            if "L3" in self.evaluators and not self.budget.timed_out():
                await self._l3_review()
            self._finalize()
            run.transition(reason)
        except Exception as e:  # noqa: BLE001
            run.error = f"{type(e).__name__}: {e}"
            self._finalize()
            run.transition(RunState.FAILED)
            raise
        finally:
            run.budget_used = dict(self.budget.used)
            for ev in self.evaluators.values():
                ev.close()
        return run

    def run_sync(self) -> ExperimentRun:
        return asyncio.run(self.run())

    def _stop_reason(self, gen: int) -> Optional[RunState]:
        if gen >= self.goal.budget.max_generations:
            return RunState.MAX_GENERATIONS
        if self.budget.timed_out():
            return RunState.TIMEOUT
        if self.budget.remaining("L1") <= 0 or (
            self._full_level == "L2" and self.budget.remaining("L2") <= 0
        ):
            return RunState.BUDGET_EXHAUSTED
        return None

    # ---- 单代 -------------------------------------------------------------
    def _make_final(self, res: EvalResult, merged_metrics: dict[str, float]) -> EvalResult:
        adj = apply_goal_constraints(res, self.goal, extra=merged_metrics)
        fit = compute_fitness(adj.metrics, self.goal, adj.status, adj.violations)
        return adj.model_copy(update={"fitness_score": fit})

    async def _generation(self) -> None:
        run, goal, t0 = self.run_record, self.goal, time.monotonic()
        gen = len(run.generations)
        hits_before = sum(run.cache_hits.values())

        # 1) 生成候选 + 去重（同一 ir_hash 只处理一次）
        unique: list[DroneIR] = []
        seen: set[str] = set()
        suggested = self.optimizer.suggest(self.batch_size)
        for ir in suggested:
            ir = ir.finalize()
            if ir.ir_hash not in seen:
                seen.add(ir.ir_hash)
                unique.append(ir)
        new = [ir for ir in unique if ir.ir_hash not in run.candidates]

        # 2) L1：预算守卫先截断，再缓存拦截 + 并发评估
        sc1 = self.scenarios[0]
        miss = [ir for ir in new if self._misses("L1", ir, [sc1])]
        allowed = self.budget.remaining("L1")
        if len(miss) > allowed:
            drop = {ir.ir_hash for ir in miss[allowed:]}
            new = [ir for ir in new if ir.ir_hash not in drop]
            self._truncated = True
        l1_out = await asyncio.gather(*[self._eval("L1", ir, sc1) for ir in new])
        l1_exec = sum(1 for _, ex in l1_out if ex)
        self.budget.charge("L1", l1_exec)

        recs: list[CandidateRecord] = []
        for ir, (res, _) in zip(new, l1_out):
            final = self._make_final(res, {})
            rec = CandidateRecord(ir_hash=ir.ir_hash, parent_ir_hash=ir.parent_ir_hash, generation=gen,
                                  ir=ir, l1=final, final_level="L1", final=final)
            run.candidates[ir.ir_hash] = rec
            recs.append(rec)
        l1_pass = [r for r in recs if r.l1.feasible]  # type: ignore[union-attr]

        # 3) L2：按 L1 适应度排序，预算允许范围内晋级
        promoted: list[CandidateRecord] = []
        if "L2" in self.evaluators and l1_pass:
            remaining = self.budget.remaining("L2")
            for rec in sorted(l1_pass, key=lambda r: r.l1.fitness_score, reverse=True):  # type: ignore[union-attr]
                need = self._misses("L2", rec.ir, self.scenarios)
                if need > remaining:
                    self._truncated = True
                    break
                promoted.append(rec)
                remaining -= need
            l2_out = await asyncio.gather(*[self._eval_level("L2", r.ir, self.scenarios) for r in promoted])
            self.budget.charge("L2", sum(n for _, n in l2_out))
            for rec, (results, _) in zip(promoted, l2_out):
                agg = aggregate_scenarios(results, goal)
                rec.l2 = self._make_final(agg, rec.l1.metrics)  # type: ignore[union-attr]
                rec.final, rec.final_level = rec.l2, "L2"
        l2_pass = [r for r in promoted if r.l2 and r.l2.feasible]

        # 4) 汇总反馈给优化器
        feedback = [run.candidates[ir.ir_hash].final for ir in unique if ir.ir_hash in run.candidates]
        self.optimizer.observe([f for f in feedback if f is not None])

        gen_feasible = [
            r.final.fitness_score for ir in unique
            if (r := run.candidates.get(ir.ir_hash)) and r.final and r.final.feasible and r.final_level == self._full_level
        ]
        best_so_far = self._best_fitness()
        stats = GenerationStats(
            generation=gen, suggested=len(suggested), new=len(new), l1_executed=l1_exec,
            l1_passed=len(l1_pass), l2_promoted=len(promoted), l2_passed=len(l2_pass),
            cache_hits=sum(run.cache_hits.values()) - hits_before,
            gen_best_fitness=max(gen_feasible) if gen_feasible else None,
            best_fitness_so_far=best_so_far, elapsed_s=time.monotonic() - t0,
        )
        run.generations.append(stats)
        run.budget_used = dict(self.budget.used)
        if self.on_generation:
            self.on_generation(stats, run)

    def _fully_evaluated(self) -> list[CandidateRecord]:
        return [
            r for r in self.run_record.candidates.values()
            if r.final and r.final.feasible and r.final_level in (self._full_level, "L3")
        ]

    def _best_fitness(self) -> Optional[float]:
        pool = [r.final.fitness_score for r in self._fully_evaluated() if r.final_level == self._full_level]
        return max(pool) if pool else None

    # ---- L3 终审 / 收尾 -----------------------------------------------------
    async def _l3_review(self) -> None:
        pool = sorted(
            [r for r in self._fully_evaluated() if r.final_level == self._full_level],
            key=lambda r: r.final.fitness_score, reverse=True,  # type: ignore[union-attr]
        )[: self.top_k_l3]
        remaining = self.budget.remaining("L3")
        for rec in pool:
            need = self._misses("L3", rec.ir, self.scenarios)
            if need > remaining:
                break
            remaining -= need
            results, executed = await self._eval_level("L3", rec.ir, self.scenarios)
            self.budget.charge("L3", executed)
            agg = aggregate_scenarios(results, self.goal)
            rec.l3 = self._make_final(agg, rec.final.metrics)  # type: ignore[union-attr]
            rec.final, rec.final_level = rec.l3, "L3"

    def _finalize(self) -> None:
        run = self.run_record
        full = self._fully_evaluated()
        verified = [r for r in full if r.final_level == "L3"]
        pool = verified or full
        if pool:
            run.best_hash = max(pool, key=lambda r: r.final.fitness_score).ir_hash  # type: ignore[union-attr]
        run.pareto_hashes = pareto_front({r.ir_hash: r.final.metrics for r in pool}, self.goal)  # type: ignore[union-attr]
        run.budget_used = dict(self.budget.used)
