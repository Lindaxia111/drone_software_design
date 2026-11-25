import subprocess
import sys
import time

from fastapi.testclient import TestClient
import pytest

from drone_lab.api import create_app
from drone_lab.domain import DesignGoal, DroneIR, ExperimentRequest, TestScenario as Scenario, baseline_ir
from drone_lab.evaluators import AnalyticEvaluator, DemoEvaluator, cache_key, pareto_indices
from drone_lab.optimizers import RandomOptimizer
from drone_lab.orchestration import Engine
from drone_lab.storage import Store
from drone_lab.worker import worker_lock


@pytest.fixture
def lab(tmp_path):
    store = Store(tmp_path/'lab.sqlite3')
    engine = Engine(store)
    request = ExperimentRequest.model_validate({"goal": {"budget": {"max_generations": 2, "batch_size": 5}}})
    return store, engine, request


def finish(engine, limit=500):
    for _ in range(limit):
        if not engine.tick():
            return
    pytest.fail("experiment did not terminate")


def test_complete_reproducible_experiment_and_cache(lab):
    store, engine, request = lab
    first = store.create(request)
    finish(engine)
    a = store.detail(first['id'])
    assert a['status'] == 'COMPLETED' and a['stop_reason'] == 'SEARCH_EXHAUSTED'
    assert len(a['candidates']) == 10 and a['passed'] > 0
    assert a['pareto_ids']
    second = store.create(request)
    finish(Engine(Store(store.path)))
    b = store.detail(second['id'])
    assert b['l1_used'] == b['l2_used'] == 0
    assert b['cache_hits'] == a['l1_used']+a['l2_used']
    assert [(c['ir_hash'],c['metrics'],c['status']) for c in a['candidates']] == [(c['ir_hash'],c['metrics'],c['status']) for c in b['candidates']]
    report = store.report(first['id'])
    assert report['verification_level'] == 'DEMO' and report['evaluations']


def test_pause_resume_without_duplicate_candidates(lab):
    store, engine, request = lab
    run_id = store.create(request)['id']
    engine.tick()
    paused = store.transition(run_id,'pause')
    assert paused['status'] == 'PAUSED' and not engine.tick()
    store.transition(run_id,'resume')
    finish(Engine(Store(store.path)))
    result = store.detail(run_id)
    assert len({c['proposal_index'] for c in result['candidates']}) == 10
    with store.transaction() as db:
        assert db.execute('SELECT COUNT(*) FROM evaluations').fetchone()[0] == result['l1_used']+result['l2_used']


@pytest.mark.parametrize('level', ['L1','L2'])
def test_budget_is_reserved_before_execution(lab,level):
    store, engine, request = lab
    setattr(request.goal.budget, f'max_{level.lower()}_evals', 1)
    run_id = store.create(request)['id']
    finish(engine)
    result = store.detail(run_id)
    assert result[f'{level.lower()}_used'] == 1
    assert result['stop_reason'] == f'{level}_BUDGET'


def test_interrupted_attempt_recovery_uses_remaining_budget(lab):
    store, engine, request = lab
    run_id = store.create(request)['id']
    engine.tick()  # Leaves a durable L1-passed candidate, before L2 execution.
    candidate = store.detail(run_id)['candidates'][0]
    with store.transaction() as db:
        db.execute("INSERT INTO attempts(id,run_id,candidate_id,level,status,started_at) VALUES('interrupted',?,?, 'L2','RUNNING',0)", (run_id,candidate['candidate_id']))
        db.execute('UPDATE runs SET l2_used=l2_used+1 WHERE id=?',(run_id,))
    restarted = Engine(Store(store.path))
    restarted.recover()
    finish(restarted)
    report = store.report(run_id)
    assert report['attempts'][0]['status'] in {'COMPLETED','INTERRUPTED'}
    assert next(a for a in report['attempts'] if a['id']=='interrupted')['status']=='INTERRUPTED'
    assert len(report['experiment']['candidates'])==10
    assert report['experiment']['l2_used'] == len([e for e in report['evaluations'] if e['level']=='L2'])+1


def test_cache_rechecks_new_goal_constraints(lab):
    store,engine,request=lab
    store.create(request)
    finish(engine)
    request.goal.constraints[0].limit=0.1
    changed=store.create(request)
    finish(engine)
    result=store.detail(changed['id'])
    assert result['passed']==0 and result['rejected']==10
    assert result['l1_used']==0 and result['cache_hits']==10


def test_failure_does_not_pollute_cache(lab):
    store,engine,request=lab
    class Broken:
        level='L1'
        version='broken/1'
        def evaluate(self,*args):
            raise RuntimeError('injected worker failure')
    engine.evaluators['L1']=Broken()
    run_id=store.create(request)['id']
    finish(engine)
    report=store.report(run_id)
    assert all(c['status']=='CRASHED' for c in report['experiment']['candidates'])
    with store.transaction() as db:
        assert db.execute('SELECT COUNT(*) FROM cache').fetchone()[0]==0
    assert all(a['status']=='FAILED' for a in report['attempts'])


def test_timeout_and_cancel(lab):
    store,engine,request=lab
    run_id=store.create(request)['id']
    engine.tick()
    with store.transaction() as db:
        db.execute('UPDATE runs SET resumed_at=resumed_at-1000 WHERE id=?',(run_id,))
    engine.tick()
    assert store.detail(run_id)['stop_reason']=='TIME_BUDGET'
    run_id=store.create(request)['id']
    store.transition(run_id,'cancel')
    assert not engine.tick()
    with pytest.raises(ValueError):
        store.transition(run_id,'resume')


def test_cache_identity_and_content_hash():
    ir=baseline_ir()
    assert DroneIR.model_validate_json(ir.model_dump_json()).ir_hash==ir.ir_hash
    scenario=Scenario()
    base=cache_key(ir,scenario,AnalyticEvaluator(),42)
    assert base!=cache_key(ir,scenario,AnalyticEvaluator(),43)
    assert base!=cache_key(ir,scenario,DemoEvaluator(),42)
    scenario.wind_velocity_m_s=(2,0,0)
    assert base!=cache_key(ir,scenario,AnalyticEvaluator(),42)


def test_physical_model_basics():
    ir=baseline_ir()
    result=AnalyticEvaluator().evaluate(ir,Scenario(),42)
    assert result.status=='PASSED'
    assert result.metrics['total_mass_kg']==pytest.approx(1.15)
    assert result.metrics['thrust_to_weight_ratio']==pytest.approx(32/(1.15*9.80665))
    ir.rotors[1].position_m=ir.rotors[0].position_m
    result=AnalyticEvaluator().evaluate(ir,Scenario(),42)
    assert any(v.rule=='rotor_clearance_m' for v in result.violations)
    request=ExperimentRequest.model_validate({'goal':{'search_space':[{'param_path':'power.capacity_wh','bounds':[90,90]}]}})
    candidate=RandomOptimizer().suggest(request,0)
    assert candidate.power.battery_mass_kg==0.5


def test_pareto_uses_all_objectives():
    def c(i,time,error,status='PASSED'):
        return {'candidate_id':i,'status':status,'metrics':{'flight_time_min':time,'tracking_rmse_m':error}}
    assert set(pareto_indices([c('a',10,.1),c('b',9,.2),c('c',8,.05),c('d',50,.01,'REJECTED_CONSTRAINT')],DesignGoal().objectives))=={'a','c'}


def test_api_validation_exports_and_state_conflicts(tmp_path):
    with TestClient(create_app(tmp_path/'api.sqlite3')) as client:
        assert client.get('/api/health').status_code==200
        assert client.get('/api/experiments/missing').status_code==404
        assert client.post('/api/experiments',json={'seed':-1}).status_code==422
        assert client.post('/api/experiments',json={'goal':{'budget':{'max_l3_evals':1}}}).status_code==422
        assert client.post('/api/experiments',json={'goal':{'search_space':[{'param_path':'bogus','bounds':[1,2]}]}}).status_code==422
        created=client.post('/api/experiments',json={})
        assert created.status_code==201
        run_id=created.json()['id']
        assert client.post(f'/api/experiments/{run_id}/pause').status_code==200
        assert client.post(f'/api/experiments/{run_id}/pause').status_code==409
        assert client.post(f'/api/experiments/{run_id}/resume').status_code==200
        response=client.get(f'/api/experiments/{run_id}/report')
        assert response.status_code==200 and 'attachment' in response.headers['content-disposition']
        assert response.json()['verification_level']=='PENDING'


def test_worker_exclusive_lock(tmp_path):
    with worker_lock(tmp_path/'worker.lock'):
        with pytest.raises(RuntimeError):
            with worker_lock(tmp_path/'worker.lock'):
                pass


def test_real_worker_process_restart_preserves_checkpoint(lab):
    store, _, request = lab
    run_id = store.create(request)['id']
    command = [sys.executable, '-m', 'drone_lab.worker', '--db', str(store.path), '--interval', '0.05']
    processes = []
    def start():
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(process)
        return process
    def wait_until(predicate, process):
        deadline = time.monotonic()+15
        while time.monotonic()<deadline:
            result = store.detail(run_id)
            if predicate(result):
                return result
            assert process.poll() is None, 'Worker exited unexpectedly'
            time.sleep(0.02)
        pytest.fail('Worker did not reach checkpoint')
    try:
        first = start()
        checkpoint = wait_until(lambda r:r['next_index']>=3, first)
        first.kill()
        first.wait(timeout=5)
        second = start()
        completed = wait_until(lambda r:r['status']=='COMPLETED', second)
        assert len(completed['candidates']) == 10
        assert [(c['candidate_id'],c['ir_hash']) for c in checkpoint['candidates']] == [(c['candidate_id'],c['ir_hash']) for c in completed['candidates'][:len(checkpoint['candidates'])]]
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=5)
