import { useEffect, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import type { Candidate, Run } from '../api';
import { TermTooltip } from '../components/TermTooltip';
import { useWorkbenchStore } from './state';
import { GLOSSARY, PARETO_FRONT_LABEL } from './glossary';
import { formatMetric, METRIC_META } from './metricMeta';
import { formatLineageDelta, LINEAGE_METRICS, type LineageDiff } from './lineage';

function Plot({ run, kind, lineage }: { run: Run | null; kind: 'convergence' | 'pareto'; lineage?: ReadonlyMap<string, LineageDiff> }) {
  const { state, select, patch } = useWorkbenchStore();
  const [zoom, setZoom] = useState(1), [panX, setPanX] = useState(0.5), [panY, setPanY] = useState(0.5);
  const name = kind === 'convergence' ? '收敛图' : '权衡图';
  const candidates = run?.candidates ?? [];
  const points = candidates.filter(c => Number.isFinite(c.metrics.flight_time_min) && (kind === 'convergence' || Number.isFinite(c.metrics.tracking_rmse_m)));
  const maxIteration = Math.max(1, ...candidates.map(c => c.proposal_index));
  const xs = points.map(c => kind === 'convergence' ? c.proposal_index : c.metrics.tracking_rmse_m);
  const xmin = kind === 'convergence' ? 0 : Math.min(0.1, ...xs) * 0.9;
  const xmax = kind === 'convergence' ? maxIteration : Math.max(xmin + 0.02, ...xs) * 1.1;
  const ymax = Math.max(5, ...points.map(c => c.metrics.flight_time_min)) * 1.13;
  const spanX = (xmax - xmin) / zoom, spanY = ymax / zoom;
  const startX = xmin + (xmax - xmin - spanX) * panX, startY = (ymax - spanY) * panY;
  const w = kind === 'convergence' ? 680 : 410, h = 224, left = 45, right = w - 22, top = 22, bottom = 183;
  const xValue = (c: Candidate) => kind === 'convergence' ? c.proposal_index : c.metrics.tracking_rmse_m;
  const position = (c: Candidate) => [left + (xValue(c) - startX) / spanX * (right - left), bottom - (c.metrics.flight_time_min - startY) / spanY * (bottom - top)];
  const pointIds = new Map(points.map(candidate => [candidate.candidate_id, candidate]));
  const selected = points.find(c => c.candidate_id === state.selected?.candidate_id);
  const hovered = points.find(c => c.candidate_id === state.hovered);
  const tooltip = hovered ?? selected;
  const activeLineage = tooltip && lineage?.get(tooltip.candidate_id);
  useEffect(() => {
    if (!selected || zoom === 1) return;
    setPanX(Math.max(0, Math.min(1, (xValue(selected) - xmin - spanX / 2) / Math.max(xmax - xmin - spanX, 1e-9))));
    setPanY(Math.max(0, Math.min(1, (selected.metrics.flight_time_min - spanY / 2) / Math.max(ymax - spanY, 1e-9))));
  }, [state.selected?.candidate_id, zoom]);
  let best = 0;
  const line = points.filter(c => c.status === 'PASSED').map((c, i) => {
    best = Math.max(best, c.metrics.flight_time_min);
    const x = position(c)[0], y = bottom - (best - startY) / spanY * (bottom - top);
    return `${i ? 'L' : 'M'}${x},${y}`;
  }).join(' ');
  const clip = `plot-${kind}`;
  return <>
    <div className="chart-tools"><span>{points.length} 个可查看数据点</span><div><button aria-label={`放大${name}`} onClick={() => setZoom(z => Math.min(8, z * 2))} disabled={zoom === 8}><Plus size={14}/></button><span>{zoom}×</span><button aria-label={`缩小${name}`} onClick={() => setZoom(z => Math.max(1, z / 2))} disabled={zoom === 1}><Minus size={14}/></button><button aria-label={`重置${name}`} onClick={() => { setZoom(1); setPanX(0.5); setPanY(0.5); }}><RotateCcw size={13}/></button></div></div>
    <div className="chart-frame linked-chart" data-chart={kind}>
      <svg viewBox={`0 0 ${w} ${h}`} role="group" aria-label={`${name}，数据点可点击查看参数`}>
        <defs><clipPath id={clip}><rect x={left - 7} y={top - 7} width={right - left + 14} height={bottom - top + 14}/></clipPath>
          {lineage && <marker id="plot-lineage-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0 8 4 0 8Z" fill="#197a72"/>
          </marker>}
        </defs>
        {[0, 1, 2, 3, 4].map(i => <g key={i}><line className="gridline" x1={left} x2={right} y1={bottom - i / 4 * (bottom - top)} y2={bottom - i / 4 * (bottom - top)}/><text x={left - 8} y={bottom - i / 4 * (bottom - top) + 4} textAnchor="end">{(startY + i / 4 * spanY).toFixed(0)}</text><text x={left + i / 4 * (right - left)} y={bottom + 19} textAnchor="middle">{kind === 'convergence' ? Math.round(startX + i / 4 * spanX + 1) : (startX + i / 4 * spanX).toFixed(3)}</text></g>)}
        <text x={left} y={11}>{METRIC_META.flight_time_min.label} / {METRIC_META.flight_time_min.unit}</text><text x={(left + right) / 2} y={h - 1} textAnchor="middle">{kind === 'convergence' ? '候选序号' : `${METRIC_META.tracking_rmse_m.label} / ${METRIC_META.tracking_rmse_m.unit}`}</text>
        <g clipPath={`url(#${clip})`}>
          {kind === 'convergence' && line && <path d={line} fill="none" stroke="#8675e4" strokeWidth="2" pointerEvents="none"/>}
          {lineage && [...lineage].map(([childId, change]) => {
            const parent = pointIds.get(change.parentId), child = pointIds.get(childId);
            if (!parent || !child) return null;
            const [px, py] = position(parent), [cx, cy] = position(child);
            const dx = cx - px, dy = cy - py, length = Math.hypot(dx, dy);
            const path = length > 18
              ? `M${px},${py} L${cx - dx * 8 / length},${cy - dy * 8 / length}`
              : `M${px},${py - 4} Q${(px + cx) / 2 + 21},${(py + cy) / 2 - 22} ${cx + 6},${cy - 7}`;
            return <path key={childId} data-lineage-from={change.parentId} data-lineage-to={childId} className="lineage-arrow" d={path}
              markerEnd="url(#plot-lineage-arrow)" aria-hidden="true"/>;
          })}
          {points.map(c => {
            const [x, y] = position(c), active = state.selected?.candidate_id === c.candidate_id, hot = state.hovered === c.candidate_id;
            const front = run?.pareto_ids.includes(c.candidate_id), failed = !['PASSED', 'L1_PASSED'].includes(c.status);
            const color = failed ? '#cc8b68' : front ? '#7055d4' : '#9ba9c4';
            return <g key={c.candidate_id} role="button" tabIndex={0} aria-label={`${name}候选 ${c.proposal_index + 1}，点击查看完整参数`} data-candidate-id={c.candidate_id} data-selected={active} data-hovered={hot} className="chart-point" onMouseEnter={() => patch({ hovered: c.candidate_id })} onMouseLeave={() => patch({ hovered: null })} onFocus={() => patch({ hovered: c.candidate_id })} onBlur={() => patch({ hovered: null })} onClick={() => select(c, true)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(c, true); } }}>
              <title>{`候选 ${c.proposal_index + 1} · 续航 ${c.metrics.flight_time_min.toFixed(2)} min${Number.isFinite(c.metrics.tracking_rmse_m) ? ` · 误差 ${c.metrics.tracking_rmse_m.toFixed(3)} m` : ''}\n点击查看完整参数`}</title>
              <circle cx={x} cy={y} r="11" fill="transparent"/>
              {(active || hot) && <circle cx={x} cy={y} r={active ? 9 : 8} fill="none" stroke={active ? '#5c42c9' : '#b0a2e9'} strokeWidth={active ? 2 : 1.5}/>}
              {c.source === 'manual_revision' ? <path d={`M${x},${y - 6}l6,6 -6,6 -6,-6Z`} fill="#169b93" stroke="white" strokeWidth="1.2"/> : <circle cx={x} cy={y} r={active ? 5 : front ? 4.5 : 3.5} fill={failed ? 'white' : color} stroke={color} strokeWidth="1.5"/>}
            </g>;
          })}
        </g>
      </svg>
      {!points.length && <div className="chart-empty">{kind === 'convergence' ? '评估后显示可点选的候选方案' : '等待完整的多目标指标'}</div>}
      {tooltip && <div className="chart-selection-note"><strong>{state.hovered ? '预览' : '选中'}候选 {tooltip.proposal_index + 1}</strong><span>{formatMetric('flight_time_min', tooltip.metrics.flight_time_min)}{Number.isFinite(tooltip.metrics.tracking_rmse_m) ? ` · ${formatMetric('tracking_rmse_m', tooltip.metrics.tracking_rmse_m)}` : ' · 尚无航迹偏差指标'}</span>
        {activeLineage ? <small>相对父方案 {activeLineage.parentIndex + 1}{LINEAGE_METRICS.map(({ metric, delta }) => {
          const change = activeLineage[delta];
          return change == null ? null : ` · ${formatLineageDelta(metric, change)}`;
        })}</small> : <small>点击数据点查看完整参数</small>}</div>}
    </div>
    {zoom > 1 && <div className="chart-pan"><label>水平位置<input aria-label={`${name}水平位置`} type="range" min="0" max="1" step="0.01" value={panX} onChange={e => setPanX(+e.target.value)}/></label><label>垂直位置<input aria-label={`${name}垂直位置`} type="range" min="0" max="1" step="0.01" value={panY} onChange={e => setPanY(+e.target.value)}/></label></div>}
    <div className="chart-legend"><span><i className="legend-front"/>{GLOSSARY.pareto.uiLabel}</span><span><i className="legend-normal"/>普通候选</span><span><i className="legend-failed"/>淘汰</span><span>◆ {GLOSSARY.manual_revision.uiLabel}</span></div>
    {kind === 'pareto' && candidates.length > points.length && <p className="chart-missing">{candidates.length - points.length} 个候选尚无完整指标，可在收敛图或列表中查参。</p>}
  </>;
}
const clock = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export function Convergence({ run }: { run: Run | null }) {
  return <section className="panel convergence">
    <div className="panel-heading"><h3><TermTooltip term="convergence"/></h3><span className="legend"><i/>最佳续航估算</span></div>
    <Plot run={run} kind="convergence"/>
    <div className="chart-footer"><span>累计候选评估</span><span>运行时间 <strong>{clock(run?.elapsed_sec ?? 0)}</strong></span></div>
  </section>;
}

export function Pareto({ run, lineage }: { run: Run | null; lineage: ReadonlyMap<string, LineageDiff> }) {
  return <section className="panel">
    <div className="panel-heading"><h3><TermTooltip term="multi_objective"/></h3><span className="legend"><i/>{PARETO_FRONT_LABEL}</span></div>
    <Plot run={run} kind="pareto" lineage={lineage}/>
  </section>;
}
