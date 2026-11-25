"""SQLite adapter: authoritative experiment state and transactional local task journal."""
from contextlib import contextmanager
import json
import sqlite3
import time
import uuid
from pathlib import Path

from .domain import ExperimentRequest, RevisionRequest
from .evaluators import pareto_indices


def uid():
    return uuid.uuid4().hex


def dump(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path, timeout=10) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, request TEXT NOT NULL, status TEXT NOT NULL,
                    created_at REAL NOT NULL, updated_at REAL NOT NULL, resumed_at REAL,
                    elapsed_sec REAL NOT NULL DEFAULT 0, next_index INTEGER NOT NULL DEFAULT 0,
                    l1_used INTEGER NOT NULL DEFAULT 0, l2_used INTEGER NOT NULL DEFAULT 0,
                    cache_hits INTEGER NOT NULL DEFAULT 0, stop_reason TEXT);
                CREATE TABLE IF NOT EXISTS candidates (
                    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
                    proposal_index INTEGER NOT NULL, generation INTEGER NOT NULL,
                    ir_hash TEXT NOT NULL, ir TEXT NOT NULL, status TEXT NOT NULL,
                    metrics TEXT NOT NULL DEFAULT '{}', violations TEXT NOT NULL DEFAULT '[]',
                    source TEXT NOT NULL DEFAULT 'optimizer', parent_ir_hash TEXT,
                    UNIQUE(run_id, proposal_index));
                CREATE TABLE IF NOT EXISTS evaluations (
                    id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id),
                    level TEXT NOT NULL, cache_key TEXT NOT NULL, result TEXT NOT NULL,
                    cache_hit INTEGER NOT NULL, UNIQUE(candidate_id, level));
                CREATE TABLE IF NOT EXISTS attempts (
                    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
                    level TEXT NOT NULL, status TEXT NOT NULL, started_at REAL NOT NULL,
                    finished_at REAL, error TEXT);
                CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, result TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
                    created_at REAL NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id, proposal_index);
                CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
            """)
            db.execute("BEGIN IMMEDIATE")
            columns = {row[1] for row in db.execute("PRAGMA table_info(candidates)")}
            if "source" not in columns:
                db.execute("ALTER TABLE candidates ADD COLUMN source TEXT NOT NULL DEFAULT 'optimizer'")
            if "parent_ir_hash" not in columns:
                db.execute("ALTER TABLE candidates ADD COLUMN parent_ir_hash TEXT")

    @contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def event(db, run_id, kind, message):
        db.execute("INSERT INTO events(run_id,created_at,kind,message) VALUES(?,?,?,?)",
                   (run_id, time.time(), kind, message))

    @staticmethod
    def set_status(db, run_id, status, reason=None):
        run = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        now = time.time()
        elapsed = run["elapsed_sec"] + (max(0, now-run["resumed_at"]) if run["resumed_at"] else 0)
        db.execute("UPDATE runs SET status=?,updated_at=?,resumed_at=?,elapsed_sec=?,stop_reason=? WHERE id=?",
                   (status, now, now if status == "RUNNING" else None, elapsed, reason, run_id))

    def create(self, request: ExperimentRequest):
        run_id, now = uid(), time.time()
        with self.transaction() as db:
            db.execute("INSERT INTO runs(id,request,status,created_at,updated_at) VALUES(?,?,?,?,?)",
                       (run_id, request.model_dump_json(), "PAUSED" if request.start_paused else "QUEUED", now, now))
            self.event(db, run_id, "CREATED", "实验已创建，等待手动启动" if request.start_paused else "实验已创建，等待计算 Worker")
        return self.detail(run_id)

    def transition(self, run_id, action):
        with self.transaction() as db:
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if not row:
                raise KeyError(run_id)
            target, allowed = {
                "pause": ("PAUSED", {"RUNNING", "QUEUED"}),
                "resume": ("QUEUED", {"PAUSED"}),
                "cancel": ("CANCELLED", {"RUNNING", "QUEUED", "PAUSED"}),
            }[action]
            if row["status"] not in allowed:
                raise ValueError(f"当前状态 {row['status']} 不允许 {action}")
            self.set_status(db, run_id, target, "USER_CANCELLED" if action == "cancel" else None)
            if action == "cancel":
                db.execute("UPDATE candidates SET status='SKIPPED' WHERE run_id=? AND source='manual_revision' AND status IN ('NEW','L1_PASSED')", (run_id,))
            self.event(db, run_id, target, {"pause": "实验已暂停；已派发任务可完成归档", "resume": "实验已进入恢复队列", "cancel": "实验已取消"}[action])
        return self.detail(run_id)

    def list_runs(self):
        with self.transaction() as db:
            rows = db.execute("SELECT * FROM runs ORDER BY created_at DESC LIMIT 100").fetchall()
            return [self.summary(row) for row in rows]

    @staticmethod
    def summary(row):
        item = dict(row)
        request = json.loads(item.pop("request"))
        item.update(name=request["goal"]["name"], budget=request["goal"]["budget"], seed=request["seed"])
        item["elapsed_sec"] += max(0, time.time()-item["resumed_at"]) if item["resumed_at"] else 0
        item.pop("resumed_at")
        return item

    def detail(self, run_id):
        with self.transaction() as db:
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if not row:
                raise KeyError(run_id)
            request = ExperimentRequest.model_validate_json(row["request"])
            candidates = []
            for c in db.execute("SELECT * FROM candidates WHERE run_id=? ORDER BY proposal_index", (run_id,)):
                item = dict(c)
                item["candidate_id"] = item.pop("id")
                for key in ("ir", "metrics", "violations"):
                    item[key] = json.loads(item[key])
                candidates.append(item)
            front = pareto_indices(candidates, request.goal.objectives)
            return {**self.summary(row), "request": request.model_dump(mode="json"),
                    "candidates": candidates, "pareto_ids": front,
                    "passed": sum(c["status"] == "PASSED" for c in candidates),
                    "rejected": sum(c["status"] == "REJECTED_CONSTRAINT" for c in candidates),
                    "events": [dict(e) for e in reversed(db.execute("SELECT * FROM events WHERE run_id=? ORDER BY seq DESC LIMIT 100", (run_id,)).fetchall())]}

    def report(self, run_id):
        detail = self.detail(run_id)
        with self.transaction() as db:
            evaluations = [dict(e) for e in db.execute("SELECT e.* FROM evaluations e JOIN candidates c ON c.id=e.candidate_id WHERE c.run_id=? ORDER BY c.proposal_index,e.level", (run_id,))]
            for e in evaluations:
                e["result"] = json.loads(e["result"])
            attempts = [dict(a) for a in db.execute("SELECT * FROM attempts WHERE run_id=? ORDER BY started_at", (run_id,))]
        fidelities = {e["result"]["fidelity"] for e in evaluations}
        level = "DYNAMICS" if "DYNAMICS" in fidelities else "DEMO" if "DEMO" in fidelities else "ANALYTIC" if fidelities else "PENDING"
        return {"report_schema_version": "1.1.0", "verification_level": level,
                "notice": "L2 为探索级 6-DOF 模型，未运行 L3。" if level == "DYNAMICS" else "演示或静态评估；未运行 L3。",
                "optimizer_version": "core-evolution/2.0.0" if detail["request"]["optimizer"] == "evolution" else "random-search/1.0.0", "experiment": detail,
                "evaluations": evaluations, "attempts": attempts}

    def candidate_details(self, run_id, candidate_id):
        with self.transaction() as db:
            run = db.execute("SELECT request FROM runs WHERE id=?", (run_id,)).fetchone()
            candidate = db.execute("SELECT * FROM candidates WHERE id=? AND run_id=?", (candidate_id, run_id)).fetchone()
            if not run or not candidate:
                raise KeyError(candidate_id)
            item = dict(candidate)
            item["candidate_id"] = item.pop("id")
            for key in ("ir", "metrics", "violations"):
                item[key] = json.loads(item[key])
            evaluations = [dict(e) for e in db.execute("SELECT * FROM evaluations WHERE candidate_id=? ORDER BY level", (candidate_id,))]
            for e in evaluations:
                e["result"] = json.loads(e["result"])
            return {"candidate": item, "request": ExperimentRequest.model_validate_json(run["request"]).model_dump(mode="json"),
                    "evaluations": evaluations,
                    "attempts": [dict(a) for a in db.execute("SELECT * FROM attempts WHERE candidate_id=? ORDER BY started_at", (candidate_id,))]}

    def retry(self, run_id):
        original = self.detail(run_id)
        request = ExperimentRequest.model_validate(original["request"])
        request.start_paused = False
        request.goal.name = request.goal.name[:95] + " · 复测"
        return self.create(request)

    def enqueue_revision(self, run_id: str, revision: RevisionRequest):
        from pydantic import ValidationError
        with self.transaction() as db:
            run = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if not run:
                raise KeyError(run_id)
            if run["status"] == "CANCELLED":
                raise ValueError("已取消的实验不能追加评估，请以此构型新建实验")
            parent = db.execute("SELECT id FROM candidates WHERE run_id=? AND ir_hash=?", (run_id, revision.parent_ir_hash)).fetchone()
            if not parent:
                raise KeyError(revision.parent_ir_hash)
            # Validate this concrete plane against the original scenario, not search bounds.
            data = json.loads(run["request"])
            data["seed_ir"] = revision.drone_ir.model_dump(mode="json")
            data["goal"]["search_space"] = []
            try:
                ExperimentRequest.model_validate(data)
            except ValidationError as exc:
                raise ValueError("修订与当前场景不兼容：" + "; ".join(e["msg"] for e in exc.errors())) from exc
            index = db.execute("SELECT COALESCE(MAX(proposal_index),-1)+1 FROM candidates WHERE run_id=?", (run_id,)).fetchone()[0]
            candidate_id = uid()
            db.execute("INSERT INTO candidates(id,run_id,proposal_index,generation,ir_hash,ir,status,source,parent_ir_hash) VALUES(?,?,?,?,?,?,?,?,?)",
                       (candidate_id, run_id, index, 0, revision.drone_ir.ir_hash, revision.drone_ir.model_dump_json(), "NEW", "manual_revision", revision.parent_ir_hash))
            self.event(db, run_id, "REVISION_QUEUED", f"手动修订候选 {index+1} 已入队；复用实验评估预算，原构型保持不变")
        return self.candidate_details(run_id, candidate_id)["candidate"]
