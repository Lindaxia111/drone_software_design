import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Box, Download, Maximize2, RotateCcw, Save, X } from 'lucide-react';
import { api, type Candidate, type Run } from '../api';
import type { DroneIR } from '../contracts';
import { useWorkbenchStore } from './state';
import { armLength, downloadIR, inspectIR } from './geometry';

const Viewer = lazy(() => import('./Drone3DViewer'));
const value = (n: number, digits = 3) => Number.isFinite(n) ? n.toFixed(digits) : '—';
const partName = (part: string | null) => part?.startsWith('rotor:') ? `旋翼 ${part.slice(6)}` : ({ airframe: '机身', power: '电池', payload: '任务载荷', controller: '控制器' }[part ?? ''] ?? '点击部件查看参数');

export function ViewerTools({ compact = false }: { compact?: boolean }) {
  const { state, patch } = useWorkbenchStore();
  return <div className={`viewer-tools ${compact ? 'compact-viewer-tools' : ''}`}>
    <div className="view-presets">{[['iso', '等轴测'], ['top', '俯视 FRD'], ['side', '侧视']].map(([key, title]) => <button key={key} aria-pressed={state.camera === key} onClick={() => patch({ camera: key as typeof state.camera })}>{title}</button>)}<button title="重置视角" aria-label={compact ? '预览重置视角' : '重置视角'} onClick={() => patch({ camera: 'iso', cameraReset: state.cameraReset + 1 })}><RotateCcw size={14}/></button></div>
    <div className="explode-tools"><label>拆解 <strong>{Math.round(state.explode * 100)}%</strong><input type="range" aria-label={compact ? '预览拆解比例' : '拆解比例'} min="0" max="1" step="0.01" value={state.explode} onChange={e => patch({ explode: +e.target.value })}/></label><button onClick={() => patch({ explode: state.explode > 0.5 ? 0 : 1 })}>{state.explode > 0.5 ? '装配态' : '拆解态'}</button><button aria-pressed={state.spinning} onClick={() => patch({ spinning: !state.spinning })}>{state.spinning ? '停止桨叶' : '桨叶旋转'}</button></div>
  </div>;
}

export function CandidatePreview({ candidate }: { candidate: Candidate | undefined }) {
  const { state, patch, select } = useWorkbenchStore();
  const onPart = useCallback((part: string) => patch({ activePart: part, studioOpen: true }), [patch]);
  if (!candidate) return <section className="panel candidate-panel" id="candidate-studio"><div className="panel-heading"><h3>候选构型 3D</h3><span className="subtle">程序化建模 · FRD</span></div><div className="studio-empty"><Box size={32}/><p>评估生成候选后，在这里旋转、拆解并修订构型。</p></div></section>;
  const draft = state.selected?.candidate_id === candidate.candidate_id && state.dirty ? state.draft : null;
  const ir = draft ?? candidate.ir;
  const live = inspectIR(ir);
  const open = () => { if (select(candidate)) patch({ studioOpen: true }); };
  return <section className="panel candidate-panel" id="candidate-studio" data-selected-candidate={candidate.candidate_id}>
    <div className="panel-heading"><h3>候选构型 3D <span className="model-badge">{state.dirty ? '修订草稿' : `候选 ${candidate.proposal_index + 1}`}</span></h3><button className="icon-button" aria-label="展开 3D 工作台" onClick={open}><Maximize2 size={17}/></button></div>
    <ViewerTools compact/>
    <div className="preview-3d-layout">
      {!state.studioOpen ? <Suspense fallback={<div className="viewer-loading">加载 3D 构型…</div>}><Viewer ir={ir} modelKey={candidate.candidate_id} explode={state.explode} spinning={state.spinning} activePart={state.activePart} camera={state.camera} reset={state.cameraReset} onPart={onPart}/></Suspense> : <div className="viewer-loading">已在大屏工作台中查看</div>}
      <div className="preview-summary"><span className="eyebrow">DRONE-AS-CODE</span><strong>候选 {String(candidate.proposal_index + 1).padStart(3, '0')}</strong><span className="subtle">{candidate.source === 'manual_revision' ? '◆ 手动修订' : '算法生成'} · {candidate.ir_hash.slice(0, 10)}</span><dl><dt>总质量</dt><dd>{value(live.mass)} kg</dd><dt>电池容量</dt><dd>{value(ir.power.capacity_wh, 1)} Wh</dd><dt>推重比</dt><dd>{value(live.thrustRatio, 2)}</dd><dt>旋翼</dt><dd>{ir.rotors.length} 轴</dd></dl><button className="button primary" onClick={open}><Maximize2 size={15}/>进入参数修订</button><a className="text-link" download href={`/api/experiments/${candidate.run_id}/candidates/${candidate.candidate_id}/ir`}><Download size={14}/>导出 DroneIR</a></div>
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

export function Studio({ run, candidate, onRevision, onNewExperiment }: { run: Run; candidate: Candidate; onRevision: (candidate: Candidate) => Promise<void>; onNewExperiment: (ir: DroneIR) => void }) {
  const { state, patch, edit, resetDraft, canLeave } = useWorkbenchStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const [advanced, setAdvanced] = useState(false), [rotorIndex, setRotorIndex] = useState(0), [coupleBattery, setCoupleBattery] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const ir = state.draft ?? candidate.ir, live = inspectIR(ir, run.request);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const close = () => { if (!busy && canLeave()) { resetDraft(); patch({ studioOpen: false }); } };
  useEffect(() => {
    if (!state.activePart) return;
    let section = state.activePart;
    if (section.startsWith('rotor:')) {
      const index = ir.rotors.findIndex(r => r.id === section.slice(6));
      if (index >= 0) setRotorIndex(index);
      setAdvanced(true); section = 'rotors';
    }
    const target = document.getElementById(`editor-${section}`) as HTMLDetailsElement | null;
    if (target) { target.open = true; target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }, [state.activePart]);
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
  return <dialog ref={dialog} className="studio-dialog" aria-label="3D 参数修订工作台" onCancel={e => { e.preventDefault(); close(); }}>
    <div className="studio-heading"><div><span className="eyebrow">CONFIGURATION STUDIO</span><h2>3D 参数修订工作台 <small>候选 {candidate.proposal_index + 1}{state.dirty ? ' · 未提交草稿' : ''}</small></h2></div><button className="icon-button" aria-label="关闭 3D 工作台" disabled={busy} onClick={close}><X size={21}/></button></div>
    <div className="studio-live" role="status"><span>总质量 <strong>{value(live.mass)} kg</strong></span><span>推重比 <strong>{value(live.thrustRatio, 2)}</strong></span><span>悬停油门估算 <strong>{value(live.hover * 100, 1)}%</strong></span><span className={live.conflicts.size ? 'validation-bad' : 'validation-good'}>{live.conflicts.size ? '桨盘干涉' : '桨盘无干涉'}</span><span className="subtle">静态近似，配平结果以 L1 为准</span></div>
    <div className="studio-layout"><div className="studio-visual"><ViewerTools/><Suspense fallback={<div className="viewer-loading">加载三维工作台…</div>}><Viewer ir={ir} modelKey={candidate.candidate_id} explode={state.explode} spinning={state.spinning} activePart={state.activePart} camera={state.camera} reset={state.cameraReset} onPart={onPart}/></Suspense><div className="part-selectors" aria-label="选择三维部件">{[['airframe', '机身'], ['controller', '控制器'], ['power', '电池'], ['payload', '载荷'], ...ir.rotors.map(r => [`rotor:${r.id}`, r.id])].map(([part, name]) => <button key={part} aria-pressed={state.activePart === part} onClick={() => onPart(part)}>{name}</button>)}</div><p className="studio-note">修改的是独立草稿，原构型与评估记录保持不变。手动重评沿用原场景和剩余预算，任务会单独执行，原实验的暂停或结束状态保留。</p></div>
      <div className="parameter-editor"><fieldset disabled={busy}>
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
        <details id="editor-controller" className={state.activePart === 'controller' ? 'active-editor' : ''}><summary>控制器与增益</summary><label>控制器类型<select value={ir.controller.type} disabled><option value="cascaded_pid">级联 PID</option></select></label><label className="checkbox-label"><input type="checkbox" checked={ir.controller.auto_scale_gains} onChange={e => edit(d => { d.controller.auto_scale_gains = e.target.checked; })}/>自动缩放控制增益</label><div className="form-grid">{['pos_kp', 'pos_kd', 'pos_ki', 'att_kp', ir.controller.auto_scale_gains ? 'rate_kr' : 'rate_kp'].map(key => <label key={key}>{key}（覆盖默认值）<input type="number" step="any" value={ir.controller.params[key] ?? ''} placeholder="使用模型默认值" onChange={e => edit(d => { if (e.target.value === '') delete d.controller.params[key]; else d.controller.params[key] = Number(e.target.value); })}/></label>)}</div></details>
      </fieldset></div>
    </div>
    <div className="studio-feedback">{live.errors.map(text => <p className="validation-bad" key={text}>{text}</p>)}{live.warnings.map(text => <p className="validation-warning" key={text}>{text}</p>)}{error && <p className="form-error" role="alert">{error}</p>}</div>
    <div className="studio-footer"><span>{partName(state.activePart)}</span><div><button className="button secondary" disabled={busy || !state.dirty} onClick={() => { resetDraft(); setError(''); }}><RotateCcw size={15}/>重置修改</button><button className="button secondary" onClick={() => downloadIR(ir, `candidate-${candidate.proposal_index + 1}-draft`)}><Download size={15}/>导出修订版 DroneIR</button><button className="button secondary" disabled={busy || live.errors.length > 0} onClick={() => { patch({ dirty: false, studioOpen: false }); onNewExperiment(structuredClone(ir)); }}>以此为种子新建实验</button><button className="button primary" disabled={busy || !state.dirty || live.errors.length > 0 || run.status === 'CANCELLED'} onClick={async () => {
      setBusy(true); setError('');
      try { const revision = await api<Candidate>(`/experiments/${run.id}/candidates/evaluate`, { method: 'POST', body: JSON.stringify({ parent_ir_hash: candidate.ir_hash, drone_ir: ir }) }); await onRevision(revision); }
      catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}><Save size={15}/>{busy ? '正在保存修订…' : '保存并运行单次评估'}</button></div></div>
  </dialog>;
}
