import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Box, Download, Maximize2, RotateCcw, Save, X } from 'lucide-react';
import { api, type Candidate, type Run } from '../api';
import type { CandidateDetails, DroneIR, EvalResult, L1CheckRequest } from '../contracts';
import { TermTooltip } from '../components/TermTooltip';
import { useWorkbenchStore } from './state';
import { armLength, downloadIR, inspectIR } from './geometry';
import { GLOSSARY } from './glossary';
import { formatMetric, METRIC_META } from './metricMeta';
import { formatViolationValues, violationLabel } from './analytics';
import { ReplayBar } from './ReplayBar';

const Viewer = lazy(() => import('./Drone3DViewer'));
const value = (n: number, digits = 3) => Number.isFinite(n) ? n.toFixed(digits) : '—';
const partName = (part: string | null) => part?.startsWith('rotor:') ? `旋翼 ${part.slice(6)}` : ({ airframe: '机身', power: '电池', payload: '任务载荷', controller: '控制器' }[part ?? ''] ?? '点击部件查看参数');

export function ViewerTools({ compact = false, replay = false }: { compact?: boolean; replay?: boolean }) {
  const { state, patch } = useWorkbenchStore();
  return <div className={`viewer-tools ${compact ? 'compact-viewer-tools' : ''}`}>
    <div className="view-presets">{[['iso', '等轴测'], ['top', replay ? '轨迹俯视' : '俯视 FRD'], ['side', '侧视']].map(([key, title]) => <button key={key} aria-pressed={state.camera === key} onClick={() => patch({ camera: key as typeof state.camera })}>{title}</button>)}<button title="重置视角" aria-label={compact ? '预览重置视角' : '重置视角'} onClick={() => patch({ camera: 'iso', cameraReset: state.cameraReset + 1 })}><RotateCcw size={14}/></button></div>
    {!replay && <div className="explode-tools"><label>拆解 <strong>{Math.round(state.explode * 100)}%</strong><input type="range" aria-label={compact ? '预览拆解比例' : '拆解比例'} min="0" max="1" step="0.01" value={state.explode} onChange={e => patch({ explode: +e.target.value })}/></label><button onClick={() => patch({ explode: state.explode > 0.5 ? 0 : 1 })}>{state.explode > 0.5 ? '装配态' : '拆解态'}</button><button aria-pressed={state.spinning} onClick={() => patch({ spinning: !state.spinning })}>{state.spinning ? '停止桨叶' : '桨叶旋转'}</button></div>}
  </div>;
}

export function CandidatePreview({ candidate }: { candidate: Candidate | undefined }) {
  const { state, modelCamera, patch, select } = useWorkbenchStore();
  const onPart = useCallback((part: string) => patch({ activePart: part, activeStage: 'studio', studioMode: 'edit' }), [patch]);
  if (!candidate) return <section className="panel candidate-panel" id="candidate-studio"><div className="panel-heading"><h3>候选构型 3D</h3><span className="subtle">机型预览</span></div><div className="studio-empty"><Box size={32}/><p>评估生成候选后，在这里旋转、拆解并修订构型。</p></div></section>;
  const draft = state.selected?.candidate_id === candidate.candidate_id && state.dirty ? state.draft : null;
  const ir = draft ?? candidate.ir;
  const live = inspectIR(ir);
  const open = () => { if (select(candidate)) patch({ activeStage: 'studio', studioMode: 'edit' }); };
  return <section className="panel candidate-panel" id="candidate-studio" data-selected-candidate={candidate.candidate_id}>
    <div className="panel-heading"><h3>候选构型 3D <span className="model-badge">{state.dirty ? '修订草稿' : `候选 ${candidate.proposal_index + 1}`}</span></h3><button className="icon-button" aria-label="展开 3D 工作台" onClick={open}><Maximize2 size={17}/></button></div>
    <ViewerTools compact/>
    <div className="preview-3d-layout">
      <Suspense fallback={<div className="viewer-loading">加载 3D 构型…</div>}><Viewer ir={ir} modelKey={candidate.candidate_id} explode={state.explode} spinning={state.spinning} activePart={state.activePart} camera={state.camera} reset={state.cameraReset} modelCamera={modelCamera} onPart={onPart}/></Suspense>
      <div className="preview-summary"><strong>候选 {String(candidate.proposal_index + 1).padStart(3, '0')}</strong><span className="subtle">{candidate.source === 'manual_revision' ? `◆ ${GLOSSARY.manual_revision.uiLabel}` : '算法生成'} · {candidate.ir_hash.slice(0, 10)}</span><dl><dt>{METRIC_META.total_mass_kg.label}</dt><dd>{formatMetric('total_mass_kg', live.mass)}</dd><dt>电池容量</dt><dd>{value(ir.power.capacity_wh, 1)} Wh</dd><dt>动力余量</dt><dd>{formatMetric('thrust_to_weight_ratio', live.thrustRatio)}</dd><dt>旋翼</dt><dd>{ir.rotors.length} 轴</dd></dl><button className="button primary" onClick={open}><Maximize2 size={15}/>进入参数修订</button><div className="preview-export"><a className="text-link" download href={`/api/experiments/${candidate.run_id}/candidates/${candidate.candidate_id}/ir`}><Download size={14}/>导出机型配置</a><TermTooltip term="drone_ir" showIconOnly/></div></div>
    </div>
    <div className="part-hint"><span>{partName(state.activePart)}</span><span>{live.conflicts.size ? `发现 ${live.conflicts.size} 个干涉桨盘` : '桨盘包络无干涉'}</span></div>
  </section>;
}

interface NumberFieldProps { label: string; number: number; change: (number: number) => void; min?: number; max?: number; step?: number | 'any'; disabled?: boolean }
function NumberField({ label, number, change, min, max, step = 'any', disabled = false }: NumberFieldProps) {
  return <label>{label}<input type="number" min={min} max={max} step={step} value={Number.isFinite(number) ? number : ''} disabled={disabled} onChange={e => change(Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0)}/></label>;
}
function VectorFields({ title, vector, change }: { title: string; vector: readonly number[]; change: (axis: number, number: number) => void }) {
  return <div className="vector-fields"><span>{title}</span><div>{vector.map((v, axis) => <NumberField key={axis} label={`${title} ${['X', 'Y', 'Z'][axis]}`} number={v} change={number => change(axis, number)}/>)}</div></div>;
}

function StudioReplay({ run, candidate }: { run: Run; candidate: Candidate }) {
  const { state } = useWorkbenchStore();
  const timeRef = useRef(0);
  const [details, setDetails] = useState<CandidateDetails | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const { candidate_id: candidateId, status } = candidate;
  const pending = status === 'NEW' || status === 'L1_PASSED';
  useEffect(() => {
    if (pending) return;
    const controller = new AbortController();
    api<CandidateDetails>(`/experiments/${encodeURIComponent(run.id)}/candidates/${encodeURIComponent(candidateId)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setDetails(result); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [run.id, candidateId, pending, retry]);

  const recorded = details?.evaluations.find(evaluation => evaluation.level === 'L2' && evaluation.result.replay?.frames.length)?.result.replay;
  if (error) return <div className="studio-empty" role="status"><p>{error}</p><button className="button secondary" onClick={() => { setError(''); setRetry(value => value + 1); }}>重新读取回放</button></div>;
  if (!recorded) return <div className="studio-empty" role="status">{pending ? '候选仍在评估，轨迹归档后即可回放。' : details ? '此候选暂无三维飞行轨迹。' : '正在读取飞行回放…'}</div>;
  return <div className="studio-replay">
    <ViewerTools replay/>
    <Suspense fallback={<div className="viewer-loading">加载三维飞行回放…</div>}>
      <Viewer ir={candidate.ir} modelKey={candidateId} explode={0} spinning={false} activePart={null} camera={state.camera} reset={state.cameraReset} replay={recorded} replayTime={timeRef}/>
    </Suspense>
    <ReplayBar start={recorded.frames[0][0]} end={recorded.frames.at(-1)![0]} scenario={details!.request.scenario} timeRef={timeRef}/>
  </div>;
}

export function Studio({ run, candidate, onRevision, onNewExperiment, embedded = false }: {
  run: Run;
  candidate: Candidate;
  onRevision: (candidate: Candidate) => Promise<void>;
  onNewExperiment: (ir: DroneIR) => void;
  embedded?: boolean;
}) {
  const { state, modelCamera, patch, select, edit, resetDraft, canLeave, setActiveStage } = useWorkbenchStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const [advanced, setAdvanced] = useState(false), [rotorIndex, setRotorIndex] = useState(0), [coupleBattery, setCoupleBattery] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const controllerTypeId = useId();
  const ir = state.selected?.candidate_id === candidate.candidate_id ? state.draft ?? candidate.ir : candidate.ir;
  const live = inspectIR(ir, run.request);
  const replay = state.studioMode === 'replay';
  const request: L1CheckRequest = { drone_ir: ir, goal: run.request.goal, scenario: run.request.scenario };
  const body = JSON.stringify(request);
  const canCheck = !replay && !live.errors.length;
  const [check, setCheck] = useState<{ body: string; result?: EvalResult; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const currentCheck = check?.body === body ? check : null;
  const result = currentCheck?.result;
  useEffect(() => { if (!embedded) dialog.current?.showModal(); }, [embedded]);
  useEffect(() => {
    if (!canCheck) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<EvalResult>('/evaluate/l1', { method: 'POST', body, signal: controller.signal })
        .then(value => { if (!controller.signal.aborted) setCheck({ body, result: value }); })
        .catch(err => { if (!controller.signal.aborted) setCheck({ body, error: err.message }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [body, canCheck, retry]);
  const close = () => { if (!busy && canLeave()) { resetDraft(); setActiveStage('monitor'); } };
  useEffect(() => {
    if (replay || !state.activePart) return;
    let section = state.activePart;
    if (section.startsWith('rotor:')) {
      const index = ir.rotors.findIndex(r => r.id === section.slice(6));
      if (index >= 0) setRotorIndex(index);
      setAdvanced(true); section = 'rotors';
    }
    const target = document.getElementById(`editor-${section}`) as HTMLDetailsElement | null;
    if (target) { target.open = true; target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }, [state.activePart, replay]);
  const onPart = useCallback((part: string) => patch({ activePart: part }), [patch]);
  const rotor = ir.rotors[Math.min(rotorIndex, ir.rotors.length - 1)];
  const tilt = Math.acos(Math.max(-1, Math.min(1, -ir.rotors[0].thrust_axis[2]))) * 180 / Math.PI;
  const setLength = (length: number) => edit(d => d.rotors.forEach((r, i) => {
    const radius = Math.hypot(r.position_m[0], r.position_m[1]);
    const angle = radius ? Math.atan2(r.position_m[1], r.position_m[0]) : i * Math.PI * 2 / d.rotors.length;
    r.position_m = [length * Math.cos(angle), length * Math.sin(angle), r.position_m[2]];
  }));
  const setTilt = (angle: number) => edit(d => d.rotors.forEach(r => {
    const azimuth = Math.atan2(r.position_m[1], r.position_m[0]), radians = angle * Math.PI / 180;
    r.thrust_axis = [-Math.cos(azimuth) * Math.sin(radians), -Math.sin(azimuth) * Math.sin(radians), -Math.cos(radians)];
  }));
  const checkStatus = live.errors.length ? '请修正参数后校验' : currentCheck?.error ? '校验请求失败'
    : result ? result.status === 'PASSED' ? '初筛通过' : '初筛未通过' : '正在校验…';
  const content = <>
    <div className="studio-heading"><h2>3D 参数修订工作台 <small>候选 {candidate.proposal_index + 1}{state.dirty ? ' · 未提交草稿' : ''}</small></h2>
      <button className="icon-button" aria-label="关闭 3D 工作台" disabled={busy} onClick={close}><X size={21}/></button></div>
    <div className="studio-navigation">
      <label>候选方案<select value={candidate.candidate_id} aria-label="工作台候选方案" disabled={busy} onChange={event => {
        const next = run.candidates.find(item => item.candidate_id === event.target.value);
        if (next) select(next);
      }}>{run.candidates.map(item => <option key={item.candidate_id} value={item.candidate_id}>候选 {item.proposal_index + 1}{item.source === 'manual_revision' ? ` · ${GLOSSARY.manual_revision.uiLabel}` : ''}</option>)}</select></label>
      <div className="editor-mode" aria-label="工作台模式">
        <button type="button" aria-pressed={!replay} disabled={busy} onClick={() => patch({ studioMode: 'edit' })}>机型改参</button>
        <button type="button" aria-pressed={replay} disabled={busy} onClick={() => patch({ studioMode: 'replay' })}>飞行回放</button>
      </div>
    </div>
    {replay ? <StudioReplay key={candidate.candidate_id} run={run} candidate={candidate}/> : <>
    <div className="studio-layout"><div className="studio-visual"><ViewerTools/><Suspense fallback={<div className="viewer-loading">加载三维工作台…</div>}><Viewer ir={ir} modelKey={candidate.candidate_id} explode={state.explode} spinning={state.spinning} activePart={state.activePart} camera={state.camera} reset={state.cameraReset} modelCamera={modelCamera} onPart={onPart}/></Suspense><div className="part-selectors" aria-label="选择三维部件">{[['airframe', '机身'], ['controller', '控制器'], ['power', '电池'], ['payload', '载荷'], ...ir.rotors.map(r => [`rotor:${r.id}`, r.id])].map(([part, name]) => <button key={part} aria-pressed={state.activePart === part} onClick={() => onPart(part)}>{name}</button>)}</div><p className="studio-note">单次评估将保存为新的{GLOSSARY.manual_revision.uiLabel}，并沿用当前场景和剩余预算。</p></div>
      <div className="parameter-editor">
        <section className="studio-live" aria-label="物理快速初筛实时校验">
          <div className="studio-check-heading"><h3><TermTooltip term="l1_screen" inlineLabel="物理快速初筛实时校验"/></h3><span role="status" className={result?.status === 'PASSED' ? 'validation-good' : result || currentCheck?.error ? 'validation-bad' : ''}>{checkStatus}</span></div>
          <dl className="studio-check-values">
            <div><dt>{METRIC_META.total_mass_kg.label}</dt><dd>{formatMetric('total_mass_kg', result?.metrics.total_mass_kg)}</dd></div>
            <div><dt>动力余量（推重比）</dt><dd>{formatMetric('thrust_to_weight_ratio', result?.metrics.thrust_to_weight_ratio)}</dd></div>
            <div><dt>{METRIC_META.flight_time_min.label}</dt><dd>{formatMetric('flight_time_min', result?.metrics.flight_time_min)}</dd></div>
          </dl>
          {live.conflicts.size > 0 && !result && <p className="validation-bad">桨盘干涉</p>}
          {result?.violations.length ? <ul className="studio-check-violations">{result.violations.map((violation, index) => <li key={index}>
            <strong>{violationLabel(violation.rule)}</strong> · {formatViolationValues(violation)}
          </li>)}</ul> : result?.message && <p className="validation-bad">{result.message}</p>}
          {currentCheck?.error && <div className="studio-check-error"><p className="validation-bad">{currentCheck.error}</p><button type="button" className="button secondary compact" onClick={() => { setCheck(null); setRetry(value => value + 1); }}>重新校验</button></div>}
        </section>
        <fieldset disabled={busy}>
        <details open id="editor-rotors" className={state.activePart?.startsWith('rotor:') ? 'active-editor' : ''}><summary>构型与旋翼 · {ir.rotors.length} 轴</summary><div className="editor-mode"><button type="button" aria-pressed={!advanced} onClick={() => setAdvanced(false)}>对称快捷</button><button type="button" aria-pressed={advanced} onClick={() => setAdvanced(true)}>高级单轴</button></div>
          {!advanced ? <div className="form-grid"><NumberField label="机臂长度 / m" number={armLength(ir)} min={0.01} change={setLength}/><NumberField label="桨半径 / m" number={ir.rotors[0].prop_radius_m} min={0.001} change={number => edit(d => d.rotors.forEach(r => { r.prop_radius_m = number; }))}/><NumberField label="单桨最大推力 / N" number={ir.rotors[0].max_thrust_n} min={0.01} change={number => edit(d => d.rotors.forEach(r => { r.max_thrust_n = number; }))}/><NumberField label="旋翼内倾角 / °" number={Number(tilt.toFixed(3))} min={0} max={75} change={setTilt}/></div> : <>
            <label>编辑旋翼<select aria-label="编辑旋翼" value={Math.min(rotorIndex, ir.rotors.length - 1)} onChange={e => { setRotorIndex(+e.target.value); patch({ activePart: `rotor:${ir.rotors[+e.target.value].id}` }); }}>{ir.rotors.map((r, i) => <option key={r.id} value={i}>{r.id}</option>)}</select></label>
            <VectorFields title="旋翼位置 / m" vector={rotor.position_m} change={(axis, number) => edit(d => { d.rotors[rotorIndex].position_m[axis] = number; })}/>
            <VectorFields title="推力轴 / 单位向量" vector={rotor.thrust_axis} change={(axis, number) => edit(d => { d.rotors[rotorIndex].thrust_axis[axis] = number; })}/>
            <button className="button secondary compact" onClick={() => edit(d => { const r = d.rotors[rotorIndex], norm = Math.hypot(...r.thrust_axis); r.thrust_axis = norm ? r.thrust_axis.map(v => v / norm) as [number, number, number] : [0, 0, -1]; })}>归一化推力轴</button>
            <div className="form-grid"><NumberField label="该桨半径 / m" number={rotor.prop_radius_m} min={0.001} change={number => edit(d => { d.rotors[rotorIndex].prop_radius_m = number; })}/><NumberField label="该桨最大推力 / N" number={rotor.max_thrust_n} min={0.01} change={number => edit(d => { d.rotors[rotorIndex].max_thrust_n = number; })}/><NumberField label="电机时间常数 / s" number={rotor.motor_time_constant_s} min={0.001} change={number => edit(d => { d.rotors[rotorIndex].motor_time_constant_s = number; })}/><NumberField label="扭推比 / m" number={rotor.torque_to_thrust_ratio} min={0.0001} change={number => edit(d => { d.rotors[rotorIndex].torque_to_thrust_ratio = number; })}/><label>旋翼转向<select value={rotor.spin_direction} onChange={e => edit(d => { d.rotors[rotorIndex].spin_direction = +e.target.value as 1 | -1; })}><option value="1">+1</option><option value="-1">-1</option></select></label></div>
          </>}
        </details>
        <details open id="editor-power" className={state.activePart === 'power' ? 'active-editor' : ''}><summary>能源电池</summary><label className="checkbox-label"><input type="checkbox" checked={coupleBattery} onChange={e => { setCoupleBattery(e.target.checked); if (e.target.checked) edit(d => { d.power.battery_mass_kg = d.power.capacity_wh / 180; }); }}/>按 180 Wh/kg 联动电池质量</label><div className="form-grid"><NumberField label="电池容量 / Wh" number={ir.power.capacity_wh} min={1} change={number => edit(d => { d.power.capacity_wh = number; if (coupleBattery) d.power.battery_mass_kg = number / 180; })}/><NumberField label="电池质量 / kg" number={ir.power.battery_mass_kg} min={0.001} disabled={coupleBattery} change={number => edit(d => { d.power.battery_mass_kg = number; })}/><NumberField label="最大放电功率 / W" number={ir.power.max_discharge_w} min={1} change={number => edit(d => { d.power.max_discharge_w = number; })}/></div></details>
        <details open id="editor-payload" className={state.activePart === 'payload' ? 'active-editor' : ''}><summary>任务载荷</summary><NumberField label="载荷质量 / kg" number={ir.payload.mass_kg} min={0} change={number => edit(d => { d.payload.mass_kg = number; })}/><VectorFields title="载荷位置 / m" vector={ir.payload.position_m} change={(axis, number) => edit(d => { d.payload.position_m[axis] = number; })}/></details>
        <details id="editor-airframe" className={state.activePart === 'airframe' ? 'active-editor' : ''}><summary>机身与质量特性</summary><NumberField label="机身基础质量 / kg" number={ir.airframe.base_mass_kg} min={0.001} change={number => edit(d => { d.airframe.base_mass_kg = number; })}/><VectorFields title="机身重心 / m" vector={ir.airframe.cg_offset_m} change={(axis, number) => edit(d => { d.airframe.cg_offset_m[axis] = number; })}/><VectorFields title="机身惯量对角 / kg·m²" vector={ir.airframe.inertia_diag_kg_m2} change={(axis, number) => edit(d => { d.airframe.inertia_diag_kg_m2[axis] = number; })}/><VectorFields title="线性阻力系数" vector={ir.airframe.linear_drag_coeff} change={(axis, number) => edit(d => { d.airframe.linear_drag_coeff[axis] = number; })}/></details>
        <details id="editor-controller" className={state.activePart === 'controller' ? 'active-editor' : ''}>
          <summary>控制器与增益</summary>
          <div className="form-field">
            <div className="form-field-heading"><label htmlFor={controllerTypeId}>控制器类型</label><TermTooltip term={ir.controller.type} showIconOnly/></div>
            <select id={controllerTypeId} value={ir.controller.type} onChange={e => edit(d => {
              d.controller.type = e.target.value as DroneIR['controller']['type'];
              d.controller.params = {};
            })}>
              <option value="cascaded_pid">{GLOSSARY.cascaded_pid.uiLabel}</option>
              <option value="lqr">{GLOSSARY.lqr.uiLabel}</option>
            </select>
          </div>
          {ir.controller.type === 'cascaded_pid' && <>
            <label className="checkbox-label"><input type="checkbox" checked={ir.controller.auto_scale_gains}
              onChange={e => edit(d => { d.controller.auto_scale_gains = e.target.checked; })}/>自动缩放控制增益</label>
            <div className="form-grid">
              {['pos_kp', 'pos_kd', 'pos_ki', 'att_kp', ir.controller.auto_scale_gains ? 'rate_kr' : 'rate_kp'].map(key =>
                <label key={key}>{key}（覆盖默认值）<input type="number" step="any" value={ir.controller.params[key] ?? ''}
                  placeholder="使用模型默认值" onChange={e => edit(d => {
                    if (e.target.value === '') delete d.controller.params[key];
                    else d.controller.params[key] = Number(e.target.value);
                  })}/></label>)}
            </div>
          </>}
        </details>
      </fieldset></div>
    </div>
    <div className="studio-feedback">{live.errors.map(text => <p className="validation-bad" key={text}>{text}</p>)}{live.warnings.map(text => <p className="validation-warning" key={text}>{text}</p>)}{error && <p className="form-error" role="alert">{error}</p>}</div>
    <div className="studio-footer"><span>{partName(state.activePart)}</span><div><button className="button secondary" disabled={busy || !state.dirty} onClick={() => { resetDraft(); setError(''); }}><RotateCcw size={15}/>重置修改</button><button className="button secondary" onClick={() => downloadIR(ir, `candidate-${candidate.proposal_index + 1}-draft`)}><Download size={15}/>导出微调版机型配置</button><button className="button secondary" disabled={busy || live.errors.length > 0} onClick={() => { patch({ dirty: false, activeStage: 'monitor' }); onNewExperiment(structuredClone(ir)); }}>用此机型新建实验</button><button className="button primary" disabled={busy || !state.dirty || live.errors.length > 0 || result?.status !== 'PASSED' || run.status === 'CANCELLED'} onClick={async () => {
      setBusy(true); setError('');
      try { const revision = await api<Candidate>(`/experiments/${run.id}/candidates/evaluate`, { method: 'POST', body: JSON.stringify({ parent_ir_hash: candidate.ir_hash, drone_ir: ir }) }); await onRevision(revision); }
      catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}><Save size={15}/>{busy ? '正在保存修订…' : '保存并运行单次评估'}</button></div></div>
    </>}
  </>;
  const title = '3D 参数修订工作台';
  return embedded ? <section className="panel studio-embedded" aria-label={title} data-selected-candidate={candidate.candidate_id}>{content}</section>
    : <dialog ref={dialog} className="studio-dialog" aria-label={title} onCancel={e => { e.preventDefault(); close(); }}>{content}</dialog>;
}
