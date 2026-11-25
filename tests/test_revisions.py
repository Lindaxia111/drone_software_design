import json
import sqlite3

from fastapi.testclient import TestClient
import pytest

from drone_lab.api import create_app
from drone_lab.domain import ExperimentRequest, RevisionRequest
from drone_lab.orchestration import Engine
from drone_lab.storage import Store


def finish(engine):
    for _ in range(200):
        if not engine.tick():
            return
    pytest.fail('experiment did not finish')


def setup(tmp_path, **fields):
    store = Store(tmp_path/'revisions.sqlite3')
    request = ExperimentRequest.model_validate({'goal': {'budget': {'max_generations': 2, 'batch_size': 3}}, **fields})
    run_id = store.create(request)['id']
    engine = Engine(store)
    finish(engine)
    parent = next(c for c in store.detail(run_id)['candidates'] if c['status'] == 'PASSED')
    return store, engine, run_id, parent


def revision(parent, **power):
    from drone_lab.domain import DroneIR
    data = parent['ir'].copy()
    data['power'] = {**data['power'], **power}
    return RevisionRequest(parent_ir_hash=parent['ir_hash'], drone_ir=DroneIR.model_validate(data))


def test_revision_is_immutable_and_runs_after_completion(tmp_path):
    store, engine, run_id, parent = setup(tmp_path)
    before = store.detail(run_id)
    new = store.enqueue_revision(run_id, revision(parent, capacity_wh=73, battery_mass_kg=73/180))
    assert new['source'] == 'manual_revision' and new['parent_ir_hash'] == parent['ir_hash']
    assert new['proposal_index'] == 6 and new['status'] == 'NEW'
    finish(engine)
    after = store.detail(run_id)
    assert after['status'] == 'COMPLETED' and after['request'] == before['request']
    assert after['candidates'][:6] == before['candidates']
    assert after['next_index'] == before['next_index'] == 6
    assert after['candidates'][-1]['status'] == 'PASSED'
    details = store.candidate_details(run_id, new['candidate_id'])
    assert details['evaluations'][-1]['result']['fitness_score'] is not None
    with store.transaction() as db:
        cached = db.execute('SELECT result FROM cache WHERE key=?', (details['evaluations'][-1]['cache_key'],)).fetchone()
        assert json.loads(cached['result'])['fitness_score'] is None


def test_revision_and_active_optimizer_have_unique_indices(tmp_path):
    store, _, run_id, parent = setup(tmp_path)
    request = ExperimentRequest.model_validate({'goal': {'budget': {'max_generations': 2, 'batch_size': 3}}})
    active_id = store.create(request)['id']
    engine = Engine(store)
    engine.tick()
    active_parent = store.detail(active_id)['candidates'][0]
    store.enqueue_revision(active_id, revision(active_parent, capacity_wh=74, battery_mass_kg=74/180))
    finish(engine)
    result = store.detail(active_id)
    indices = [c['proposal_index'] for c in result['candidates']]
    assert indices == list(range(7))
    assert len([c for c in result['candidates'] if c['source'] == 'optimizer']) == 6
    assert [c['ir_hash'] for c in result['candidates'] if c['source'] == 'optimizer'] == [c['ir_hash'] for c in store.detail(run_id)['candidates']]


def test_revision_budget_exhaustion_does_not_change_parent_lifecycle(tmp_path):
    store, engine, run_id, parent = setup(tmp_path)
    with store.transaction() as db:
        db.execute('UPDATE runs SET l1_used=100 WHERE id=?', (run_id,))
    store.enqueue_revision(run_id, revision(parent, capacity_wh=77, battery_mass_kg=77/180))
    finish(engine)
    run = store.detail(run_id)
    assert run['status'] == 'COMPLETED' and run['l1_used'] == 100
    assert run['candidates'][-1]['status'] == 'SKIPPED'
    assert run['candidates'][parent['proposal_index']]['ir'] == parent['ir']


def test_paused_revision_runs_without_resuming_optimizer(tmp_path):
    store, engine, run_id, parent = setup(tmp_path)
    with store.transaction() as db:
        store.set_status(db, run_id, 'PAUSED')
    new = store.enqueue_revision(run_id, revision(parent, capacity_wh=79, battery_mass_kg=79/180))
    engine.tick()
    engine = Engine(Store(store.path))
    engine.recover()
    finish(engine)
    assert store.detail(run_id)['status'] == 'PAUSED'
    assert store.candidate_details(run_id, new['candidate_id'])['candidate']['status'] == 'PASSED'


def test_revision_api_checks_parent_scope_and_dynamics_compatibility(tmp_path):
    store, _, run_id, parent = setup(tmp_path, evaluation_mode='dynamics', scenario={'duration_s':1,'sim_dt_s':.005})
    with TestClient(create_app(store.path)) as client:
        body = revision(parent, capacity_wh=78, battery_mass_kg=78/180).model_dump(mode='json')
        assert client.post(f'/api/experiments/{run_id}/candidates/evaluate', json=body).status_code == 202
        body['parent_ir_hash'] = '0'*64
        assert client.post(f'/api/experiments/{run_id}/candidates/evaluate', json=body).status_code == 404
        body['parent_ir_hash'] = parent['ir_hash']
        body['drone_ir']['rotors'][0]['thrust_axis'] = [1,0,0]
        assert client.post(f'/api/experiments/{run_id}/candidates/evaluate', json=body).status_code == 409
        with store.transaction() as db:
            store.set_status(db,run_id,'CANCELLED')
        body['drone_ir']['rotors'][0]['thrust_axis'] = [0,0,-1]
        assert client.post(f'/api/experiments/{run_id}/candidates/evaluate', json=body).status_code == 409


def test_existing_database_schema_upgrades_without_losing_candidates(tmp_path):
    path = tmp_path/'old.sqlite3'
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE candidates(id TEXT PRIMARY KEY,run_id TEXT,proposal_index INTEGER,generation INTEGER,ir_hash TEXT,ir TEXT,status TEXT,metrics TEXT DEFAULT '{}',violations TEXT DEFAULT '[]')")
        db.execute("INSERT INTO candidates(id,run_id,proposal_index,generation,ir_hash,ir,status) VALUES('legacy','old-run',0,1,'hash','{}','PASSED')")
    store = Store(path)
    with store.transaction() as db:
        row = db.execute("SELECT * FROM candidates WHERE id='legacy'").fetchone()
        assert row['source'] == 'optimizer' and row['parent_ir_hash'] is None
        assert row['ir_hash'] == 'hash' and row['status'] == 'PASSED'
