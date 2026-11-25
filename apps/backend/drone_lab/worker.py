"""Run separately: python -m drone_lab.worker. One owner per SQLite database."""
import argparse
from contextlib import contextmanager
import logging
from pathlib import Path
import os
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.getenv("DRONE_LAB_DB", "data/drone_lab.sqlite3"))
    parser.add_argument("--interval", type=float, default=0.12)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    path = Path(args.db).resolve()
    with worker_lock(path.with_suffix(".worker.lock")):
        engine = Engine(Store(path))
        engine.recover()
        logging.info("Worker ready: %s", path)
        try:
            while True:
                active = engine.tick()
                time.sleep(max(0.01, args.interval) if active else 0.5)
        except KeyboardInterrupt:
            logging.info("Worker stopped; committed state will resume next start")


if __name__ == "__main__":
    main()
