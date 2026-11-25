"""内容寻址的评估结果缓存（SQLite；path=None 时为内存库）。

对应文档"缓存拦截器"与铁律 2/4：键 = f(schema_version, ir_hash, 场景内容哈希, 层级, 评估器版本)。
TIMEOUT 与依赖机器负载的结果不入缓存。
"""
from __future__ import annotations

import sqlite3
import threading
from typing import Optional

from .schema import EvalResult


class ResultCache:
    def __init__(self, path: Optional[str] = None):
        self._db = sqlite3.connect(path or ":memory:", check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS eval_cache ("
                " cache_key TEXT PRIMARY KEY, ir_hash TEXT, scenario_id TEXT, level TEXT, payload TEXT)"
            )
            self._db.commit()
        self.hits = 0
        self.misses = 0

    def has(self, key: str) -> bool:
        with self._lock:
            return self._db.execute("SELECT 1 FROM eval_cache WHERE cache_key=?", (key,)).fetchone() is not None

    def get(self, key: str) -> Optional[EvalResult]:
        with self._lock:
            row = self._db.execute("SELECT payload FROM eval_cache WHERE cache_key=?", (key,)).fetchone()
        if row is None:
            self.misses += 1
            return None
        self.hits += 1
        return EvalResult.model_validate_json(row[0])

    def put(self, result: EvalResult) -> None:
        if result.status == "TIMEOUT" or not result.cache_key:
            return
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO eval_cache VALUES (?,?,?,?,?)",
                (result.cache_key, result.ir_hash, result.scenario_id, result.evaluator_level,
                 result.model_dump_json()),
            )
            self._db.commit()

    def __len__(self) -> int:
        with self._lock:
            return self._db.execute("SELECT COUNT(*) FROM eval_cache").fetchone()[0]

    def close(self) -> None:
        with self._lock:
            self._db.close()
