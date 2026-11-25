import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { api, type Run } from '../api';
import type { CandidateDetails, ExperimentRequest, ReplayData } from '../contracts';

const format = (v: unknown): string => typeof v === 'number' ? Number(v.toPrecision(7)).toString() : Array.isArray(v) ? v.map(format).join(', ') : String(v);
const modeName = (mode: string) => mode === 'dynamics' ? '6-DOF 动力学' : '快速演示';
function Json({ value }: { value: unknown }) { return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>; }
function Values({ values }: { values: Record<string, unknown> }) { return <dl className="parameter-grid">{Object.entries(values).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{format(value)}</dd></div>)}</dl>; }
function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="detail-dialog" onCancel={onClose} aria-label={title}><div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭详情" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}

function Configuration({ request }: { request: ExperimentRequest }) {
  return <>
    <h3>实验与测试条件</h3><Values values={{'名称': request.goal.name, '随机种子': request.seed, '评估模式': modeName(request.evaluation_mode), '优化器': request.optimizer, '场景 ID': request.scenario.scenario_id, '任务': request.scenario.mission.type, '时长 / s': request.scenario.duration_s, '积分步长 / s': request.scenario.sim_dt_s, '空气密度 / kg/m³': request.scenario.air_density_kg_m3, '风场类型': request.scenario.wind_type, '风速 NED / m/s': request.scenario.wind_velocity_m_s, '悬停高度 / m': request.scenario.mission.altitude_m, '随机化': request.scenario.domain_randomization.enabled ? `${request.scenario.domain_randomization.trials} 次，质量 ±${request.scenario.domain_randomization.mass_variance_pct}%` : '关闭'}}/>
    <h3>搜索范围</h3><div className="table-scroll"><table><thead><tr><th>参数路径</th><th>下界</th><th>上界</th></tr></thead><tbody>{request.goal.search_space.map(p => <tr key={p.param_path}><td>{p.param_path}</td><td>{p.bounds[0]}</td><td>{p.bounds[1]}</td></tr>)}</tbody></table></div>
    <h3>目标与约束</h3><div className="detail-chips">{request.goal.objectives.map(o => <span key={o.metric}>{o.metric} · {o.direction} · 权重 {o.weight}</span>)}{request.goal.constraints.map((c,i) => <span key={i}>{c.metric} {c.operator} {c.limit}</span>)}</div>
    <h3>计算预算</h3><Values values={request.goal.budget}/>
    {!!request.scenario.fault_injections.length && <><h3>故障注入</h3><Json value={request.scenario.fault_injections}/></>}
    {request.scenario.mission.type !== 'hover' && <><h3>任务参数</h3><Json value={request.scenario.mission}/></>}
  </>;
}

export function ExperimentDialog({ run, onClose }: { run: Run; onClose: () => void }) {
  return <Dialog title="实验参数" onClose={onClose}><Configuration request={run.request}/><details><summary>完整请求快照（含种子构型）</summary><Json value={run.request}/></details><p className="muted">运行配置为创建时的快照。更改参数请创建新实验，原始记录保持可追溯。</p></Dialog>;
}

function Replay({ replay }: { replay: ReplayData }) {
  const [index, setIndex] = useState(0);
  const frame = replay.frames[Math.min(index, replay.frames.length-1)];
  const xs = replay.frames.map(f => f[1]), ys = replay.frames.map(f => f[2]);
  const xmin = Math.min(...xs)-0.05, xmax = Math.max(...xs)+0.05, ymin = Math.min(...ys)-0.05, ymax = Math.max(...ys)+0.05;
  const project = (f: number[]) => [35+(f[2]-ymin)/(ymax-ymin)*390, 210-(f[1]-xmin)/(xmax-xmin)*175];
  const [x,y] = project(frame);
  return <div className="replay-view"><p className="muted">名义试验的实际积分轨迹，NED 坐标。随机化结果另见评估指标。</p><svg viewBox="0 0 460 240" role="img" aria-label="动力学轨迹俯视图"><rect x="35" y="25" width="390" height="185" fill="#f6f7fc"/><polyline points={replay.frames.map(f => project(f).join(',')).join(' ')} fill="none" stroke="#9183e7" strokeWidth="2"/><circle cx={x} cy={y} r="5" fill="#5947cb"/><text x="230" y="235" textAnchor="middle">东向 Y / m</text><text x="20" y="20">北向 X / m</text></svg><label>轨迹时间 / s：{frame[0].toFixed(3)}<input type="range" aria-label="轨迹时间" min="0" max={replay.frames.length-1} value={index} onChange={e => setIndex(+e.target.value)}/></label><Values values={{'位置 NED / m': frame.slice(1,4), '高度 / m': -frame[3], '四元数 wxyz': frame.slice(4,8)}}/></div>;
}

export function CandidateDialog({ runId, candidateId, onClose }: { runId: string; candidateId: string; onClose: () => void }) {
  const [data, setData] = useState<CandidateDetails | null>(null), [error, setError] = useState('');
  const [tab, setTab] = useState('parameters');
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await api<CandidateDetails>(`/experiments/${runId}/candidates/${candidateId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(value); setError('');
        if (['NEW', 'L1_PASSED'].includes(value.candidate.status)) timer = setTimeout(refresh, 1000);
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    };
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, [runId, candidateId]);
  const candidate = data?.candidate;
  const replay = data?.evaluations.find(e => e.result.replay)?.result.replay;
  return <Dialog title={candidate ? `候选 ${candidate.proposal_index+1} · 测试详情` : '候选测试详情'} onClose={onClose}>
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
        <a className="button secondary" href={`/api/experiments/${runId}/candidates/${candidateId}/ir`} download>下载此候选 DroneIR</a>
      </>}
      {tab === 'evaluations' && <>
        {!data.evaluations.length && <p className="muted">尚未归档评估结果，可查看下方执行尝试。</p>}
        {data.evaluations.map(e => <section className="evaluation-card" key={e.id}><h3>{e.level} · {e.result.status}</h3><p className="muted">{e.result.evaluator_version} · {e.result.fidelity} · {e.cache_hit ? '命中缓存' : `实际执行 ${e.result.execution_time_ms.toFixed(2)} ms`}</p><p>{e.result.message}</p><Values values={e.result.metrics}/>{e.result.violations.length > 0 && <div className="violations-list">{e.result.violations.map((v,i) => <p key={i}>{v.rule}：实际 {format(v.actual)}，阈值 {format(v.limit)} {v.message}</p>)}</div>}</section>)}
        <h3>执行尝试</h3><div className="table-scroll"><table><thead><tr><th>层级</th><th>状态</th><th>开始时间</th><th>耗时 / ms</th><th>诊断</th></tr></thead><tbody>{data.attempts.map(a => <tr key={a.id}><td>{a.level}</td><td>{a.status}</td><td>{new Date(a.started_at*1000).toLocaleTimeString('zh-CN')}</td><td>{a.finished_at ? ((a.finished_at-a.started_at)*1000).toFixed(2) : '执行中'}</td><td>{a.error ?? '—'}</td></tr>)}</tbody></table></div>
        {!data.attempts.length && <p className="muted">缓存命中不产生新的执行尝试。</p>}
      </>}
      {tab === 'scenario' && <Configuration request={data.request}/>}
      {tab === 'replay' && (replay?.frames.length ? <Replay replay={replay}/> : <p className="muted">此候选尚无动力学轨迹。演示模式、L1 淘汰或尚未完成 L2 时不会产生轨迹。</p>)}
      {tab === 'json' && <Json value={data}/>}
    </div>}
  </Dialog>;
}
