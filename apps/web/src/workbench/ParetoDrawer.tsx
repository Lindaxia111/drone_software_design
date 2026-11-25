import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Run } from '../api';
import { TermTooltip } from '../components/TermTooltip';
import { useWorkbenchStore } from './state';
import { armLength, flattenIR } from './geometry';
import { GLOSSARY } from './glossary';
import { formatMetric } from './metricMeta';

export function ParetoDrawer({ run, embedded = false }: { run: Run; embedded?: boolean }) {
  const { state, patch, select, setActiveStage, toggleCompareId } = useWorkbenchStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const [sort, setSort] = useState('flight'), [compare, setCompare] = useState(false), [onlyDiff, setOnlyDiff] = useState(true);
  useEffect(() => { if (!embedded) dialog.current?.showModal(); }, [embedded]);
  const front = run.candidates.filter(c => run.pareto_ids.includes(c.candidate_id)).sort((a, b) => sort === 'flight' ? b.metrics.flight_time_min - a.metrics.flight_time_min : a.metrics.tracking_rmse_m - b.metrics.tracking_rmse_m);
  const checked = state.compareIds;
  const compared = run.candidates.filter(c => checked.includes(c.candidate_id));
  const visible = [...front, ...compared.filter(c => !run.pareto_ids.includes(c.candidate_id))];
  const flattened = compared.map(c => flattenIR(c.ir));
  const keys = [...new Set(flattened.flatMap(values => Object.keys(values)))];
  const different = (key: string) => new Set(flattened.map(values => values[key])).size > 1;
  const close = () => setActiveStage('monitor');
  const content = <>
    <div className="drawer-heading"><h2><TermTooltip term="pareto" inlineLabel="优选方案对比"/> <small>{front.length} 个优选方案</small></h2><button className="icon-button" aria-label="关闭优选对比" onClick={close}><X size={20}/></button></div>
    <p className="muted">选择方案联动图表与 3D 构型，勾选 2–3 个方案比较关键参数。</p>
    <div className="drawer-actions"><label>排序<select aria-label="优选方案排序" value={sort} onChange={e => setSort(e.target.value)}><option value="flight">续航降序</option><option value="error">航迹偏差升序</option></select></label><button className="button secondary" disabled={!compare && compared.length < 2} onClick={() => setCompare(v => !v)}>{compare ? '返回方案列表' : `参数对比（${compared.length}/3）`}</button></div>
    {!compare ? <div className="table-scroll"><table><thead><tr><th>对比</th><th>候选</th><th>理论悬停续航</th><th>平均航迹偏差</th><th>整机总重量</th><th>电池 / Wh</th><th>动力余量</th><th>操作</th></tr></thead><tbody>{visible.map(c => <tr key={c.candidate_id} aria-selected={state.selected?.candidate_id === c.candidate_id} className={state.selected?.candidate_id === c.candidate_id ? 'focused' : ''} onClick={() => {
      if (select(c) && !embedded) { close(); requestAnimationFrame(() => document.getElementById('candidate-studio')?.scrollIntoView({ block: 'center' })); }
    }}><td><input type="checkbox" aria-label={`对比候选 ${c.proposal_index + 1}`} checked={checked.includes(c.candidate_id)} disabled={!checked.includes(c.candidate_id) && checked.length >= 3} onClick={e => e.stopPropagation()} onChange={() => toggleCompareId(c.candidate_id)}/></td><td>{c.source === 'manual_revision' ? '◆ ' : ''}候选 {c.proposal_index + 1}</td><td>{formatMetric('flight_time_min', c.metrics.flight_time_min)}</td><td>{formatMetric('tracking_rmse_m', c.metrics.tracking_rmse_m)}</td><td>{formatMetric('total_mass_kg', c.metrics.total_mass_kg)}</td><td>{c.ir.power.capacity_wh.toFixed(1)}</td><td>{formatMetric('thrust_to_weight_ratio', c.metrics.thrust_to_weight_ratio)}</td><td><button className="button secondary compact" onClick={e => {
      e.stopPropagation();
      if (select(c)) {
        if (embedded) patch({ activeStage: 'studio', studioMode: 'edit' });
        else close();
      }
    }}>{embedded ? '3D 查看' : '定位方案'} {c.proposal_index + 1}</button></td></tr>)}</tbody></table></div> : <>
      <label className="checkbox-label"><input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)}/>只看不同参数</label>
      <div className="table-scroll diff-table"><table><thead><tr><th>参数（SI）</th>{compared.map(c => <th key={c.candidate_id}>候选 {c.proposal_index + 1}</th>)}</tr></thead><tbody>
        <tr><td>平均机臂长度 / m</td>{compared.map(c => <td key={c.candidate_id}>{armLength(c.ir).toFixed(4)}</td>)}</tr>
        {keys.filter(key => !onlyDiff || different(key)).map(key => <tr key={key} className={different(key) ? 'diff-row' : ''}><td>{key}</td>{flattened.map((values, i) => <td key={i}>{values[key] ?? '—'}</td>)}</tr>)}
      </tbody></table></div>
      {onlyDiff && !keys.some(different) && <p className="muted">这些构型的参数相同，可关闭筛选查看全部字段。</p>}
    </>}
    {!front.length && <p className="muted">暂无优选方案。</p>}
    <div className="drawer-footer"><button className="button primary" disabled={!front.length} onClick={() => { patch({ onlyPareto: true, activeStage: 'monitor' }); setTimeout(() => document.getElementById('candidate-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); }}>{GLOSSARY.only_pareto.uiLabel}</button></div>
  </>;
  return embedded ? <section className="panel pareto-drawer pareto-embedded" aria-label="优选方案对比" data-selected-candidate={state.selected?.candidate_id}>{content}</section>
    : <dialog ref={dialog} className="workbench-drawer pareto-drawer" onCancel={close} aria-label="优选方案对比">{content}</dialog>;
}
