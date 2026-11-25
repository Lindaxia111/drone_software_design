"""Durable evaluation funnel. Only the parent Worker accesses SQLite."""
import json
import logging
import time
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
from sqlite3 import Row

from .domain import DroneIR, EvalResult, ExperimentRequest
from .evaluators import AnalyticEvaluator, DemoEvaluator, apply_goal_constraints, cache_key
from .optimizers import EvolutionOptimizer, NSGA2Search, RandomOptimizer
from .storage import Store, dump, uid

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Attempt:
    id: str
    candidate: Row
    level: str
    key: str
    pending_budget: bool


class Engine:
    def __init__(self, store: Store, heartbeat=None, *, pool=None, l2_timeout_s=60):
        self.store = store
        self.heartbeat = heartbeat
        self.pool = pool
        self.l2_timeout_s = l2_timeout_s
        self.optimizer = RandomOptimizer()
        self.adaptive = {"evolution": EvolutionOptimizer(), "nsga2": NSGA2Search()}
        self.evaluators = {"L1": AnalyticEvaluator(), "L2": DemoEvaluator()}

    def recover(self):
        with self.store.transaction() as db:
            active = db.execute("SELECT run_id, SUM(pending_budget) AS debit FROM attempts WHERE status='RUNNING' GROUP BY run_id").fetchall()
            db.execute("UPDATE attempts SET status='INTERRUPTED',finished_at=?,error='worker restarted',pending_budget=0 WHERE status='RUNNING'", (time.time(),))
            for row in active:
                if row["debit"]:
                    db.execute("UPDATE runs SET l2_used=l2_used+?,updated_at=? WHERE id=?", (row["debit"], time.time(), row["run_id"]))
                self.store.event(db, row["run_id"], "RECOVERED", "发现中断任务，将按剩余预算重新执行")

    def complete(self, db, run_id, reason):
        db.execute("UPDATE candidates SET status='SKIPPED' WHERE run_id=? AND source='optimizer' AND status IN ('NEW','L1_PASSED')", (run_id,))
        self.store.set_status(db, run_id, "COMPLETED", reason)
        self.store.event(db, run_id, "COMPLETED", f"实验完成：{reason}")

    @staticmethod
    def _remaining(run, budget, manual):
        if manual:
            # A revision of a stopped experiment gets a fresh time window, with its remaining evaluation counts.
            return budget.timeout_sec
        return budget.timeout_sec - run["elapsed_sec"] - max(0, time.time() - run["resumed_at"])

    def _notify(self, db):
        if self.heartbeat:
            self.heartbeat(db)

    def _skip_for_budget(self, db, run_id, candidate, level, manual):
        if manual:
            db.execute("UPDATE candidates SET status='SKIPPED' WHERE id=?", (candidate["id"],))
            self.store.event(db, run_id, "REVISION_SKIPPED", f"手动修订候选 {candidate['proposal_index']+1}：{level} 预算耗尽，可另建实验")
        else:
            self.complete(db, run_id, f"{level}_BUDGET")

    @staticmethod
    def _pending(db, run_id, limit):
        return db.execute("""
            SELECT * FROM candidates WHERE run_id=? AND source='optimizer' AND status IN ('NEW','L1_PASSED')
            ORDER BY proposal_index LIMIT ?
        """, (run_id, limit)).fetchall()

    def _propose(self, db, run, request, count):
        if count <= 0:
            return []
        run_id = run["id"]
        index = run["next_index"]
        ordinal = db.execute("SELECT COALESCE(MAX(proposal_index),-1)+1 FROM candidates WHERE run_id=?", (run_id,)).fetchone()[0]
        optimizer = self.adaptive.get(request.optimizer)
        if optimizer is not None:
            history = [{**dict(row), "proposal_index": i, "metrics": json.loads(row["metrics"]), "violations": json.loads(row["violations"])}
                       for i, row in enumerate(db.execute("SELECT * FROM candidates WHERE run_id=? AND source='optimizer' ORDER BY proposal_index", (run_id,)))]
        result = []
        for offset in range(count):
            proposal = index + offset
            ir = optimizer.suggest(request, proposal, history, run_id) if optimizer is not None else self.optimizer.suggest(request, proposal)
            row = db.execute("""
                INSERT INTO candidates(id,run_id,proposal_index,generation,ir_hash,ir,status) VALUES(?,?,?,?,?,?,?) RETURNING *
            """, (uid(), run_id, ordinal + offset, proposal // request.goal.budget.batch_size + 1,
                  ir.ir_hash, ir.model_dump_json(), "NEW")).fetchone()
            result.append(row)
        db.execute("UPDATE runs SET next_index=next_index+? WHERE id=?", (count, run_id))
        return result

    def _reserve(self, db, candidate, level, key, *, pending_budget=False):
        attempt = Attempt(uid(), candidate, level, key, pending_budget)
        run_id = candidate["run_id"]
        now = time.time()
        if not pending_budget:
            column = "l1_used" if level == "L1" else "l2_used"
            db.execute(f"UPDATE runs SET {column}={column}+1,updated_at=? WHERE id=?", (now, run_id))
        db.execute("""
            INSERT INTO attempts(id,run_id,candidate_id,level,status,started_at,pending_budget) VALUES(?,?,?,?,'RUNNING',?,?)
        """, (attempt.id, run_id, candidate["id"], level, now, pending_budget))
        return attempt

    def _settle_cached(self, db, candidate, level, key, request):
        cached = self.store.cached_result(db, key)
        if cached is None:
            return False
        self._settle(db, candidate["run_id"], candidate, level, key, EvalResult.model_validate_json(cached), request, True)
        return True

    def tick(self) -> bool:
        with self.store.transaction() as db:
            # Explicit revisions retain priority and may run after a pause or completion.
            candidate = db.execute("""
                SELECT c.* FROM candidates c JOIN runs r ON r.id=c.run_id
                WHERE c.source='manual_revision' AND c.status IN ('NEW','L1_PASSED') AND r.status!='CANCELLED'
                ORDER BY c.rowid LIMIT 1
            """).fetchone()
            manual = candidate is not None
            run = (db.execute("SELECT * FROM runs WHERE id=?", (candidate["run_id"],)).fetchone() if manual
                   else db.execute("SELECT * FROM runs WHERE status IN ('RUNNING','QUEUED') ORDER BY updated_at,created_at LIMIT 1").fetchone())
            if not run:
                return False
            run_id = run["id"]
            request = ExperimentRequest.model_validate_json(run["request"])
            budget = request.goal.budget
            if run["status"] == "QUEUED" and not manual:
                self.store.set_status(db, run_id, "RUNNING")
                self.store.event(db, run_id, "RUNNING", "计算 Worker 已接管实验")
                run = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            remaining = self._remaining(run, budget, manual)
            if remaining <= 0:
                self.complete(db, run_id, "TIME_BUDGET")
                return True

            dynamics = request.evaluation_mode == "dynamics"
            if dynamics:
                from .core_adapter import CoreL1Evaluator, DynamicsEvaluator
                evaluators = {"L1": CoreL1Evaluator(), "L2": DynamicsEvaluator(min(self.l2_timeout_s, remaining))}
            else:
                evaluators = self.evaluators
            parallel = dynamics and self.pool is not None
            batch = [candidate] if manual else self._pending(db, run_id, budget.batch_size if parallel else 1)
            if not manual:
                index = run["next_index"]
                generation = batch[0]["generation"] if batch else index // budget.batch_size + 1
                missing = min(generation, budget.max_generations) * budget.batch_size - index
                count = missing if parallel else (0 if batch else min(1, missing))
                batch += self._propose(db, run, request, count)
                if not batch:
                    self.complete(db, run_id, "SEARCH_EXHAUSTED")
                    return True

            if not parallel:
                candidate = batch[0]
                level = "L1" if candidate["status"] == "NEW" else "L2"
                evaluator = evaluators[level]
                ir = DroneIR.model_validate_json(candidate["ir"])
                key = cache_key(ir, request.scenario, evaluator, request.seed)
                if self._settle_cached(db, candidate, level, key, request):
                    self._notify(db)
                    return True
                if run["l1_used" if level == "L1" else "l2_used"] >= (budget.max_l1_evals if level == "L1" else budget.max_l2_evals):
                    self._skip_for_budget(db, run_id, candidate, level, manual)
                    return True
                attempt = self._reserve(db, candidate, level, key)
                self._notify(db)

        if parallel:
            self._evaluate_batch(run_id, batch, request, evaluators, manual)
        else:
            self._evaluate_one(attempt, ir, request, evaluator)
        return True

    def _dispatchable_run(self, db, run_id, request, manual):
        run = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if not run or run["status"] == "CANCELLED" or (not manual and run["status"] != "RUNNING"):
            return None
        if self._remaining(run, request.goal.budget, manual) <= 0:
            self.complete(db, run_id, "TIME_BUDGET")
            return None
        return run

    def _evaluate_batch(self, run_id, batch, request, evaluators, manual):
        from .core_adapter import evaluate_l2_task

        budget = request.goal.budget
        blocked_l1 = False
        for candidate in batch:
            if candidate["status"] != "NEW":
                continue
            ir = DroneIR.model_validate_json(candidate["ir"])
            key = cache_key(ir, request.scenario, evaluators["L1"], request.seed)
            with self.store.transaction() as db:
                run = self._dispatchable_run(db, run_id, request, manual)
                if run is None:
                    return
                if self._settle_cached(db, candidate, "L1", key, request):
                    self._notify(db)
                    continue
                if run["l1_used"] >= budget.max_l1_evals:
                    blocked_l1 = True
                    continue
                attempt = self._reserve(db, candidate, "L1", key)
                self._notify(db)
            self._evaluate_one(attempt, ir, request, evaluators["L1"])

        # A single physical calculation per cache key; equivalent proposals use its result after settlement.
        tasks: dict[str, tuple[Attempt, list[Row]]] = {}
        blocked_l2 = False
        with self.store.transaction() as db:
            run = self._dispatchable_run(db, run_id, request, manual)
            if run is None:
                return
            deadline = time.monotonic() + self._remaining(run, budget, manual)
            for original in batch:
                candidate = db.execute("SELECT * FROM candidates WHERE id=? AND status='L1_PASSED'", (original["id"],)).fetchone()
                if candidate is None:
                    continue
                ir = DroneIR.model_validate_json(candidate["ir"])
                key = cache_key(ir, request.scenario, evaluators["L2"], request.seed)
                if self._settle_cached(db, candidate, "L2", key, request):
                    continue
                if key in tasks:
                    tasks[key][1].append(candidate)
                elif run["l2_used"] + len(tasks) < budget.max_l2_evals:
                    tasks[key] = (self._reserve(db, candidate, "L2", key, pending_budget=True), [])
                else:
                    blocked_l2 = True
            if not tasks and (blocked_l1 or blocked_l2):
                self._skip_for_budget(db, run_id, batch[0], "L1" if blocked_l1 else "L2", manual)
            self._notify(db)

        if not tasks:
            return
        scenario_json = request.scenario.model_dump_json()
        futures = []
        broken = None
        for attempt, followers in tasks.values():
            candidate = attempt.candidate
            try:
                future = self.pool.submit(evaluate_l2_task, candidate["ir"], scenario_json, request.seed,
                                          json.loads(candidate["metrics"]), self.l2_timeout_s, deadline)
                futures.append((attempt, followers, future))
            except BrokenProcessPool as exc:
                futures.append((attempt, followers, exc))

        results = []
        for attempt, followers, future in futures:
            try:
                if isinstance(future, BrokenProcessPool):
                    raise future
                result = future.result()
            except Exception as exc:
                if isinstance(exc, BrokenProcessPool):
                    broken = exc
                result = self._failed(attempt, request, evaluators["L2"], exc)
            results.append((attempt, followers, result))

        with self.store.transaction() as db:
            for attempt, followers, result in results:
                if self._finish_attempt(db, attempt, request, result):
                    for candidate in followers:
                        self._settle_cached(db, candidate, "L2", attempt.key, request)
            self._notify(db)
        if broken is not None:
            raise broken  # The Worker owns the pool and can replace a broken one.

    @staticmethod
    def _failed(attempt, request, evaluator, error):
        log.exception("Evaluator failed for %s", attempt.candidate["id"])
        fidelity = "ANALYTIC" if attempt.level == "L1" else "DYNAMICS" if request.evaluation_mode == "dynamics" else "DEMO"
        return EvalResult(evaluator_level=attempt.level, evaluator_version=evaluator.version, status="CRASHED", fidelity=fidelity, message=str(error))

    def _evaluate_one(self, attempt, ir, request, evaluator):
        started = time.perf_counter()
        try:
            result = evaluator.evaluate(ir, request.scenario, request.seed)
        except Exception as exc:
            result = self._failed(attempt, request, evaluator, exc)
        result.execution_time_ms = (time.perf_counter() - started) * 1000
        with self.store.transaction() as db:
            self._finish_attempt(db, attempt, request, result)
            self._notify(db)

    def _finish_attempt(self, db, attempt, request, result):
        settled = db.execute("UPDATE attempts SET status=?,finished_at=?,error=?,pending_budget=0 WHERE id=? AND status='RUNNING'",
            ("FAILED" if result.status in {"CRASHED", "TIMEOUT"} else "COMPLETED", time.time(), result.message or None, attempt.id))
        if not settled.rowcount:  # A force-deleted run cannot be resurrected by an in-flight evaluation.
            return False
        run_id = attempt.candidate["run_id"]
        if attempt.pending_budget:
            db.execute("UPDATE runs SET l2_used=l2_used+1 WHERE id=?", (run_id,))
        self._settle(db, run_id, attempt.candidate, attempt.level, attempt.key, result, request, False)
        return True

    def _settle(self, db, run_id, candidate, level, key, raw, request, cached):
        # Cache stores goal-independent physical measurements, before goal constraints.
        if not cached and raw.status not in {"CRASHED", "TIMEOUT"}:
            self.store.cache_result(db, key, raw)
        result = raw.model_copy(deep=True)
        apply_goal_constraints(result, request.goal)
        candidate_status = "L1_PASSED" if level == "L1" and result.status == "PASSED" else result.status
        if result.status != "PASSED" or all(o.metric in result.metrics for o in request.goal.objectives):
            result.fitness_score = EvolutionOptimizer.score({"status": result.status, "metrics": result.metrics,
                "violations": [v.model_dump() for v in result.violations]}, request)
        db.execute("INSERT INTO evaluations(id,candidate_id,level,cache_key,result,cache_hit) VALUES(?,?,?,?,?,?)",
                   (uid(), candidate["id"], level, key, result.model_dump_json(), int(cached)))
        db.execute("UPDATE candidates SET status=?,metrics=?,violations=? WHERE id=?",
                   (candidate_status, dump(result.metrics), dump([v.model_dump() for v in result.violations]), candidate["id"]))
        db.execute("UPDATE runs SET cache_hits=cache_hits+?,updated_at=? WHERE id=?", (int(cached), time.time(), run_id))
        self.optimizer.observe([result])
        message = f"候选 {candidate['proposal_index']+1} · {level} · {result.status}"
        if cached:
            message += " · 命中缓存"
        self.store.event(db, run_id, "EVALUATED", message)
