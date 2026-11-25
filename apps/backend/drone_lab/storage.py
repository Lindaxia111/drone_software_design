"""SQLite adapter: authoritative experiment state and transactional local task journal."""
from contextlib import contextmanager
import json
import sqlite3
import time
import uuid
from pathlib import Path

from .domain import ExperimentRequest, RenameRunRequest, RevisionRequest
from .evaluators import pareto_indices
from .optimizers import OPTIMIZER_VERSIONS

ATTEMPT_COLUMNS = "id, run_id, candidate_id, level, status, started_at, finished_at, error"


def uid():
    return uuid.uuid4().hex


def dump(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _enable_wal(db):
    # SQLite can skip the busy handler when two processes upgrade a new database to WAL.
    deadline = time.monotonic() + 5
    while True:
        try:
            db.execute("PRAGMA journal_mode=WAL").fetchone()
            return
        except sqlite3.OperationalError as exc:
            if exc.sqlite_errorcode != sqlite3.SQLITE_BUSY or time.monotonic() >= deadline:
                raise
            time.sleep(0.025)


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            _enable_wal(db)
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
                    finished_at REAL, error TEXT, pending_budget INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, result TEXT NOT NULL, last_used_at REAL);
                CREATE TABLE IF NOT EXISTS worker_heartbeat (
                    worker_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, status TEXT NOT NULL,
                    current_run_id TEXT, current_candidate_id TEXT, updated_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
                    created_at REAL NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS idx_candidates_run ON candidates(run_id, proposal_index);
                CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
                CREATE INDEX IF NOT EXISTS idx_attempts_run ON attempts(run_id);
                CREATE INDEX IF NOT EXISTS idx_attempts_running ON attempts(status) WHERE status='RUNNING';
            """)
        with self.transaction() as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(candidates)")}
            if "source" not in columns:
                db.execute("ALTER TABLE candidates ADD COLUMN source TEXT NOT NULL DEFAULT 'optimizer'")
            if "parent_ir_hash" not in columns:
                db.execute("ALTER TABLE candidates ADD COLUMN parent_ir_hash TEXT")
            if "last_used_at" not in {row[1] for row in db.execute("PRAGMA table_info(cache)")}:
                db.execute("ALTER TABLE cache ADD COLUMN last_used_at REAL")
            if "pending_budget" not in {row[1] for row in db.execute("PRAGMA table_info(attempts)")}:
                db.execute("ALTER TABLE attempts ADD COLUMN pending_budget INTEGER NOT NULL DEFAULT 0")
            db.execute("CREATE INDEX IF NOT EXISTS idx_cache_lru ON cache(last_used_at, key)")
            db.execute("UPDATE cache SET last_used_at=? WHERE last_used_at IS NULL", (time.time(),))

    @contextmanager
    def _connection(self):
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA busy_timeout=5000")
            db.execute("PRAGMA foreign_keys=ON")
            yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self, *, write=True):
        with self._connection() as db, db:
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db

    @staticmethod
    def upsert_heartbeat(db, *, worker_id, pid):
        active = db.execute("SELECT run_id,candidate_id FROM attempts WHERE status='RUNNING' ORDER BY started_at, rowid LIMIT 1").fetchone()
        run_id, candidate_id = tuple(active) if active else (None, None)
        db.execute("""
            INSERT INTO worker_heartbeat(worker_id,pid,status,current_run_id,current_candidate_id,updated_at)
            VALUES(?,?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET
                pid=excluded.pid, status=excluded.status, current_run_id=excluded.current_run_id,
                current_candidate_id=excluded.current_candidate_id, updated_at=excluded.updated_at
        """, (worker_id, pid, "busy" if active else "idle", run_id, candidate_id, time.time()))

    def latest_heartbeat(self):
        with self.transaction(write=False) as db:
            return db.execute("SELECT * FROM worker_heartbeat ORDER BY updated_at DESC,worker_id LIMIT 1").fetchone()

    @staticmethod
    def cached_result(db, key):
        row = db.execute("SELECT result FROM cache WHERE key=?", (key,)).fetchone()
        if row is not None:
            db.execute("UPDATE cache SET last_used_at=? WHERE key=?", (time.time(), key))
            return row["result"]
        return None

    @staticmethod
    def cache_result(db, key, result):
        db.execute("INSERT OR IGNORE INTO cache(key,result,last_used_at) VALUES(?,?,?)",
                   (key, result.model_dump_json(), time.time()))

    def prune_cache(self, max_entries=2000, max_age_days=None) -> int:
        return self.prune_cache_with_count(max_entries, max_age_days)["deleted"]

    def prune_cache_with_count(self, max_entries, max_age_days):
        with self.transaction() as db:
            deleted = 0
            if max_age_days is not None:
                cutoff = time.time() - max_age_days * 86400
                deleted = db.execute("DELETE FROM cache WHERE last_used_at < ?", (cutoff,)).rowcount
            deleted += db.execute("""
                DELETE FROM cache WHERE key IN (
                    SELECT key FROM cache ORDER BY last_used_at DESC,key DESC LIMIT -1 OFFSET ?)
            """, (max_entries,)).rowcount
            remaining = db.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
            return {"deleted": deleted, "remaining": remaining}

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

    def delete_run(self, run_id, *, force=False) -> bool:
        with self.transaction() as db:
            run = db.execute("SELECT status FROM runs WHERE id=?", (run_id,)).fetchone()
            if run is None:
                return False
            if run["status"] in {"RUNNING", "QUEUED"} and not force:
                raise ValueError("运行中或已排队的实验需要确认强制删除")
            db.execute("DELETE FROM events WHERE run_id=?", (run_id,))
            db.execute("DELETE FROM attempts WHERE run_id=?", (run_id,))
            db.execute("DELETE FROM evaluations WHERE candidate_id IN (SELECT id FROM candidates WHERE run_id=?)", (run_id,))
            db.execute("DELETE FROM candidates WHERE run_id=?", (run_id,))
            db.execute("DELETE FROM runs WHERE id=?", (run_id,))
            return True

    def rename_run(self, run_id, name):
        name = RenameRunRequest(name=name).name
        with self.transaction() as db:
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None:
                raise KeyError(run_id)
            request = json.loads(row["request"])
            request["goal"]["name"] = name
            row = db.execute("UPDATE runs SET request=?,updated_at=? WHERE id=? RETURNING *",
                             (dump(request), time.time(), run_id)).fetchone()
            return self.summary(row)

    def list_runs(self, limit=50, offset=0, status=None):
        with self.transaction(write=False) as db:
            rows = db.execute("""
                SELECT * FROM runs WHERE (? IS NULL OR status=?)
                ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?
            """, (status, status, limit, offset))
            return [self.summary(row) for row in rows]

    @staticmethod
    def _events_after(db, run_id, after_seq, limit):
        return [dict(row) for row in db.execute(
            "SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?", (run_id, after_seq, limit),
        )]

    def list_events_after(self, run_id, after_seq, limit=100):
        with self.transaction(write=False) as db:
            return self._events_after(db, run_id, after_seq, limit)

    def stream_snapshot(self, run_id, after_seq, limit):
        with self.transaction(write=False) as db:
            run = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if run is None:
                raise KeyError(run_id)
            done = run["status"] in {"COMPLETED", "CANCELLED"}
            if run["status"] == "COMPLETED":
                pending = db.execute("""
                    SELECT 1 FROM candidates WHERE run_id=? AND source='manual_revision'
                    AND status IN ('NEW','L1_PASSED') LIMIT 1
                """, (run_id,)).fetchone()
                done = pending is None
            return self.summary(run), self._events_after(db, run_id, after_seq, limit), done

    @staticmethod
    def summary(row):
        item = dict(row)
        request = json.loads(item.pop("request"))
        item.update(name=request["goal"]["name"], budget=request["goal"]["budget"], seed=request["seed"])
        item["elapsed_sec"] += max(0, time.time()-item["resumed_at"]) if item["resumed_at"] else 0
        item.pop("resumed_at")
        return item

    def detail(self, run_id):
        with self.transaction(write=False) as db:
            return self._detail(db, run_id)

    def _detail(self, db, run_id):
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
        with self.transaction(write=False) as db:
            detail = self._detail(db, run_id)
            evaluations = [dict(e) for e in db.execute("SELECT e.* FROM evaluations e JOIN candidates c ON c.id=e.candidate_id WHERE c.run_id=? ORDER BY c.proposal_index,e.level", (run_id,))]
            for e in evaluations:
                e["result"] = json.loads(e["result"])
            attempts = [dict(a) for a in db.execute(f"SELECT {ATTEMPT_COLUMNS} FROM attempts WHERE run_id=? ORDER BY started_at", (run_id,))]
        fidelities = {e["result"]["fidelity"] for e in evaluations}
        level = "DYNAMICS" if "DYNAMICS" in fidelities else "DEMO" if "DEMO" in fidelities else "ANALYTIC" if fidelities else "PENDING"
        return {"report_schema_version": "1.1.0", "verification_level": level,
                "notice": "L2 为探索级 6-DOF 模型，未运行 L3。" if level == "DYNAMICS" else "演示或静态评估；未运行 L3。",
                "optimizer_version": OPTIMIZER_VERSIONS[detail["request"]["optimizer"]], "experiment": detail,
                "evaluations": evaluations, "attempts": attempts}

    def candidate_details(self, run_id, candidate_id):
        with self.transaction(write=False) as db:
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
                    "attempts": [dict(a) for a in db.execute(f"SELECT {ATTEMPT_COLUMNS} FROM attempts WHERE candidate_id=? ORDER BY started_at", (candidate_id,))]}

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
