import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { api, ApiError, type Run } from '../api';
import type { AttemptRecord, CandidateDetails, EvalResult, EvaluationRecord, ExperimentRequest, ReplayData } from '../contracts';
import { formatViolationValues, violationLabel } from '../workbench/analytics';
import { EVALUATION_MODE_LABELS, GLOSSARY, MISSION_LABELS, OPTIMIZER_LABELS, evaluationLevelLabel } from '../workbench/glossary';
import { formatMetric, isMetricKey, METRIC_META } from '../workbench/metricMeta';
import { TermTooltip } from './TermTooltip';

function format(value: unknown): string {
  if (typeof value === 'number' && !Number.isInteger(value)) return String(Number(value.toPrecision(7)));
  if (Array.isArray(value)) return value.map(format).join(', ');
  return String(value);
}
const SUPPLEMENTAL_METRIC_LABELS: Record<string, string> = {
  cg_offset_m: '水平质心偏移 / m', hover_throttle: '悬停时的最大油门比例', peak_power_w: '峰值耗电功率 / W',
  discharge_margin: '放电功率余量（倍）', min_rotor_clearance_m: '最小桨盘间距 / m', allocation_cond: '推力分配条件数',
  rotor_count: '旋翼数量', mean_power_w: '平均耗电功率 / W', energy_wh: '总耗电量 / Wh', max_rotor_util: '最高单桨推力比例',
};
function Json({ value }: { value: unknown }) { return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>; }
function Values({ values }: { values: Record<string, unknown> }) {
  return <dl className="parameter-grid">{Object.entries(values).map(([key, value]) => {
    const worst = key.endsWith('_worst');
    const metric = worst ? key.slice(0, -'_worst'.length) : key;
    if (isMetricKey(metric)) return <div key={key}><dt>{METRIC_META[metric].label}{worst && '（最差一轮）'}</dt>
      <dd>{typeof value === 'number' ? formatMetric(metric, value) : format(value)}</dd></div>;
    const label = Object.hasOwn(SUPPLEMENTAL_METRIC_LABELS, key) ? SUPPLEMENTAL_METRIC_LABELS[key] : key;
    return <div key={key}><dt>{label}</dt><dd>{format(value)}</dd></div>;
  })}</dl>;
}
function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="detail-dialog" onCancel={onClose} aria-label={title}><div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭详情" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}

function Configuration({ request }: { request: ExperimentRequest }) {
  return <>
    <h3>实验与测试条件</h3><Values values={{'名称': request.goal.name, '随机种子': request.seed, '评估模式': EVALUATION_MODE_LABELS[request.evaluation_mode], '搜索算法': OPTIMIZER_LABELS[request.optimizer], '场景 ID': request.scenario.scenario_id, '任务': MISSION_LABELS[request.scenario.mission.type], '时长 / s': request.scenario.duration_s, '积分步长 / s': request.scenario.sim_dt_s, '空气密度 / kg/m³': request.scenario.air_density_kg_m3, '风场类型': request.scenario.wind_type, '风速 NED / m/s': request.scenario.wind_velocity_m_s, '悬停高度 / m': request.scenario.mission.altitude_m, [GLOSSARY.domain_rand.uiLabel]: request.scenario.domain_randomization.enabled ? `${request.scenario.domain_randomization.trials} 次，质量 ±${request.scenario.domain_randomization.mass_variance_pct}%` : '关闭'}}/>
    <h3>搜索范围</h3><div className="table-scroll"><table><thead><tr><th>参数路径</th><th>下界</th><th>上界</th></tr></thead><tbody>{request.goal.search_space.map(p => <tr key={p.param_path}><td>{p.param_path}</td><td>{p.bounds[0]}</td><td>{p.bounds[1]}</td></tr>)}</tbody></table></div>
    <h3>目标与约束</h3><div className="detail-chips">{request.goal.objectives.map(o => <span key={o.metric}>{METRIC_META[o.metric].label} · {o.direction === 'maximize' ? '越大越好' : '越小越好'} · 权重 {o.weight}</span>)}{request.goal.constraints.map((c,i) => <span key={i}>{METRIC_META[c.metric].label} {c.operator} {formatMetric(c.metric, c.limit)}</span>)}</div>
    <h3>计算预算</h3><Values values={{ '搜索代数': request.goal.budget.max_generations, '每代候选数': request.goal.budget.batch_size,
      '第 1 关计算次数': request.goal.budget.max_l1_evals, '第 2 关计算次数': request.goal.budget.max_l2_evals,
      '总运行时限 / s': request.goal.budget.timeout_sec }}/>
    {!!request.scenario.fault_injections.length && <><h3><TermTooltip term="fault_injection"/></h3><Json value={request.scenario.fault_injections}/></>}
    {request.scenario.mission.type !== 'hover' && <><h3>任务参数</h3><Json value={request.scenario.mission}/></>}
  </>;
}

export function ExperimentDialog({ run, onClose }: { run: Run; onClose: () => void }) {
  return <Dialog title="实验参数" onClose={onClose}><Configuration request={run.request}/><details><summary>完整请求快照（含{GLOSSARY.seed_ir.uiLabel}）</summary><Json value={run.request}/></details><p className="muted">运行配置为创建时的快照。更改参数请创建新实验，原始记录保持可追溯。</p></Dialog>;
}

function Replay({ replay }: { replay: ReplayData }) {
  const [index, setIndex] = useState(0);
  const frame = replay.frames[Math.min(index, replay.frames.length-1)];
  const xs = replay.frames.map(f => f[1]), ys = replay.frames.map(f => f[2]);
  const xmin = Math.min(...xs)-0.05, xmax = Math.max(...xs)+0.05, ymin = Math.min(...ys)-0.05, ymax = Math.max(...ys)+0.05;
  const project = (f: number[]) => [35+(f[2]-ymin)/(ymax-ymin)*390, 210-(f[1]-xmin)/(xmax-xmin)*175];
  const [x,y] = project(frame);
  return <div className="replay-view"><p className="muted">名义试验的实际积分轨迹，使用<TermTooltip term="ned_frame"/>。制造误差测试结果见评估指标。</p><svg viewBox="0 0 460 240" role="img" aria-label="动力学轨迹俯视图"><rect x="35" y="25" width="390" height="185" fill="#f6f7fc"/><polyline points={replay.frames.map(f => project(f).join(',')).join(' ')} fill="none" stroke="#9183e7" strokeWidth="2"/><circle cx={x} cy={y} r="5" fill="#5947cb"/><text x="230" y="235" textAnchor="middle">东向 Y / m</text><text x="20" y="20">北向 X / m</text></svg><label>轨迹时间 / s：{frame[0].toFixed(3)}<input type="range" aria-label="轨迹时间" min="0" max={replay.frames.length-1} value={index} onChange={e => setIndex(+e.target.value)}/></label><Values values={{'位置 NED / m': frame.slice(1,4), '高度 / m': -frame[3], '四元数 wxyz': frame.slice(4,8)}}/></div>;
}

const FIDELITY_LABELS: Record<EvalResult['fidelity'], string> = {
  ANALYTIC: '静态物理解析', DEMO: '快速演示', DYNAMICS: '三维动力学模拟',
};
const RESULT_LABELS: Record<EvalResult['status'], string> = {
  PASSED: '通过', REJECTED_CONSTRAINT: '约束淘汰', CRASHED: '执行失败', TIMEOUT: '超时', UNSUPPORTED: '构型不支持',
};
const ATTEMPT_LABELS: Record<string, string> = {
  RUNNING: '执行中', COMPLETED: '执行完成', FAILED: '执行失败', INTERRUPTED: '执行中断',
};
const RESOLVED_LABELS: Record<string, string> = {
  nominal_mass_kg: '标称整机重量 / kg', cg_x_m: '前向质心偏移 / m', cg_y_m: '右向质心偏移 / m', cg_z_m: '下向质心偏移 / m',
  pos_kp: '位置比例增益', pos_kd: '位置微分增益', pos_ki: '位置积分增益', att_kp: '姿态比例增益',
  rate_kp: '角速度比例增益', rate_kr: '角速度增益缩放系数',
};
const attemptClock = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const formatMilliseconds = (value: number) => `${value.toFixed(2)} ms`;

function AttemptTimeline({ attempts, mode, hasCachedResult }: {
  attempts: AttemptRecord[];
  mode: ExperimentRequest['evaluation_mode'];
  hasCachedResult: boolean;
}) {
  const timeline = [...attempts].sort((a, b) => a.started_at - b.started_at);
  return <section className="attempt-section" aria-labelledby="attempt-heading">
    <h3 id="attempt-heading">执行尝试</h3>
    {timeline.length ? <ol className="attempt-timeline">{timeline.map(attempt => {
      const end = attempt.finished_at;
      const status = Object.hasOwn(ATTEMPT_LABELS, attempt.status) ? ATTEMPT_LABELS[attempt.status] : '状态未知';
      return <li key={attempt.id} data-status={attempt.status}>
        <div className="attempt-title"><strong>{evaluationLevelLabel(attempt.level, mode)}</strong><span className="badge">{status}</span></div>
        <dl className="evaluation-facts">
          <div><dt>开始时间</dt><dd><time>{attemptClock.format(attempt.started_at * 1000)}</time></dd></div>
          <div><dt>结束时间</dt><dd>{end == null ? '尚未结束' : <time>{attemptClock.format(end * 1000)}</time>}</dd></div>
          <div><dt>执行耗时</dt><dd>{end == null ? '计时中' : formatMilliseconds(Math.max(0, (end - attempt.started_at) * 1000))}</dd></div>
        </dl>
        {attempt.error && <p className={attempt.status === 'COMPLETED' ? 'attempt-note' : 'attempt-error'}>
          <strong>{attempt.status === 'COMPLETED' ? '说明' : '错误'}</strong> {attempt.error === 'worker restarted' ? '后台计算进程已重启' : attempt.error}
        </p>}
      </li>;
    })}</ol> : <p className="muted">{hasCachedResult ? '已复用历史结果，未产生新的执行尝试。' : '暂无执行尝试。'}</p>}
  </section>;
}

function EvaluationCard({ record, mode }: { record: EvaluationRecord; mode: ExperimentRequest['evaluation_mode'] }) {
  const { result, cache_hit } = record;
  const level = evaluationLevelLabel(record.level, mode);
  const parameters = Object.entries(result.resolved_parameters);
  return <section className="evaluation-card" aria-label={level}>
    <div className="evaluation-card-heading"><h4>{level}</h4>
      <span className={`badge ${result.status.toLowerCase()}`}>{RESULT_LABELS[result.status]}</span>
      <span className={`badge ${cache_hit ? 'evaluation-cached' : ''}`}>{cache_hit ? GLOSSARY.cache_hits.uiLabel : '本次计算'}</span>
    </div>
    <dl className="evaluation-facts">
      <div><dt>仿真精度</dt><dd>{FIDELITY_LABELS[result.fidelity]}</dd></div>
      <div><dt>{cache_hit ? '原始评估耗时' : '评估耗时'}</dt><dd>{formatMilliseconds(result.execution_time_ms)}</dd></div>
      <div><dt>目标适应度评分</dt><dd>{result.fitness_score == null ? '未评分' : format(result.fitness_score)}</dd></div>
    </dl>
    {result.message && <p className="muted">{result.message}</p>}
    {Object.keys(result.metrics).length > 0 && <Values values={result.metrics}/>}
    {result.violations.length > 0 && <div className="violations-list">{result.violations.map((violation, index) => <p key={index}>
      <strong>{violationLabel(violation.rule)}</strong> · {formatViolationValues(violation)} {violation.message}
    </p>)}</div>}
    <h5>运行时解析参数</h5>
    {parameters.length ? <div className="table-scroll"><table className="resolved-parameter-table" aria-label={`${level}运行时解析参数`}>
      <thead><tr><th scope="col">参数</th><th scope="col">采用值</th></tr></thead>
      <tbody>{parameters.map(([key, value]) => {
        const inertia = /^inertia_([xyz]{2})_kg_m2$/.exec(key);
        const name = inertia ? `惯量 ${inertia[1].toUpperCase()} / kg·m²` : Object.hasOwn(RESOLVED_LABELS, key) ? RESOLVED_LABELS[key] : key;
        return <tr key={key}><td title={key}>{name}</td><td>{format(value)}</td></tr>;
      })}</tbody>
    </table></div> : <p className="muted">本次评估没有记录运行时解析参数。</p>}
  </section>;
}

export function CandidateDialog({ runId, candidateId, onClose, onStudio, onReplay }: { runId: string; candidateId: string; onClose: () => void; onStudio?: () => void; onReplay?: () => void }) {
  const [data, setData] = useState<CandidateDetails | null>(null), [error, setError] = useState('');
  const [tab, setTab] = useState('parameters');
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await api<CandidateDetails>(`/experiments/${runId}/candidates/${candidateId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(value); setError('');
        if (!['NEW', 'L1_PASSED'].includes(value.candidate.status) && !value.attempts.some(attempt => attempt.status === 'RUNNING')) return;
      } catch (e) {
        if (controller.signal.aborted) return;
        setError((e as Error).message);
        if (e instanceof ApiError && e.status === 404) return;
      }
      timer = setTimeout(refresh, 1000);
    };
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [runId, candidateId]);
  const candidate = data?.candidate;
  const replay = data?.evaluations.find(e => e.result.replay)?.result.replay;
  return <Dialog title={candidate ? `候选 ${candidate.proposal_index+1} · 测试详情` : '候选测试详情'} onClose={onClose}>
    {candidate && onStudio && <div className="detail-quick-actions"><button className="button primary" onClick={onStudio}>在 3D 视图中查看并修订</button><a className="button secondary" href={`/api/experiments/${runId}/candidates/${candidateId}/ir`} download>导出机型配置</a><TermTooltip term="drone_ir" showIconOnly/>{candidate.source === 'manual_revision' && <span className="subtle">◆ <TermTooltip term="manual_revision"/> · 父方案 {candidate.parent_ir_hash?.slice(0, 12)}</span>}</div>}
    <div className="detail-tabs" role="tablist" aria-label="测试详情分类">{[['parameters','构型参数'],['evaluations','评估记录'],['scenario','测试条件'],['replay','轨迹'],['json','原始 JSON']].map(([key,label]) => <button role="tab" aria-selected={tab===key} key={key} onClick={() => setTab(key)}>{label}</button>)}</div>
    {error && <p role="alert" className="form-error">{error}</p>}{!data && !error && <p className="muted">正在读取测试记录…</p>}
    {data && candidate && <div className="detail-body">
      {tab === 'parameters' && <>
        <p className="hash-line">设计哈希 {candidate.ir_hash}</p>
        <h3>机体参数</h3><Values values={{'机身质量 / kg': candidate.ir.airframe.base_mass_kg, '机身质心 / m': candidate.ir.airframe.cg_offset_m, '机身惯量对角 / kg·m²': candidate.ir.airframe.inertia_diag_kg_m2, '线性阻力系数': candidate.ir.airframe.linear_drag_coeff}}/>
        <h3>电池与载荷</h3><Values values={{'电池容量 / Wh': candidate.ir.power.capacity_wh, '电池质量 / kg': candidate.ir.power.battery_mass_kg, '最大放电功率 / W': candidate.ir.power.max_discharge_w, '载荷质量 / kg': candidate.ir.payload.mass_kg, '载荷位置 / m': candidate.ir.payload.position_m}}/>
        <h3>旋翼参数（FRD，前 / 右 / 下）</h3><div className="table-scroll"><table><thead><tr><th>ID</th><th>位置 / m</th><th>推力轴</th><th>转向</th><th>最大推力 / N</th><th>桨半径 / m</th><th>电机 τ / s</th><th>扭推比 / m</th></tr></thead><tbody>{candidate.ir.rotors.map(r => <tr key={r.id}><td>{r.id}</td><td>{format(r.position_m)}</td><td>{format(r.thrust_axis)}</td><td>{r.spin_direction}</td><td>{format(r.max_thrust_n)}</td><td>{format(r.prop_radius_m)}</td><td>{format(r.motor_time_constant_s)}</td><td>{format(r.torque_to_thrust_ratio)}</td></tr>)}</tbody></table></div>
        <h3>控制器</h3><Values values={{'类型': candidate.ir.controller.type, '自动缩放增益': candidate.ir.controller.auto_scale_gains ? '开启' : '关闭'}}/><Json value={candidate.ir.controller.params}/>
        {data.evaluations.some(e => Object.keys(e.result.resolved_parameters).length > 0) && <><h3>运行时解析参数（含合成惯量和实际增益）</h3><Values values={data.evaluations.at(-1)?.result.resolved_parameters ?? {}}/></>}
        <h3>最终指标</h3><Values values={candidate.metrics}/>
        <a className="button secondary" href={`/api/experiments/${runId}/candidates/${candidateId}/ir`} download>下载此候选的机型配置</a>
      </>}
      {tab === 'evaluations' && <>
        <AttemptTimeline attempts={data.attempts} mode={data.request.evaluation_mode} hasCachedResult={data.evaluations.some(record => record.cache_hit)}/>
        <h3>评估结果</h3>
        {!data.evaluations.length && <p className="muted">尚未归档评估结果。</p>}
        {data.evaluations.map(record => <EvaluationCard key={record.id} record={record} mode={data.request.evaluation_mode}/>)}
      </>}
      {tab === 'scenario' && <Configuration request={data.request}/>}
      {tab === 'replay' && (replay?.frames.length ? <>
        {onReplay && <button className="button secondary" onClick={onReplay}>在 3D 工作台回放</button>}
        <Replay replay={replay}/>
      </> : <p className="muted">此候选尚无动力学轨迹。通过第 2 关三维飞行模拟后可查看轨迹。</p>)}
      {tab === 'json' && <Json value={data}/>}
    </div>}
  </Dialog>;
}
