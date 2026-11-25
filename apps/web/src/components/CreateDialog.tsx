import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ExperimentRequest } from '../api';

interface Props {
  defaults: ExperimentRequest;
  onClose: () => void;
  onCreate: (request: ExperimentRequest) => Promise<void>;
}

export function CreateDialog({ defaults, onClose, onCreate }: Props) {
  const [draft, setDraft] = useState(() => structuredClone(defaults));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const edit = (change: (value: ExperimentRequest) => void) => setDraft(value => {
    const next = structuredClone(value); change(next); return next;
  });
  const constraint = (metric: 'total_mass_kg' | 'thrust_to_weight_ratio', value: number) => edit(d => {
    d.goal.constraints = [...d.goal.constraints.filter(c => c.metric !== metric),
      { metric, operator: metric === 'total_mass_kg' ? '<=' : '>=', limit: value }];
  });
  const fault = draft.scenario.fault_injections[0];
  return <dialog ref={dialog} onCancel={onClose} className="create-dialog">
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        const request: ExperimentRequest = advanced.trim() ? JSON.parse(advanced) : structuredClone(draft);
        request.goal.name = request.goal.name.trim();
        request.start_paused = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'paused';
        await onCreate(request);
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>
      <div className="dialog-heading"><div><span className="eyebrow">NEW EXPERIMENT</span><h2>创建寻优实验</h2></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={20}/></button></div>
      <p className="muted">配置构型搜索与测试场景。运行后可以暂停，也可先创建、检查参数后再启动。</p>
      <fieldset disabled={busy}>
        <label>实验名称<input autoFocus required maxLength={100} value={draft.goal.name} onChange={e => edit(d => { d.goal.name = e.target.value; })}/></label>
        <div className="form-grid">
          <label>评估模式<select value={draft.evaluation_mode} onChange={e => edit(d => { d.evaluation_mode = e.target.value as ExperimentRequest['evaluation_mode']; if (d.evaluation_mode === 'dynamics') d.scenario.sim_dt_s = Math.min(0.005, d.scenario.sim_dt_s); })}><option value="dynamics">6-DOF 动力学</option><option value="demo">快速演示</option></select></label>
          <label>寻优算法<select value={draft.optimizer} onChange={e => edit(d => { d.optimizer = e.target.value as ExperimentRequest['optimizer']; })}><option value="evolution">进化搜索（μ+λ）</option><option value="random">随机搜索</option></select></label>
          <label>最大总质量 / kg<input type="number" min="0.1" step="0.05" required value={draft.goal.constraints.find(c => c.metric === 'total_mass_kg')?.limit ?? 1.5} onChange={e => constraint('total_mass_kg', +e.target.value)}/></label>
          <label>最小推重比<input type="number" min="1" step="0.1" required value={draft.goal.constraints.find(c => c.metric === 'thrust_to_weight_ratio')?.limit ?? 2} onChange={e => constraint('thrust_to_weight_ratio', +e.target.value)}/></label>
          <label>搜索代数<input type="number" min="1" max="100" required value={draft.goal.budget.max_generations} onChange={e => edit(d => { d.goal.budget.max_generations = +e.target.value; })}/></label>
          <label>每代候选数<input type="number" min="1" max="100" required value={draft.goal.budget.batch_size} onChange={e => edit(d => { d.goal.budget.batch_size = +e.target.value; })}/></label>
          <label>L1 执行预算<input type="number" min="1" max="100000" required value={draft.goal.budget.max_l1_evals} onChange={e => edit(d => { d.goal.budget.max_l1_evals = +e.target.value; })}/></label>
          <label>L2 执行预算<input type="number" min="0" max="100000" required value={draft.goal.budget.max_l2_evals} onChange={e => edit(d => { d.goal.budget.max_l2_evals = +e.target.value; })}/></label>
          <label>随机种子<input type="number" min="0" max="2147483647" required value={draft.seed} onChange={e => edit(d => { d.seed = +e.target.value; })}/></label>
          <label>总运行时限 / s<input type="number" min="1" max="86400" required value={draft.goal.budget.timeout_sec} onChange={e => edit(d => { d.goal.budget.timeout_sec = +e.target.value; })}/></label>
        </div>
        <details className="form-details" open><summary>测试场景</summary><div className="form-grid">
          <label>任务类型<select value={draft.scenario.mission.type} onChange={e => edit(d => { d.scenario.mission.type = e.target.value as 'hover' | 'step_response'; })}><option value="hover">悬停</option><option value="step_response">阶跃响应</option></select></label>
          <label>测试时长 / s<input type="number" min="0.1" max="600" step="0.1" required value={draft.scenario.duration_s} onChange={e => edit(d => { d.scenario.duration_s = +e.target.value; })}/></label>
          <label>积分步长 / s<input type="number" min="0.001" max={draft.evaluation_mode === 'dynamics' ? '0.01' : '1'} step="0.001" required value={draft.scenario.sim_dt_s} onChange={e => edit(d => { d.scenario.sim_dt_s = +e.target.value; })}/></label>
          <label>悬停高度 / m<input type="number" min="0.1" step="0.1" required value={draft.scenario.mission.altitude_m} onChange={e => edit(d => { d.scenario.mission.altitude_m = +e.target.value; })}/></label>
          <label>风场<select value={draft.scenario.wind_type} onChange={e => edit(d => { d.scenario.wind_type = e.target.value as 'none' | 'constant' | 'gust'; })}><option value="none">无风</option><option value="constant">恒定风</option><option value="gust">阵风</option></select></label>
          <label>前向风速 / m/s<input type="number" step="0.1" required value={draft.scenario.wind_velocity_m_s[0]} onChange={e => edit(d => { d.scenario.wind_velocity_m_s[0] = +e.target.value; })}/></label>
          {draft.scenario.mission.type === 'step_response' && <label>阶跃距离 / m<input type="number" step="0.1" value={draft.scenario.mission.step_m[0]} onChange={e => edit(d => { d.scenario.mission.step_m[0] = +e.target.value; })}/></label>}
        </div>
          <label className="checkbox-label"><input type="checkbox" checked={draft.scenario.domain_randomization.enabled} onChange={e => edit(d => { d.scenario.domain_randomization.enabled = e.target.checked; })}/>开启质量随机化压测</label>
          {draft.scenario.domain_randomization.enabled && <div className="form-grid"><label>随机试验次数<input type="number" min="1" max="20" value={draft.scenario.domain_randomization.trials} onChange={e => edit(d => { d.scenario.domain_randomization.trials = +e.target.value; })}/></label><label>质量扰动 / %<input type="number" min="0" max="50" value={draft.scenario.domain_randomization.mass_variance_pct} onChange={e => edit(d => { d.scenario.domain_randomization.mass_variance_pct = +e.target.value; })}/></label></div>}
          <label className="checkbox-label"><input type="checkbox" checked={!!fault} onChange={e => edit(d => { d.scenario.fault_injections = e.target.checked ? [{trigger_time_s: Math.min(3, d.scenario.duration_s/2), target_rotor_id: d.seed_ir?.rotors[0].id ?? 'r1', fault_type: 'motor_out', severity: 1}] : []; })}/>注入单旋翼失效</label>
          {fault && <div className="form-grid"><label>故障旋翼 ID<input value={fault.target_rotor_id} onChange={e => edit(d => { d.scenario.fault_injections[0].target_rotor_id = e.target.value; })}/></label><label>触发时间 / s<input type="number" min="0" step="0.1" value={fault.trigger_time_s} onChange={e => edit(d => { d.scenario.fault_injections[0].trigger_time_s = +e.target.value; })}/></label></div>}
        </details>
        <details className="form-details"><summary>搜索参数范围</summary>{draft.goal.search_space.map((p, i) => <div className="search-input" key={p.param_path}><span>{p.param_path}</span><input aria-label={`${p.param_path} 下界`} type="number" min="0.0001" step="any" value={p.bounds[0]} onChange={e => edit(d => { d.goal.search_space[i].bounds[0] = +e.target.value; })}/><span>至</span><input aria-label={`${p.param_path} 上界`} type="number" min="0.0001" step="any" value={p.bounds[1]} onChange={e => edit(d => { d.goal.search_space[i].bounds[1] = +e.target.value; })}/></div>)}</details>
        <details className="form-details"><summary>完整配置 JSON（可选覆盖）</summary><p className="muted">可配置种子机型、航点、额外搜索参数和多个故障。填写后以 JSON 为准，提交时仍由后端校验。</p><button type="button" className="button secondary compact" onClick={() => setAdvanced(JSON.stringify(draft, null, 2))}>载入当前配置</button><textarea aria-label="完整实验配置 JSON" rows={12} value={advanced} onChange={e => setAdvanced(e.target.value)} placeholder="留空使用上方表单"/></details>
      </fieldset>
      <div className="config-note">最多 {draft.goal.budget.max_generations*draft.goal.budget.batch_size} 个候选 · L3 未接入 · 缓存命中不消耗执行预算</div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="submit" value="paused" className="button secondary" disabled={busy}>创建后暂不启动</button><button type="submit" value="run" className="button primary" disabled={busy}>{busy ? '创建中…' : '创建并运行'}</button></div>
    </form>
  </dialog>;
}
