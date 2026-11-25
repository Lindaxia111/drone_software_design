"""Run separately: python -m drone_lab.worker. One owner per SQLite database."""
import argparse
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from contextlib import contextmanager
from functools import partial
import logging
import math
from multiprocessing import get_context
from pathlib import Path
import os
import signal
import sqlite3
from threading import Event, Thread
import time

from .orchestration import Engine
from .storage import Store


@contextmanager
def worker_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    try:
        handle.seek(0)
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("此数据库已有 Worker；本地适配器只允许一个编排 Worker") from exc
        yield
    finally:
        handle.close()  # OS releases the lock even after abnormal process termination.


@contextmanager
def worker_heartbeat(store, worker_id, refresh):
    with store.transaction() as db:
        refresh(db)
    stop = Event()

    def pulse():
        while not stop.wait(3):
            try:
                with store.transaction() as db:
                    refresh(db)
            except sqlite3.OperationalError:
                logging.exception("Worker heartbeat write failed")

    thread = Thread(target=pulse, name="worker-heartbeat", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join()
        with store.transaction() as db:
            db.execute("DELETE FROM worker_heartbeat WHERE worker_id=?", (worker_id,))


def worker_limits():
    default_workers = max(1, min(4, (os.cpu_count() or 2) - 1))
    workers = int(os.getenv("DRONE_LAB_MAX_WORKERS", str(default_workers)))
    timeout = float(os.getenv("DRONE_LAB_L2_TIMEOUT_SEC", "60"))
    if workers < 1:
        raise ValueError("DRONE_LAB_MAX_WORKERS must be positive")
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("DRONE_LAB_L2_TIMEOUT_SEC must be finite and positive")
    return workers, timeout


def ignore_console_interrupts():
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, signal.SIG_IGN)


@contextmanager
def stop_requests():
    stopping = False
    signals = [signal.SIGINT, signal.SIGTERM]
    if hasattr(signal, "SIGBREAK"):
        signals.append(signal.SIGBREAK)

    def request_stop(signum, frame):
        nonlocal stopping
        stopping = True

    previous = {signum: signal.signal(signum, request_stop) for signum in signals}
    try:
        yield lambda: stopping
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.getenv("DRONE_LAB_DB", "data/drone_lab.sqlite3"))
    parser.add_argument("--interval", type=float, default=0.12)
    args = parser.parse_args()
    try:
        workers, l2_timeout_s = worker_limits()
    except ValueError as exc:
        parser.error(str(exc))
    logging.basicConfig(level=logging.INFO)
    path = Path(args.db).resolve()
    with worker_lock(path.with_suffix(".worker.lock")):
        store = Store(path)
        pid = os.getpid()
        worker_id = f"local-{pid}"
        refresh = partial(store.upsert_heartbeat, worker_id=worker_id, pid=pid)
        engine = Engine(store, heartbeat=refresh, l2_timeout_s=l2_timeout_s)
        engine.recover()
        with stop_requests() as stopping, worker_heartbeat(store, worker_id, refresh):
            logging.info("Worker ready: %s, L2 processes: %s, timeout: %gs", path, workers, l2_timeout_s)
            while not stopping():
                try:
                    with ProcessPoolExecutor(max_workers=workers, mp_context=get_context("spawn"),
                                             initializer=ignore_console_interrupts) as pool:
                        engine.pool = pool
                        while not stopping():
                            active = engine.tick()
                            time.sleep(max(0.01, args.interval) if active else 0.5)
                except BrokenProcessPool:
                    logging.exception("Recreating L2 process pool after a subprocess exited")
        logging.info("Worker stopped; committed state will resume next start")


if __name__ == "__main__":
    main()
