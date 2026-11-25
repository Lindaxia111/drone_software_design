import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import json
import sqlite3
from threading import Barrier, Event, current_thread
import time

from fastapi.testclient import TestClient
import pytest

from drone_lab import api
from drone_lab.core_adapter import CoreL1Evaluator
from drone_lab.domain import DesignGoal, ExperimentRequest, PresetSpec, TestScenario as Scenario, baseline_ir
from drone_lab.orchestration import Engine
from drone_lab.storage import Store
from drone_lab.worker import worker_heartbeat


@pytest.fixture
def lab(tmp_path):
    app = api.create_app(tmp_path / "b0.sqlite3")
    with TestClient(app) as client:
        yield app.state.store, client


def test_presets_are_valid_create_requests(lab):
    _, client = lab
    response = client.get("/api/presets")
    assert response.status_code == 200
    presets = {item["id"]: PresetSpec.model_validate(item) for item in response.json()}
    assert set(presets) == {"wind_hover_starter", "step_agility", "waypoint_patrol", "rotor_fault_tolerance"}
    hover = presets["wind_hover_starter"].request
    assert hover.scenario.mission.type == "hover" and hover.scenario.wind_type == "constant"
    assert hover.evaluation_mode == "dynamics" and hover.goal.budget.max_l2_evals <= 4
    step = presets["step_agility"].request.scenario.mission
    assert step.type == "step_response" and all(step.step_m) and step.step_time_s > 0
    patrol = presets["waypoint_patrol"].request.scenario.mission
    assert patrol.type == "waypoints" and len(patrol.waypoints) == 4
    assert patrol.waypoints[0].position_m == patrol.waypoints[-1].position_m
    assert all(a.t_s < b.t_s for a, b in zip(patrol.waypoints, patrol.waypoints[1:]))
    assert len(presets["rotor_fault_tolerance"].request.scenario.fault_injections) == 1
    for preset in presets.values():
        created = client.post("/api/experiments", json=preset.request.model_dump(mode="json"))
        assert created.status_code == 201
        assert created.json()["request"] == preset.request.model_dump(mode="json")


def test_experiment_pagination_and_rename(lab):
    store, client = lab
    run_ids = [store.create(ExperimentRequest(start_paused=i % 2 == 0))["id"] for i in range(5)]
    page = client.get("/api/experiments", params={"status": "PAUSED", "offset": 1, "limit": 1})
    assert [item["id"] for item in page.json()] == [run_ids[2]]
    assert len(client.get("/api/experiments?status=").json()) == 5
    assert client.get("/api/experiments?offset=-1").status_code == 422
    url = f"/api/experiments/{run_ids[0]}"
    renamed = client.patch(url, json={"name": "  新实验名  "})
    assert renamed.status_code == 200 and renamed.json()["name"] == "新实验名"
    run = client.get(url).json()
    assert run["name"] == run["request"]["goal"]["name"] == "新实验名"
    assert run["status"] == "PAUSED"
    assert client.patch(url, json={"name": "  "}).status_code == 422
    assert client.patch("/api/experiments/missing", json={"name": "有效名称"}).status_code == 404


def test_delete_cascades_and_inflight_result_is_discarded(lab):
    store, client = lab
    sibling = store.create(ExperimentRequest(start_paused=True))["id"]
    run_id = store.create(ExperimentRequest(goal=DesignGoal(search_space=[])))["id"]
    url = f"/api/experiments/{run_id}"
    assert client.delete(url).status_code == 409  # QUEUED
    engine = Engine(store)
    assert engine.tick()  # Commit the first candidate's L1 evaluation.
    assert client.delete(url).status_code == 409  # RUNNING
    original = engine.evaluators["L2"]
    delete_responses = []

    class DeleteDuringEvaluation:
        level = original.level
        version = original.version

        def evaluate(self, *args):
            delete_responses.append(client.delete(url, params={"force": True}))
            return original.evaluate(*args)

    engine.evaluators["L2"] = DeleteDuringEvaluation()
    assert engine.tick()
    deleted, = delete_responses
    assert deleted.status_code == 204 and not deleted.content
    assert client.get(url).status_code == client.delete(url).status_code == 404
    with store.transaction() as db:
        for table in ("evaluations", "attempts", "candidates"):
            assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM cache").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM events WHERE run_id=?", (run_id,)).fetchone()[0] == 0
    assert client.delete(f"/api/experiments/{sibling}").status_code == 204


def test_legacy_cache_migration_and_pragmas(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE cache(key TEXT PRIMARY KEY, result TEXT NOT NULL)")
        db.execute("INSERT INTO cache VALUES('legacy', '{}')")
    store = Store(path)
    with store.transaction() as db:
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert db.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
        assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        original = tuple(db.execute("SELECT * FROM cache WHERE key='legacy'").fetchone())
    assert original[1] == "{}" and original[2] > 0
    with Store(path).transaction() as db:
        assert tuple(db.execute("SELECT * FROM cache WHERE key='legacy'").fetchone()) == original


def test_concurrent_store_initialization_on_fresh_database(tmp_path):
    path = tmp_path / "fresh.sqlite3"
    start = Barrier(4, timeout=5)

    def initialize(_):
        start.wait()
        return Store(path).list_runs()

    with ThreadPoolExecutor(4) as executor:
        assert list(executor.map(initialize, range(4))) == [[], [], [], []]


def test_cache_hit_updates_lru_and_prune_counts_are_atomic(lab):
    store, client = lab
    engine = Engine(store)
    request = ExperimentRequest(goal=DesignGoal(search_space=[]))
    run_id = store.create(request)["id"]
    engine.tick()
    key = store.report(run_id)["evaluations"][0]["cache_key"]
    store.transition(run_id, "cancel")
    now = time.time()
    with store.transaction() as db:
        db.execute("UPDATE cache SET last_used_at=? WHERE key=?", (now - 100, key))
        db.executemany("INSERT INTO cache VALUES(?, '{}', ?)", [("recent", now - 10), ("expired", now - 31 * 86400)])
    repeated = store.create(request)["id"]
    engine.tick()
    assert store.detail(repeated)["cache_hits"] == 1
    response = client.post("/api/cache/prune", json={"max_entries": 10, "max_age_days": 30})
    assert response.status_code == 200 and response.json() == {"deleted": 1, "remaining": 2}
    assert store.prune_cache(max_entries=1) == 1
    with store.transaction() as db:
        row = db.execute("SELECT key,last_used_at FROM cache").fetchone()
        assert row["key"] == key and row["last_used_at"] >= now
    assert client.post("/api/cache/prune", json={"max_entries": 0}).json() == {"deleted": 1, "remaining": 0}
    assert client.post("/api/cache/prune", json={"max_entries": -1}).status_code == 422


def test_heartbeat_tracks_candidate_refreshes_while_busy_and_cleans_up(lab):
    store, client = lab
    empty = client.get("/api/health").json()
    assert {key: empty[key] for key in ("status", "stage", "verification_level", "version")} == {
        "status": "ok", "stage": 2, "verification_level": "DYNAMICS", "version": "0.3.0",
    }
    assert not empty["worker_alive"] and empty["worker_last_heartbeat"] is None
    run_id = store.create(ExperimentRequest(goal=DesignGoal(search_space=[])))["id"]
    refresh_row = partial(store.upsert_heartbeat, worker_id="local-test", pid=123)
    periodic, evaluating, release = Event(), Event(), Event()

    def refresh(db):
        refresh_row(db)
        if current_thread().name == "worker-heartbeat":
            periodic.set()

    engine = Engine(store, heartbeat=refresh)
    original = engine.evaluators["L1"]

    class BlockingEvaluator:
        level = original.level
        version = original.version

        def evaluate(self, *args):
            evaluating.set()
            release.wait(8)
            return original.evaluate(*args)

    engine.evaluators["L1"] = BlockingEvaluator()
    with worker_heartbeat(store, "local-test", refresh), ThreadPoolExecutor(1) as executor:
        assert client.get("/api/health").json()["worker_status"] == "idle"
        result = executor.submit(engine.tick)
        try:
            assert evaluating.wait(2)
            busy = client.get("/api/health").json()
            candidate_id = store.detail(run_id)["candidates"][0]["candidate_id"]
            assert busy["worker_alive"] and busy["worker_status"] == "busy"
            assert (busy["active_run_id"], busy["active_candidate_id"]) == (run_id, candidate_id)
            with store.transaction() as db:
                db.execute("UPDATE worker_heartbeat SET updated_at=?", (time.time() - 11,))
            stale = client.get("/api/health").json()
            assert not stale["worker_alive"] and stale["active_candidate_id"] is None
            assert periodic.wait(5)
            with store.transaction() as db:  # Wait for the periodic write to commit.
                current = db.execute("SELECT updated_at FROM worker_heartbeat").fetchone()[0]
            assert current > busy["worker_last_heartbeat"]
            assert client.get("/api/health").json()["worker_alive"]
        finally:
            release.set()
        assert result.result(timeout=2)
        idle = client.get("/api/health").json()
        assert idle["worker_status"] == "idle" and idle["active_run_id"] is None
    assert client.get("/api/health").json() == empty


def test_l1_quick_check_matches_core_uses_goal_and_has_no_side_effects(lab):
    store, client = lab
    aircraft, scenario = baseline_ir(), Scenario()
    body = {"drone_ir": aircraft.model_dump(mode="json"), "goal": DesignGoal().model_dump(mode="json"),
            "scenario": scenario.model_dump(mode="json")}
    expected = CoreL1Evaluator().evaluate(aircraft, scenario, 0)
    response = client.post("/api/evaluate/l1", json=body)
    assert response.status_code == 200
    valid = response.json()
    assert valid["evaluator_level"] == "L1" and valid["status"] == "PASSED"
    assert valid["metrics"] == expected.metrics and valid["resolved_parameters"] == expected.resolved_parameters
    body["goal"]["constraints"][1]["limit"] = 10
    constrained = client.post("/api/evaluate/l1", json=body).json()
    assert constrained["status"] == "REJECTED_CONSTRAINT"
    assert "thrust_to_weight_ratio" in {v["rule"] for v in constrained["violations"]}
    body["drone_ir"]["rotors"][1]["position_m"] = body["drone_ir"]["rotors"][0]["position_m"]
    overlapping = client.post("/api/evaluate/l1", json=body).json()
    assert "rotor_overlap" in {v["rule"] for v in overlapping["violations"]}
    assert client.post("/api/evaluate/l1", json={"goal": {}}).status_code == 422
    with store.transaction() as db:
        for table in ("runs", "attempts", "evaluations", "cache"):
            assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def test_sse_resumes_after_cursor_drains_batches_and_closes(lab):
    store, client = lab
    run_id = store.create(ExperimentRequest())["id"]
    with store.transaction() as db:
        for i in range(110):
            store.event(db, run_id, "TEST", str(i))
        store.set_status(db, run_id, "COMPLETED")
    first = store.list_events_after(run_id, 0, limit=2)
    expected = store.list_events_after(run_id, first[-1]["seq"], limit=1000)
    url = f"/api/experiments/{run_id}/stream"
    with client.stream("GET", url, params={"after_seq": first[0]["seq"]},
                       headers={"Last-Event-ID": str(first[-1]["seq"])}) as response:
        assert response.headers["content-type"].startswith("text/event-stream")
        lines = list(response.iter_lines())
    assert lines[0] == "event: update"
    assert len(expected) == lines.count("event: event") == 109
    assert [int(line[4:]) for line in lines if line.startswith("id: ")] == [event["seq"] for event in expected]
    assert lines[-3] == "event: done"
    assert json.loads(lines[-2][6:])["status"] == "COMPLETED"
    assert client.get(url, params={"after_seq": -1}).status_code == 422
    assert client.get("/api/experiments/missing/stream").status_code == 404


def test_sse_pings_when_elapsed_is_only_change_and_pushes_new_state(lab, monkeypatch):
    store, _ = lab
    run_id = store.create(ExperimentRequest())["id"]
    with store.transaction() as db:
        store.set_status(db, run_id, "RUNNING")
    monkeypatch.setattr(api, "SSE_POLL_SEC", 0.001)
    monkeypatch.setattr(api, "SSE_PING_SEC", 0.005)

    async def consume():
        after = store.list_events_after(run_id, 0)[-1]["seq"]
        initial = store.stream_snapshot(run_id, after, api.SSE_BATCH_SIZE)
        events = api._stream_run(store, run_id, after, initial)
        try:
            assert (await anext(events)).startswith("event: update\n")
            assert await anext(events) == ": ping\n\n"
            store.rename_run(run_id, "由事件流推送的新名称")
            assert "由事件流推送的新名称" in await anext(events)
            store.transition(run_id, "cancel")
            assert (await anext(events)).startswith("event: update\n")
            assert "event: event\n" in await anext(events)
            assert (await anext(events)).startswith("event: done\n")
            with pytest.raises(StopAsyncIteration):
                await anext(events)
        finally:
            await events.aclose()

    asyncio.run(asyncio.wait_for(consume(), timeout=2))
