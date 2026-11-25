"""Durable sequential funnel. SQLite journal replaces a distributed queue in phase 1."""
import logging
import time

from .domain import DroneIR, EvalResult, ExperimentRequest
from .evaluators import AnalyticEvaluator, DemoEvaluator, cache_key, constraint_violations
from .optimizers import RandomOptimizer, EvolutionOptimizer
from .storage import Store, dump, uid

log = logging.getLogger(__name__)


class Engine:
    def __init__(self, store: Store):
        self.store = store
        self.optimizer = RandomOptimizer()
        self.evolution = EvolutionOptimizer()
        self.evaluators = {"L1": AnalyticEvaluator(), "L2": DemoEvaluator()}

    def recover(self):
        with self.store.transaction() as db:
            active = db.execute("SELECT DISTINCT run_id FROM attempts WHERE status='RUNNING'").fetchall()
            db.execute("UPDATE attempts SET status='INTERRUPTED',finished_at=?,error='worker restarted' WHERE status='RUNNING'", (time.time(),))
            for row in active:
                self.store.event(db, row["run_id"], "RECOVERED", "发现中断任务，将按剩余预算重新执行")

    def complete(self, db, run_id, reason):
        db.execute("UPDATE candidates SET status='SKIPPED' WHERE run_id=? AND status IN ('NEW','L1_PASSED')", (run_id,))
        self.store.set_status(db, run_id, "COMPLETED", reason)
        self.store.event(db, run_id, "COMPLETED", f"实验完成：{reason}")

    def tick(self) -> bool:
        # Reservation, candidate cursor and budget increment share one transaction.
        with self.store.transaction() as db:
            run = db.execute("SELECT * FROM runs WHERE status IN ('RUNNING','QUEUED') ORDER BY updated_at,created_at LIMIT 1").fetchone()
            if not run:
                return False
            run_id = run["id"]
            request = ExperimentRequest.model_validate_json(run["request"])
            budget = request.goal.budget
            if request.evaluation_mode == "dynamics":
                from .core_adapter import CoreL1Evaluator, DynamicsEvaluator
                evaluators = {"L1": CoreL1Evaluator(), "L2": DynamicsEvaluator()}
            else:
                evaluators = self.evaluators
            if run["status"] == "QUEUED":
                self.store.set_status(db, run_id, "RUNNING")
                self.store.event(db, run_id, "RUNNING", "计算 Worker 已接管实验")
                run = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            elapsed = run["elapsed_sec"] + time.time()-run["resumed_at"]
            if elapsed >= budget.timeout_sec:
                self.complete(db, run_id, "TIME_BUDGET")
                return True
            if request.evaluation_mode == "dynamics":
                evaluators["L2"].timeout_s = max(0.001, min(30, budget.timeout_sec-elapsed))
            candidate = db.execute("SELECT * FROM candidates WHERE run_id=? AND status IN ('NEW','L1_PASSED') ORDER BY proposal_index LIMIT 1", (run_id,)).fetchone()
            if not candidate:
                index = run["next_index"]
                if index >= budget.max_generations*budget.batch_size:
                    self.complete(db, run_id, "SEARCH_EXHAUSTED")
                    return True
                if request.optimizer == "evolution":
                    history = []
                    for c in db.execute("SELECT * FROM candidates WHERE run_id=? ORDER BY proposal_index", (run_id,)):
                        import json
                        history.append({**dict(c), "metrics": json.loads(c["metrics"]), "violations": json.loads(c["violations"])})
                    ir = self.evolution.suggest(request, index, history, run_id)
                else:
                    ir = self.optimizer.suggest(request, index)
                candidate_id = uid()
                db.execute("INSERT INTO candidates(id,run_id,proposal_index,generation,ir_hash,ir,status) VALUES(?,?,?,?,?,?,?)",
                    (candidate_id, run_id, index, index//budget.batch_size+1, ir.ir_hash, ir.model_dump_json(), "NEW"))
                db.execute("UPDATE runs SET next_index=next_index+1 WHERE id=?", (run_id,))
                candidate = db.execute("SELECT * FROM candidates WHERE id=?", (candidate_id,)).fetchone()
            ir = DroneIR.model_validate_json(candidate["ir"])
            level = "L1" if candidate["status"] == "NEW" else "L2"
            evaluator = evaluators[level]
            key = cache_key(ir, request.scenario, evaluator, request.seed)
            cached = db.execute("SELECT result FROM cache WHERE key=?", (key,)).fetchone()
            if cached:
                self._settle(db, run_id, candidate, level, key, EvalResult.model_validate_json(cached["result"]), request, True)
                return True
            column = "l1_used" if level == "L1" else "l2_used"
            limit = budget.max_l1_evals if level == "L1" else budget.max_l2_evals
            if run[column] >= limit:
                self.complete(db, run_id, f"{level}_BUDGET")
                return True
            attempt_id = uid()
            db.execute("UPDATE runs SET " + column + "=" + column + "+1,updated_at=? WHERE id=?", (time.time(), run_id))
            db.execute("INSERT INTO attempts(id,run_id,candidate_id,level,status,started_at) VALUES(?,?,?,?,?,?)",
                       (attempt_id, run_id, candidate["id"], level, "RUNNING", time.time()))
        started = time.perf_counter()
        error = None
        try:
            result = evaluator.evaluate(ir, request.scenario, request.seed)
        except Exception as exc:
            log.exception("Evaluator failed for %s", candidate["id"])
            error = str(exc)
            result = EvalResult(evaluator_level=level, evaluator_version=evaluator.version,
                status="CRASHED", fidelity="ANALYTIC" if level == "L1" else "DYNAMICS" if request.evaluation_mode == "dynamics" else "DEMO", message=error)
        result.execution_time_ms = (time.perf_counter()-started)*1000
        with self.store.transaction() as db:
            db.execute("UPDATE attempts SET status=?,finished_at=?,error=? WHERE id=?",
                       ("FAILED" if error or result.status in {"CRASHED", "TIMEOUT"} else "COMPLETED", time.time(), error or result.message or None, attempt_id))
            self._settle(db, run_id, candidate, level, key, result, request, False)
        return True

    def _settle(self, db, run_id, candidate, level, key, raw, request, cached):
        # Cache stores goal-independent physical measurements, before goal constraints.
        if raw.status not in {"CRASHED", "TIMEOUT"}:
            db.execute("INSERT OR IGNORE INTO cache(key,result) VALUES(?,?)", (key, raw.model_dump_json()))
        result = raw.model_copy(deep=True)
        if result.status == "PASSED":
            result.violations.extend(constraint_violations(result.metrics, request.goal.constraints))
            if result.violations:
                result.status = "REJECTED_CONSTRAINT"
        candidate_status = "L1_PASSED" if level == "L1" and result.status == "PASSED" else result.status
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
