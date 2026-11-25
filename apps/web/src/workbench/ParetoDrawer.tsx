import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Run } from '../api';
import { useWorkbenchStore } from './state';
import { armLength, flattenIR } from './geometry';

export function ParetoDrawer({ run }: { run: Run }) {
  const { state, patch, select } = useWorkbenchStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const [sort, setSort] = useState('flight'), [checked, setChecked] = useState<string[]>([]), [compare, setCompare] = useState(false), [onlyDiff, setOnlyDiff] = useState(true);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const front = run.candidates.filter(c => run.pareto_ids.includes(c.candidate_id)).sort((a, b) => sort === 'flight' ? b.metrics.flight_time_min - a.metrics.flight_time_min : a.metrics.tracking_rmse_m - b.metrics.tracking_rmse_m);
  const compared = front.filter(c => checked.includes(c.candidate_id));
  const flattened = compared.map(c => flattenIR(c.ir));
  const keys = [...new Set(flattened.flatMap(values => Object.keys(values)))];
  const different = (key: string) => new Set(flattened.map(values => values[key])).size > 1;
  return <dialog ref={dialog} className="workbench-drawer pareto-drawer" onCancel={() => patch({ paretoOpen: false })} aria-label="帕累托方案对比">
    <div className="drawer-heading"><div><span className="eyebrow">PARETO FRONT</span><h2>帕累托方案对比 <small>{front.length} 个方案</small></h2></div><button className="icon-button" aria-label="关闭帕累托对比" onClick={() => patch({ paretoOpen: false })}><X size={20}/></button></div>
    <p className="muted">选择方案联动图表与 3D 构型，勾选 2–3 个方案比较关键参数。</p>
    <div className="drawer-actions"><label>排序<select aria-label="帕累托排序" value={sort} onChange={e => setSort(e.target.value)}><option value="flight">续航降序</option><option value="error">跟踪误差升序</option></select></label><button className="button secondary" disabled={compared.length < 2} onClick={() => setCompare(v => !v)}>{compare ? '返回方案列表' : `参数对比（${compared.length}/3）`}</button></div>
    {!compare ? <div className="table-scroll"><table><thead><tr><th>对比</th><th>候选</th><th>续航 / min</th><th>误差 / m</th><th>质量 / kg</th><th>电池 / Wh</th><th>推重比</th><th>操作</th></tr></thead><tbody>{front.map(c => <tr key={c.candidate_id} className={state.selected?.candidate_id === c.candidate_id ? 'focused' : ''} onClick={() => { if (select(c)) { patch({ paretoOpen: false }); document.getElementById('candidate-studio')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }}><td><input type="checkbox" aria-label={`对比候选 ${c.proposal_index + 1}`} checked={checked.includes(c.candidate_id)} disabled={!checked.includes(c.candidate_id) && compared.length >= 3} onClick={e => e.stopPropagation()} onChange={e => setChecked(ids => e.target.checked ? [...ids, c.candidate_id] : ids.filter(id => id !== c.candidate_id))}/></td><td>{c.source === 'manual_revision' ? '◆ ' : ''}候选 {c.proposal_index + 1}</td><td>{c.metrics.flight_time_min?.toFixed(2)}</td><td>{c.metrics.tracking_rmse_m?.toFixed(3)}</td><td>{c.metrics.total_mass_kg?.toFixed(3)}</td><td>{c.ir.power.capacity_wh.toFixed(1)}</td><td>{c.metrics.thrust_to_weight_ratio?.toFixed(2)}</td><td><button className="button secondary compact" onClick={e => { e.stopPropagation(); if (select(c)) patch({ paretoOpen: false }); }}>定位方案 {c.proposal_index + 1}</button></td></tr>)}</tbody></table></div> : <>
      <label className="checkbox-label"><input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)}/>只看不同参数</label>
      <div className="table-scroll diff-table"><table><thead><tr><th>参数（SI）</th>{compared.map(c => <th key={c.candidate_id}>候选 {c.proposal_index + 1}</th>)}</tr></thead><tbody>
        <tr><td>平均机臂长度 / m</td>{compared.map(c => <td key={c.candidate_id}>{armLength(c.ir).toFixed(4)}</td>)}</tr>
        {keys.filter(key => !onlyDiff || different(key)).map(key => <tr key={key} className={different(key) ? 'diff-row' : ''}><td>{key}</td>{flattened.map((values, i) => <td key={i}>{values[key] ?? '—'}</td>)}</tr>)}
      </tbody></table></div>
      {onlyDiff && !keys.some(different) && <p className="muted">这些构型的参数相同，可关闭筛选查看全部字段。</p>}
    </>}
    {!front.length && <p className="muted">暂无帕累托方案。</p>}
    <div className="drawer-footer"><button className="button primary" onClick={() => { patch({ onlyPareto: true, paretoOpen: false }); setTimeout(() => document.getElementById('candidate-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); }}>在候选列表中仅看帕累托方案</button></div>
  </dialog>;
}
