from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from multiprocessing import get_context
import os
import sqlite3
import time
from unittest.mock import patch

import numpy as np
import pytest

from drone_lab import core_adapter
from drone_lab.core_adapter import evaluate_l2_task
from drone_lab.domain import ExperimentRequest, baseline_ir
from drone_lab.orchestration import Engine
from drone_lab.storage import Store
from drone_lab.worker import ignore_console_interrupts, worker_limits
from dronedesign.optimizers.nsga2 import crowding_distance, non_dominated_sort


def _finish(engine):
    for _ in range(120):
        if not engine.tick():
            return
    pytest.fail("experiment did not finish")


def _checked_l2_task(*args):
    start = time.monotonic()
    with patch.object(sqlite3, "connect", side_effect=AssertionError("L2 subprocess opened SQLite")):
        result = evaluate_l2_task(*args)
    result.resolved_parameters.update(test_pid=os.getpid(), test_start=start, test_end=time.monotonic())
    return result


def _dynamics_request():
    return ExperimentRequest.model_validate({
        "evaluation_mode": "dynamics",
        "goal": {"budget": {"max_generations": 1, "batch_size": 4, "max_l1_evals": 4,
                            "max_l2_evals": 4, "timeout_sec": 30},
                 "search_space": [{"param_path": "power.capacity_wh", "bounds": [50, 70]}]},
        "scenario": {"duration_s": 1, "sim_dt_s": 0.01},
    })


def test_parallel_l2_is_numeric_only_and_settles_atomically(tmp_path, monkeypatch):
    monkeypatch.setattr(core_adapter, "evaluate_l2_task", _checked_l2_task)
    store = Store(tmp_path / "pool.sqlite3")
    request = _dynamics_request()
    request.scenario.duration_s = 5
    run_id = store.create(request)["id"]
    with ProcessPoolExecutor(max_workers=2, mp_context=get_context("spawn"), initializer=ignore_console_interrupts) as pool:
        # Separate the concurrent simulation test from first-use process startup.
        warmup = [pool.submit(time.sleep, 0.3) for _ in range(2)]
        for ready in warmup:
            ready.result()
        engine = Engine(store, pool=pool)
        with ThreadPoolExecutor(max_workers=1) as parent:
            tick = parent.submit(engine.tick)
            observed_pending = False
            while not tick.done():
                report = store.report(run_id)
                attempts = [a for a in report["attempts"] if a["level"] == "L2"]
                l2_used = report["experiment"]["l2_used"]
                assert l2_used in (0, 4)
                if attempts and l2_used == 0 and not observed_pending:
                    assert len(attempts) == 4 and all(a["status"] == "RUNNING" for a in attempts)
                    assert all("pending_budget" not in a for a in attempts)
                    store.rename_run(run_id, "Rename while L2 is running")
                    observed_pending = True
                time.sleep(0.01)
            assert tick.result()
        assert observed_pending
        _finish(engine)
        cached_id = store.create(request)["id"]
        _finish(engine)

    report = store.report(run_id)
    assert report["experiment"]["name"] == "Rename while L2 is running"
    assert report["experiment"]["l1_used"] == report["experiment"]["l2_used"] == 4
    assert report["experiment"]["stop_reason"] == "SEARCH_EXHAUSTED"
    results = [e["result"] for e in report["evaluations"] if e["level"] == "L2"]
    assert len(results) == 4 and all(r["status"] == "PASSED" for r in results)
    timings = [r["resolved_parameters"] for r in results]
    pids = {t["test_pid"] for t in timings}
    assert len(pids) == 2 and os.getpid() not in pids
    assert any(a["test_pid"] != b["test_pid"] and max(a["test_start"], b["test_start"]) < min(a["test_end"], b["test_end"])
               for a in timings for b in timings)
    cached = store.detail(cached_id)
    assert cached["cache_hits"] == 8 and cached["l1_used"] == cached["l2_used"] == 0

    serial = Store(tmp_path / "serial.sqlite3")
    serial_run = serial.create(request)["id"]
    _finish(Engine(serial))
    assert [(c["ir_hash"], c["metrics"]) for c in report["experiment"]["candidates"]] == [
        (c["ir_hash"], c["metrics"]) for c in serial.detail(serial_run)["candidates"]]


def test_interrupted_batch_is_charged_only_once_on_recovery(tmp_path):
    class InterruptedPool:
        def submit(self, *args):
            raise KeyboardInterrupt

    store = Store(tmp_path / "interrupted-lock.sqlite3")
    run_id = store.create(_dynamics_request())["id"]
    with pytest.raises(KeyboardInterrupt):
        Engine(store, pool=InterruptedPool()).tick()
    assert store.detail(run_id)["l2_used"] == 0

    restarted = Engine(Store(store.path))
    restarted.recover()
    restarted.recover()
    _finish(restarted)
    report = store.report(run_id)
    assert report["experiment"]["stop_reason"] == "L2_BUDGET"
    assert report["experiment"]["l2_used"] == 4
    assert [a["status"] for a in report["attempts"] if a["level"] == "L2"] == ["INTERRUPTED"] * 4


def test_duplicate_l2_keys_use_one_dispatch_even_at_budget_limit(tmp_path):
    request = _dynamics_request()
    request.goal.search_space = []
    request.goal.budget.max_l2_evals = 1
    store = Store(tmp_path / "duplicate.sqlite3")
    run_id = store.create(request)["id"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        _finish(Engine(store, pool=pool))
    report = store.report(run_id)
    assert report["experiment"]["l1_used"] == report["experiment"]["l2_used"] == 1
    assert report["experiment"]["passed"] == 4
    assert report["experiment"]["cache_hits"] == 6
    assert [e["cache_hit"] for e in report["evaluations"] if e["level"] == "L2"] == [0, 1, 1, 1]


def test_l2_limits_include_queue_wait_and_allow_timeout_above_thirty(monkeypatch):
    monkeypatch.delenv("DRONE_LAB_MAX_WORKERS", raising=False)
    monkeypatch.delenv("DRONE_LAB_L2_TIMEOUT_SEC", raising=False)
    monkeypatch.setattr(os, "cpu_count", lambda: 8)
    assert worker_limits() == (4, 60)
    monkeypatch.setenv("DRONE_LAB_MAX_WORKERS", "2")
    monkeypatch.setenv("DRONE_LAB_L2_TIMEOUT_SEC", "75")
    assert worker_limits() == (2, 75)

    request = _dynamics_request()
    args = baseline_ir().model_dump_json(), request.scenario.model_dump_json(), request.seed, {}
    durations = []
    evaluate = core_adapter.DynamicsEvaluator.evaluate

    def capture(self, *args, **kwargs):
        durations.append(self.timeout_s)
        return evaluate(self, *args, **kwargs)

    monkeypatch.setattr(core_adapter.DynamicsEvaluator, "evaluate", capture)
    assert evaluate_l2_task(*args, 75, time.monotonic() - 1).status == "TIMEOUT"
    assert evaluate_l2_task(*args, 75, time.monotonic() + 45).status == "PASSED"
    assert 44 < durations[0] <= 45 and len(durations) == 1


def test_nsga2_ranks_feasibility_first_and_preserves_front_extremes():
    values = np.array([[1, 4], [2, 2], [4, 1], [3, 3], [0, 0], [-1, -1], [0, 1]])
    fronts = non_dominated_sort(values, np.array([0, 0, 0, 0, 0.1, 0.3, 0.1]))
    assert [front.tolist() for front in fronts] == [[0, 1, 2], [3], [4, 6], [5]]
    assert crowding_distance(values[fronts[0]]).tolist() == [np.inf, 2, np.inf]


def test_nsga2_reproduces_after_restart_and_exports_a_valid_pareto_front(tmp_path):
    request = ExperimentRequest.model_validate({
        "optimizer": "nsga2", "seed": 27,
        "goal": {"budget": {"max_generations": 4, "batch_size": 6},
                 "objectives": [{"metric": "flight_time_min", "direction": "maximize"},
                                {"metric": "total_mass_kg", "direction": "minimize"}]},
    })

    def run(name, restart):
        store = Store(tmp_path / f"{name}.sqlite3")
        run_id = store.create(request)["id"]
        engine = Engine(store)
        if restart:
            while store.detail(run_id)["next_index"] < 8:
                assert engine.tick()
            engine = Engine(Store(store.path))
            engine.recover()
        _finish(engine)
        report = store.report(run_id)
        assert report["optimizer_version"] == "core-nsga2/1.0.0"
        detail = report["experiment"]
        assert detail["stop_reason"] == "SEARCH_EXHAUSTED" and len(detail["candidates"]) == 24
        return detail

    a, b = run("uninterrupted", False), run("restarted", True)
    properties = ("ir_hash", "generation", "status", "metrics", "violations")
    assert [[c[p] for p in properties] for c in a["candidates"]] == [[c[p] for p in properties] for c in b["candidates"]]
    for c in a["candidates"]:
        assert 35 <= c["ir"]["power"]["capacity_wh"] <= 130
        assert all(3 <= r["max_thrust_n"] <= 12 for r in c["ir"]["rotors"])

    feasible = {c["candidate_id"]: (-c["metrics"]["flight_time_min"], c["metrics"]["total_mass_kg"])
                for c in a["candidates"] if c["status"] == "PASSED" and not c["violations"]}
    expected = {cid for cid, (flight, mass) in feasible.items()
                if not any(f <= flight and m <= mass and (f < flight or m < mass) for f, m in feasible.values())}
    assert len({feasible[cid] for cid in expected}) >= 2
    assert set(a["pareto_ids"]) == expected
    assert [c["proposal_index"] for c in a["candidates"] if c["candidate_id"] in a["pareto_ids"]] == [
        c["proposal_index"] for c in b["candidates"] if c["candidate_id"] in b["pareto_ids"]]
