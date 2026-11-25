import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Shuffle, X } from 'lucide-react';
import { api, type Run, type RunSummary } from '../api';
import type { DroneIR, ExperimentRequest, PresetSpec } from '../contracts';
import { asInputNumber, BUDGET_FIELDS, BUDGET_PROFILES, buildFormRequest, dynamicsStepLimit, MAX_SEED, validateFormRequest } from '../workbench/experimentForm';
import { EVALUATION_MODE_LABELS, GLOSSARY, MISSION_LABELS, OPTIMIZER_LABELS } from '../workbench/glossary';
import { METRIC_META, type MetricKey } from '../workbench/metricMeta';
import { FaultEditor } from './FaultEditor';
import { GoalRulesEditor } from './GoalRulesEditor';
import { TermTooltip } from './TermTooltip';
import { WaypointEditor } from './WaypointEditor';

const PREFERENCES: MetricKey[] = ['flight_time_min', 'tracking_rmse_m', 'total_mass_kg', 'max_tilt_deg'];
const STEP_AXES = ['向北突跃位移 / m', '向东突跃位移 / m', '向上突跃位移 / m'] as const;
const WIND_AXES = ['向北风速 / m/s', '向东风速 / m/s', '向下风速 / m/s'] as const;
type ReferenceSource = 'baseline' | 'history' | 'studio' | 'attached';

interface Props {
  defaults: ExperimentRequest;
  baselineIr: DroneIR | null;
  presets: PresetSpec[] | null;
  presetsError: string;
  reloadPresets: () => void;
  historicalRuns: RunSummary[];
  currentRun: Run | null;
  studioDraft: DroneIR | null;
  onClose: () => void;
  onCreate: (request: ExperimentRequest) => Promise<void>;
}

function initialReference(ir: DroneIR | null, studioDraft: DroneIR | null): ReferenceSource {
  if (!ir) return 'baseline';
  return studioDraft && JSON.stringify(ir) === JSON.stringify(studioDraft) ? 'studio' : 'attached';
}

function NumberField({ label, value, onChange, min, max, step = 'any', disabled }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | 'any';
  disabled?: boolean;
}) {
  return <label>{label}<input type="number" required value={asInputNumber(value)} min={min} max={max} step={step} disabled={disabled}
    onChange={e => onChange(e.target.valueAsNumber)}/></label>;
}

function readExpertRequest(json: string, startPaused: boolean): ExperimentRequest {
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error('专家覆盖须填写有效的 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('专家覆盖须使用实验请求对象。');
  // The API validates the expert payload, including fields the form does not edit.
  const request = value as ExperimentRequest;
  if (typeof request.goal?.name === 'string') request.goal.name = request.goal.name.trim();
  return { ...request, start_paused: startPaused };
}

export function CreateDialog({ defaults, baselineIr, presets, presetsError, reloadPresets, historicalRuns, currentRun, studioDraft, onClose, onCreate }: Props) {
  const [draft, setDraft] = useState(() => structuredClone(defaults));
  const [activePreset, setActivePreset] = useState(defaults.scenario.scenario_id);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [previewPaused, setPreviewPaused] = useState(false);
  const [expert, setExpert] = useState<string | null>(null);
  const [source, setSource] = useState<ReferenceSource>(() => initialReference(defaults.seed_ir, studioDraft));
  const [attachedSeed, setAttachedSeed] = useState(defaults.seed_ir);
  const [historyId, setHistoryId] = useState('');
  const [historicalCandidate, setHistoricalCandidate] = useState('');
  const [historySnapshot, setHistorySnapshot] = useState<Run | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const headingId = useId();
  const missionId = useId();
  const referenceId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);

  useEffect(() => { dialog.current?.showModal(); }, []);
  const currentRunId = currentRun?.id;
  useEffect(() => {
    if (source !== 'history' || !historyId || currentRunId === historyId) return;
    const controller = new AbortController();
    api<Run>(`/experiments/${encodeURIComponent(historyId)}`, { signal: controller.signal })
      .then(snapshot => { if (!controller.signal.aborted) setHistorySnapshot(snapshot); })
      .catch(err => { if (!controller.signal.aborted) setHistoryError((err as Error).message); });
    return () => controller.abort();
  }, [source, historyId, currentRunId]);

  const { goal, scenario } = draft;
  const { mission, domain_randomization: randomization } = scenario;
  const waitingForReference = source === 'history' && !draft.seed_ir;
  const rotors = waitingForReference ? [] : (draft.seed_ir ?? baselineIr)?.rotors ?? [];
  const history = currentRun?.id === historyId ? currentRun : historySnapshot?.id === historyId ? historySnapshot : null;
  const preferred = history?.candidates.filter(candidate => history.pareto_ids.includes(candidate.candidate_id)) ?? [];
  const activeBudget = BUDGET_PROFILES.findIndex(item => BUDGET_FIELDS.every(({ key }) => goal.budget[key] === item.budget[key]));
  const advancedFlags = [scenario.wind_type !== 'none' && '风场', scenario.fault_injections.length > 0 && `${scenario.fault_injections.length} 条故障`,
    randomization.enabled && '鲁棒测试'].filter(Boolean);
  const previewRequest = buildFormRequest(draft, previewPaused);
  const formIssue = validateFormRequest(previewRequest, baselineIr, waitingForReference);
  let previewJson = '';
  try {
    if (expert !== null) previewJson = JSON.stringify(readExpertRequest(expert, previewPaused), null, 2);
    else if (!formIssue) previewJson = JSON.stringify(previewRequest, null, 2);
  } catch { /* The editor may contain incomplete JSON while typing. */ }

  function edit(change: (request: ExperimentRequest) => void) {
    setDraft(current => {
      const next = structuredClone(current);
      change(next);
      return next;
    });
    setError('');
  }
  function applyPreset(preset: PresetSpec) {
    setDraft(structuredClone(preset.request));
    setActivePreset(preset.id);
    setAttachedSeed(preset.request.seed_ir);
    setSource(initialReference(preset.request.seed_ir, studioDraft));
    setHistoricalCandidate('');
    setExpert(null);
    setError('');
  }
  function chooseHistory(id: string) {
    setHistoryId(id);
    setHistoricalCandidate('');
    setHistoryError('');
    edit(request => { request.seed_ir = null; });
  }
  function chooseSource(next: ReferenceSource) {
    setSource(next);
    if (next === 'history') chooseHistory(currentRun?.id ?? historicalRuns[0]?.id ?? '');
    else edit(request => { request.seed_ir = next === 'studio' ? studioDraft : next === 'attached' ? attachedSeed : null; });
  }
  function chooseHistoricalCandidate(id: string) {
    setHistoricalCandidate(id);
    const ir = preferred.find(candidate => candidate.candidate_id === id)?.ir ?? null;
    edit(request => { request.seed_ir = ir; });
  }
  function setPreference(metric: MetricKey, weight: number) {
    edit(request => {
      const objectives = request.goal.objectives;
      const objective = objectives.find(item => item.metric === metric);
      if (weight === 0) {
        if (objectives.length > 1) request.goal.objectives = objectives.filter(item => item.metric !== metric);
      } else if (objective) objective.weight = weight;
      else if (objectives.length < 5) objectives.push({ metric, direction: METRIC_META[metric].direction, weight });
    });
  }
  function reportError(message: string) {
    setError(message);
    requestAnimationFrame(() => feedback.current?.focus());
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const startPaused = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'paused';
    setError('');
    if (expert === null && formIssue) {
      if (formIssue.section !== 'basic') setAdvancedOpen(true);
      if (formIssue.section === 'search') setSearchOpen(true);
      reportError(formIssue.message);
      return;
    }
    try {
      const request = expert === null ? { ...previewRequest, start_paused: startPaused } : readExpertRequest(expert, startPaused);
      setBusy(true);
      await onCreate(request);
    } catch (err) { reportError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} aria-labelledby={headingId} className="create-dialog progressive-create" onCancel={event => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <form noValidate onSubmit={event => void submit(event)}>
      <div className="dialog-heading"><h2 id={headingId}>创建寻优实验</h2><button type="button" className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={20}/></button></div>
      <fieldset className="create-body" disabled={busy}>
        <section className="create-templates" aria-label="场景模板">
          <h3>场景模板</h3>
          <div className="create-template-strip">
            {presets?.map(preset => <button key={preset.id} type="button" className="button secondary compact" aria-pressed={activePreset === preset.id}
              onClick={() => applyPreset(preset)}>{preset.title}</button>)}
          </div>
          {presetsError ? <p className="template-status">场景模板加载失败。<button type="button" className="button secondary compact" onClick={reloadPresets}>重新加载</button></p>
            : !presets && <p className="muted" role="status">正在读取场景模板…</p>}
        </section>
        <div className="create-grid">
          <label>实验名称<input autoFocus required value={goal.name} onChange={e => edit(request => { request.goal.name = e.target.value; })}/></label>
          <label>评估模式<select aria-label="评估模式" value={draft.evaluation_mode} onChange={e => edit(request => {
            request.evaluation_mode = e.target.value as ExperimentRequest['evaluation_mode'];
            if (request.evaluation_mode === 'dynamics') request.scenario.sim_dt_s = Math.min(request.scenario.sim_dt_s, dynamicsStepLimit(request, baselineIr));
          })}><option value="dynamics">{EVALUATION_MODE_LABELS.dynamics}</option><option value="demo">{EVALUATION_MODE_LABELS.demo}</option></select></label>
          <div className="form-field"><div className="form-field-heading"><label htmlFor={referenceId}>{GLOSSARY.seed_ir.uiLabel}</label><TermTooltip term="seed_ir" showIconOnly/></div>
            <select id={referenceId} value={source} onChange={e => chooseSource(e.target.value as ReferenceSource)}>
              <option value="baseline">默认基准机型</option>
              <option value="history" disabled={!historicalRuns.length && !currentRun}>历史优选方案</option>
              {studioDraft && <option value="studio">Studio 草稿</option>}
              {attachedSeed && <option value="attached">沿用已带入的机型</option>}
            </select>
          </div>
          <label>计算预算<select aria-label="计算预算" value={activeBudget < 0 ? 'current' : String(activeBudget)} onChange={e => {
            const profile = BUDGET_PROFILES[Number(e.target.value)];
            if (profile) edit(request => { request.goal.budget = { ...profile.budget }; });
          }}>
            {activeBudget < 0 && <option value="current">沿用当前预算</option>}
            {BUDGET_PROFILES.map(({ label }, i) => <option key={label} value={i}>{label}</option>)}
          </select></label>
          {source === 'history' && <>
            <label>历史实验<select aria-label="历史实验" value={historyId} onChange={e => chooseHistory(e.target.value)}>
              {!historyId && <option value="">请选择实验</option>}
              {currentRun && !historicalRuns.some(item => item.id === currentRun.id) && <option value={currentRun.id}>{currentRun.name}</option>}
              {historicalRuns.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <label>历史优选方案<select aria-label="历史优选方案" value={historicalCandidate} disabled={!preferred.length} onChange={e => chooseHistoricalCandidate(e.target.value)}>
              <option value="">{!history ? '正在读取方案…' : preferred.length ? '请选择要使用的方案' : '该实验暂无优选方案'}</option>
              {historicalCandidate && !preferred.some(candidate => candidate.candidate_id === historicalCandidate) && <option value={historicalCandidate}>已选参考方案</option>}
              {preferred.map(candidate => <option key={candidate.candidate_id} value={candidate.candidate_id}>候选 {candidate.proposal_index + 1} · {candidate.ir_hash.slice(0, 8)}</option>)}
            </select></label>
            {historyError && <p className="form-error" role="status">读取历史方案失败。{historyError}</p>}
          </>}
        </div>

        <section className="experiment-editor task-editor" aria-label="任务设置">
          <h3>飞行任务</h3>
          <div className="create-grid">
            <div className="form-field"><div className="form-field-heading"><label htmlFor={missionId}>任务类型</label>{mission.type !== 'hover' && <TermTooltip term={mission.type} showIconOnly/>}</div>
              <select id={missionId} value={mission.type} onChange={e => edit(request => { request.scenario.mission.type = e.target.value as typeof mission.type; })}>
                {Object.entries(MISSION_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select></div>
            <NumberField label={mission.type === 'hover' ? '悬停高度 / m' : '起始高度 / m'} value={mission.altitude_m} min={0}
              onChange={value => edit(request => { request.scenario.mission.altitude_m = value; })}/>
            {mission.type === 'step_response' && <>
              {STEP_AXES.map((label, axis) => <NumberField key={label} label={label} value={mission.step_m[axis] * (axis === 2 ? -1 : 1)}
                onChange={value => edit(request => { request.scenario.mission.step_m[axis] = value * (axis === 2 ? -1 : 1); })}/>)}
              <NumberField label="突跃触发时刻 / s" value={mission.step_time_s} min={0} onChange={value => edit(request => { request.scenario.mission.step_time_s = value; })}/>
            </>}
          </div>
          {mission.type === 'waypoints' && <WaypointEditor value={mission.waypoints} duration={scenario.duration_s} altitude={mission.altitude_m}
            onChange={waypoints => edit(request => { request.scenario.mission.waypoints = waypoints; })}/>}
        </section>

        <section className="experiment-editor" aria-label="目标偏好">
          <h3>目标偏好</h3>
          <div className="create-grid weight-grid">{PREFERENCES.map(metric => {
            const objective = goal.objectives.find(item => item.metric === metric);
            const weight = objective && Number.isFinite(objective.weight) ? objective.weight : 0;
            const low = objective && goal.objectives.length === 1 ? Math.min(weight || 0.01, 0.01) : 0;
            return <label key={metric}><span>{METRIC_META[metric].label}<strong>{weight || '关闭'}</strong></span><input type="range" step="any" min={low} max={Math.max(5, weight)}
              aria-label={`${METRIC_META[metric].label}偏好权重`} disabled={!objective && goal.objectives.length >= 5} value={weight}
              onChange={e => setPreference(metric, Math.max(low, Number(e.target.valueAsNumber.toFixed(2))))}/></label>;
          })}</div>
        </section>

        <details className="create-advanced" open={advancedOpen} onToggle={e => setAdvancedOpen(e.currentTarget.open)}>
          <summary>高级物理与算法配置 {advancedFlags.length > 0 && <span className="create-summary-flags">{advancedFlags.map(flag => <span className="count" key={String(flag)}>{flag}</span>)}</span>}</summary>
          <div className="create-advanced-body">
            <section className="experiment-editor" aria-label="仿真环境">
              <h3>仿真环境</h3>
              <div className="create-grid">
                <label>风场<select aria-label="风场" value={scenario.wind_type} onChange={e => edit(request => { request.scenario.wind_type = e.target.value as typeof scenario.wind_type; })}>
                  <option value="none">无风</option><option value="constant">恒定风</option><option value="gust">阵风</option></select></label>
                {WIND_AXES.map((label, axis) => <NumberField key={label} label={label} value={scenario.wind_velocity_m_s[axis]} disabled={scenario.wind_type === 'none'}
                  onChange={value => edit(request => { request.scenario.wind_velocity_m_s[axis] = value; })}/>)}
                {scenario.wind_type === 'gust' && <>
                  <NumberField label="阵风开始 / s" value={scenario.gust_start_s} min={0} onChange={value => edit(request => { request.scenario.gust_start_s = value; })}/>
                  <NumberField label="阵风持续 / s" value={scenario.gust_duration_s} min={0} onChange={value => edit(request => { request.scenario.gust_duration_s = value; })}/>
                </>}
                <NumberField label="测试时长 / s" value={scenario.duration_s} min={0} max={600} onChange={value => edit(request => { request.scenario.duration_s = value; })}/>
                <NumberField label="仿真步长 / s" value={scenario.sim_dt_s} min={0} onChange={value => edit(request => { request.scenario.sim_dt_s = value; })}/>
                <NumberField label="空气密度 / kg/m³" value={scenario.air_density_kg_m3} min={0} onChange={value => edit(request => { request.scenario.air_density_kg_m3 = value; })}/>
              </div>
            </section>
            <FaultEditor value={scenario.fault_injections} rotors={rotors} duration={scenario.duration_s}
              onChange={faults => edit(request => { request.scenario.fault_injections = faults; })}/>
            <section className="experiment-editor" aria-label="制造误差配置">
              <div className="form-field-heading"><label className="checkbox-label"><input type="checkbox" checked={randomization.enabled}
                onChange={e => edit(request => { request.scenario.domain_randomization.enabled = e.target.checked; })}/>{GLOSSARY.domain_rand.uiLabel}</label><TermTooltip term="domain_rand" showIconOnly/></div>
              {randomization.enabled && <>
                <div className="create-grid">
                  <NumberField label="随机试验次数" value={randomization.trials} min={1} max={20} step={1} onChange={value => edit(request => { request.scenario.domain_randomization.trials = value; })}/>
                  <NumberField label="重量波动 / %" value={randomization.mass_variance_pct} min={0} max={50} onChange={value => edit(request => { request.scenario.domain_randomization.mass_variance_pct = value; })}/>
                  <NumberField label="单桨推力波动 / %" value={randomization.thrust_variance_pct} min={0} onChange={value => edit(request => { request.scenario.domain_randomization.thrust_variance_pct = value; })}/>
                  <NumberField label="三轴质心偏移 / m" value={randomization.cg_offset_variance_m} min={0} onChange={value => edit(request => { request.scenario.domain_randomization.cg_offset_variance_m = value; })}/>
                </div>
                {Number.isInteger(randomization.trials) && randomization.trials > 0 && <p className="muted">每个候选增加随机试验 ×{randomization.trials}。计入 1 次基准试飞，总计 ×{randomization.trials + 1} 次模拟。</p>}
              </>}
            </section>
            <GoalRulesEditor goal={goal} onChange={patch => edit(request => Object.assign(request.goal, patch))} searchOpen={searchOpen} onSearchToggle={setSearchOpen}/>
            <section className="experiment-editor" aria-label="搜索算法与预算">
              <h3>搜索算法与预算</h3>
              <div className="create-grid">
                <label>寻优算法<select aria-label="寻优算法" value={draft.optimizer} onChange={e => edit(request => { request.optimizer = e.target.value as ExperimentRequest['optimizer']; })}>
                  <option value="evolution">{OPTIMIZER_LABELS.evolution}</option>
                  <option value="nsga2">{OPTIMIZER_LABELS.nsga2}</option>
                  <option value="random">{OPTIMIZER_LABELS.random}</option></select></label>
                <div className="seed-controls">
                  <NumberField label="随机种子" value={draft.seed} min={0} max={MAX_SEED} step={1} onChange={value => edit(request => { request.seed = value; })}/>
                  <button type="button" className="button secondary compact" onClick={() => {
                    const seed = crypto.getRandomValues(new Uint32Array(1))[0] & MAX_SEED;
                    edit(request => { request.seed = seed; });
                  }}><Shuffle size={15}/>随机生成</button>
                </div>
                {BUDGET_FIELDS.map(({ key, label, min, max }) => <NumberField key={key} label={label} value={goal.budget[key]} min={min} max={max} step={1}
                  onChange={value => edit(request => { request.goal.budget[key] = value; })}/>)}
              </div>
            </section>
          </div>
        </details>

        <details className="create-json">
          <summary>JSON 负载预览 / 专家覆盖 {expert !== null && <span className="count">覆盖已启用</span>}</summary>
          <label>预览启动方式<select aria-label="预览启动方式" value={previewPaused ? 'paused' : 'run'} onChange={e => setPreviewPaused(e.target.value === 'paused')}>
            <option value="run">创建并运行</option><option value="paused">创建后暂不启动</option></select></label>
          {previewJson ? <pre tabIndex={0} aria-label="只读 JSON 负载预览" className="json-view">{previewJson}</pre>
            : <p className="muted">修正表单或专家覆盖后即可查看可提交负载。</p>}
          <label className="checkbox-label"><input type="checkbox" checked={expert !== null} onChange={e => {
            setExpert(e.target.checked ? JSON.stringify(previewRequest, null, 2) : null);
            setError('');
          }}/>使用专家覆盖</label>
          {expert !== null && <label>专家 JSON 负载<textarea aria-label="专家 JSON 负载" rows={9} value={expert} onChange={e => setExpert(e.target.value)}/></label>}
        </details>
      </fieldset>
      <div className="create-footer">
        {error && <p className="form-error" tabIndex={-1} ref={feedback} role="alert">{error}</p>}
        <div className="create-footer-controls"><span>{expert !== null ? '提交时采用专家覆盖' : `最多 ${Number.isFinite(goal.budget.max_generations * goal.budget.batch_size) ? goal.budget.max_generations * goal.budget.batch_size : '—'} 个候选`}</span>
          <div className="experiment-editor-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button>
            <button type="submit" value="paused" className="button secondary" disabled={busy}>创建后暂不启动</button>
            <button type="submit" value="run" className="button primary" disabled={busy}>{busy ? '创建中…' : '创建并运行'}</button></div>
        </div>
      </div>
    </form>
  </dialog>;
}
