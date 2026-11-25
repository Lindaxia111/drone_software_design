import json

from fastapi.testclient import TestClient
import numpy as np
import pytest

from drone_lab.api import create_app
from drone_lab.core_adapter import CoreL1Evaluator, DynamicsEvaluator, to_core_ir
from drone_lab.domain import ExperimentRequest, TestScenario as Scenario, baseline_ir
from drone_lab.orchestration import Engine
from drone_lab.storage import Store


def request(**overrides):
    return ExperimentRequest.model_validate({
        'evaluation_mode': 'dynamics', 'optimizer': 'evolution',
        'scenario': {'duration_s': 2, 'sim_dt_s': 0.005},
        'goal': {'budget': {'max_generations': 2, 'batch_size': 3}}, **overrides,
    })


def finish(engine):
    for _ in range(100):
        if not engine.tick():
            return
    pytest.fail('Engine did not finish')


def test_core_l1_rejects_rank_and_compensates_offset():
    evaluator = CoreL1Evaluator()
    ir = baseline_ir()
    ir.payload.position_m = (0.04, 0, 0)
    result = evaluator.evaluate(ir, Scenario(), 42)
    assert result.status == 'PASSED' and result.metrics['cg_offset_m'] > 0
    for rotor in ir.rotors:
        rotor.position_m = (rotor.position_m[0], 0, 0)
    assert any(v.rule == 'controllability_rank' for v in evaluator.evaluate(ir, Scenario(), 42).violations)


def test_dynamics_is_reproducible_and_replay_time_is_correct():
    ir = baseline_ir()
    sc = Scenario(duration_s=2, sim_dt_s=0.005, domain_randomization={'enabled': True, 'trials': 2})
    evaluator = DynamicsEvaluator()
    a, b = evaluator.evaluate(ir, sc, 42), evaluator.evaluate(ir, sc, 42)
    assert a.status == 'PASSED' and a.fidelity == 'DYNAMICS'
    assert a.resolved_parameters['pos_kp'] > 0
    assert a.resolved_parameters['nominal_mass_kg'] == pytest.approx(1.15)
    assert a.metrics == b.metrics
    assert a.replay.frames == b.replay.frames
    assert a.metrics['tracking_rmse_m_worst'] >= a.metrics['tracking_rmse_m']
    times = [f[0] for f in a.replay.frames]
    assert times[0] == 0 and times[-1] <= sc.duration_s
    assert all(t1 < t2 for t1, t2 in zip(times, times[1:]))


def test_randomized_failure_cannot_pass_nominal_trial(monkeypatch):
    from dronedesign.evaluators import l2
    original = l2.simulate
    def simulated(*args, **kwargs):
        output = original(*args, **kwargs)
        if kwargs.get('mass_scale', 1) != 1:
            output.crashed = True
            output.t_crash = 0.5
        return output
    monkeypatch.setattr(l2, 'simulate', simulated)
    sc = Scenario(duration_s=1, sim_dt_s=.005, domain_randomization={'enabled': True, 'trials': 1})
    assert DynamicsEvaluator().evaluate(baseline_ir(), sc, 42).status == 'CRASHED'


def test_generation_reconstruction_and_cache(tmp_path):
    store = Store(tmp_path/'evolution.sqlite3')
    req = request()
    first = store.create(req)['id']
    # Restart the engine in the middle of generation 2.
    engine = Engine(store)
    while store.detail(first)['next_index'] < 5:
        assert engine.tick()
    finish(Engine(Store(store.path)))
    a = store.detail(first)
    second = store.create(req)['id']
    finish(Engine(store))
    b = store.detail(second)
    assert a['status'] == b['status'] == 'COMPLETED'
    assert len(a['candidates']) == len(b['candidates']) == 6
    assert [c['ir_hash'] for c in a['candidates']] == [c['ir_hash'] for c in b['candidates']]
    assert b['l1_used'] == b['l2_used'] == 0
    assert store.report(first)['verification_level'] == 'DYNAMICS'


def test_candidate_details_paused_start_retry_and_ownership(tmp_path):
    app = create_app(tmp_path/'details.sqlite3')
    with TestClient(app) as client:
        default = client.get('/api/defaults').json()['request']
        assert default['evaluation_mode'] == 'dynamics'
        req = request(start_paused=True)
        created = client.post('/api/experiments', json=req.model_dump(mode='json'))
        assert created.status_code == 201
        run_id = created.json()['id']
        engine = Engine(app.state.store)
        assert not engine.tick()
        assert client.get(f'/api/experiments/{run_id}').json()['status'] == 'PAUSED'
        client.post(f'/api/experiments/{run_id}/resume')
        finish(engine)
        run = client.get(f'/api/experiments/{run_id}').json()
        candidate = next(c for c in run['candidates'] if c['status'] == 'PASSED')
        detail_url = f'/api/experiments/{run_id}/candidates/{candidate["candidate_id"]}'
        detail = client.get(detail_url)
        assert detail.status_code == 200
        payload = detail.json()
        assert payload['candidate']['ir'] == candidate['ir']
        assert payload['request']['scenario']['sim_dt_s'] == .005
        assert [e['level'] for e in payload['evaluations']] == ['L1','L2']
        assert payload['evaluations'][1]['result']['replay']['frames']
        assert len(payload['attempts']) == 2
        clone = client.post(f'/api/experiments/{run_id}/retry').json()
        assert clone['id'] != run_id and clone['status'] == 'QUEUED'
        assert clone['request']['seed'] == run['request']['seed']
        assert client.get(f'/api/experiments/{clone["id"]}/candidates/{candidate["candidate_id"]}').status_code == 404
        assert client.get(f'/api/experiments/{run_id}').json()['status'] == 'COMPLETED'


def test_dynamics_validation_and_old_snapshot_compatibility(tmp_path):
    with TestClient(create_app(tmp_path/'validate.sqlite3')) as client:
        body = request().model_dump(mode='json')
        body['scenario']['sim_dt_s'] = .1
        assert client.post('/api/experiments', json=body).status_code == 422
        legacy = ExperimentRequest.model_validate({'seed':42})
        assert legacy.evaluation_mode == 'demo' and legacy.optimizer == 'random'


def test_pause_during_inflight_evaluation_does_not_dispatch_more(tmp_path):
    store = Store(tmp_path/'pause.sqlite3')
    req = ExperimentRequest()
    run_id = store.create(req)['id']
    engine = Engine(store)
    original = engine.evaluators['L1']
    class PausingEvaluator:
        level = 'L1'
        version = original.version
        def evaluate(self, *args):
            store.transition(run_id, 'pause')
            return original.evaluate(*args)
    engine.evaluators['L1'] = PausingEvaluator()
    assert engine.tick()
    assert not engine.tick()
    run = store.detail(run_id)
    assert run['status'] == 'PAUSED' and run['next_index'] == 1 and run['l1_used'] == 1
