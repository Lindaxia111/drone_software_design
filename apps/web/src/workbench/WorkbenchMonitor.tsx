import { Fragment } from 'react';
import { Activity, Check, FlaskConical, Layers3, Radio, Wind } from 'lucide-react';
import type { Candidate, Run } from '../api';
import { TermTooltip } from '../components/TermTooltip';
import { formatStopReason, formatViolationValues, summarizeCandidateStatuses, violationLabel } from './analytics';
import { FunnelDiagnostics } from './FunnelDiagnostics';
import { GLOSSARY } from './glossary';
import { Convergence, Pareto } from './LinkedCharts';
import { formatLineageDelta, type LineageDiff } from './lineage';
import { formatMetric, METRIC_META } from './metricMeta';
import { useWorkbenchStore } from './state';
import { CandidatePreview } from './Studio';

export const statusNames: Record<Run['status'] | Candidate['status'], string> = {
  QUEUED: '等待计算', RUNNING: '运行中', PAUSED: '已暂停', CANCELLED: '已取消', COMPLETED: '已完成',
  NEW: '待评估', L1_PASSED: '等待第 2 关', PASSED: '通过', REJECTED_CONSTRAINT: '约束淘汰',
  SKIPPED: '预算跳过', CRASHED: '执行失败', UNSUPPORTED: '构型不支持', TIMEOUT: '超时',
};

export function Status({ value }: { value: keyof typeof statusNames }) {
  return <span className={`badge ${value.toLowerCase()}`}>{value === 'RUNNING' && <span className="pulse"/>}{statusNames[value]}</span>;
}

function MetricCell({ metric, value, delta }: { metric: 'total_mass_kg' | 'flight_time_min' | 'tracking_rmse_m'; value: number; delta?: number | null }) {
  return <td>{formatMetric(metric, value)}{delta != null && <small className="lineage-delta" aria-label={`相对父方案 ${formatLineageDelta(metric, delta)}`}>{formatLineageDelta(metric, delta)}</small>}</td>;
}

export function WorkbenchMonitor({ run, candidate, transport, lineage }: {
  run: Run;
  candidate: Candidate | undefined;
  transport: 'connecting' | 'sse' | 'poll' | 'settled';
  lineage: ReadonlyMap<string, LineageDiff>;
}) {
  const { state, patch, select, setActiveStage } = useWorkbenchStore();
  const dynamics = run.request.evaluation_mode === 'dynamics';
  const best = (metric: 'flight_time_min' | 'tracking_rmse_m', choose: (a: number, b: number) => number) => {
    const values = run.candidates.filter(c => c.status === 'PASSED').map(c => c.metrics[metric]).filter(Number.isFinite);
    return values.length ? values.reduce((current, value) => choose(current, value)) : undefined;
  };
  const target = run.budget.max_generations * run.budget.batch_size + run.candidates.filter(c => c.source === 'manual_revision').length;
  const counts = summarizeCandidateStatuses(run.candidates);
  const settled = run.candidates.length - counts.NEW - counts.L1_PASSED;
  const preferred = new Set(run.pareto_ids);
  const candidates = run.candidates.filter(c => !state.onlyPareto || preferred.has(c.candidate_id)).reverse();
  const connectionLabel = { connecting: '正在连接实时日志', sse: '实时更新', poll: '定时刷新', settled: '实时推送已结束' }[transport];

  return <>
    <FunnelDiagnostics run={run}/>
    <div className="stat-grid">
      <div className="stat-card"><div><span>已评估候选</span><Layers3 size={17}/></div><strong>{settled}<small> / {target}</small></strong><p>{run.passed} 个通过 · {run.rejected} 个约束淘汰</p></div>
      <div className="stat-card"><div><span>最佳续航估算</span><Wind size={17}/></div><strong>{formatMetric('flight_time_min', best('flight_time_min', Math.max))}</strong><p>按悬停耗电量估算</p></div>
      <div className="stat-card"><div><span>最小平均航迹偏差</span><Activity size={17}/></div><strong>{formatMetric('tracking_rmse_m', best('tracking_rmse_m', Math.min))}</strong><p>{dynamics ? '评估飞行全程的偏离程度' : '快速演示结果'}</p></div>
      <div className="stat-card pareto-card"><div><TermTooltip term="pareto"/><Radio size={17}/></div><strong>{run.pareto_ids.length}<small> 个</small></strong>
        <button className="stat-link" type="button" disabled={!run.pareto_ids.length} onClick={() => setActiveStage('compare')}>查看{GLOSSARY.pareto.uiLabel}</button></div>
    </div>
    <div className="analysis-grid">
      <Convergence run={run}/>
      <Pareto run={run} lineage={lineage}/>
    </div>
    <div className="monitor-preview"><CandidatePreview candidate={candidate}/></div>
    <section className="panel results-panel" id="candidate-results">
      <div className="panel-heading"><div className="inline-title"><h3>候选方案</h3><span className="count">{run.candidates.length}</span></div>
        <div className="candidate-filter">
          <button aria-pressed={!state.onlyPareto} onClick={() => patch({ onlyPareto: false })}>全部候选</button>
          <button aria-pressed={state.onlyPareto} onClick={() => patch({ onlyPareto: true })}>{GLOSSARY.only_pareto.uiLabel}</button>
          <TermTooltip term="only_pareto" showIconOnly/>
        </div>
      </div>
      <div className="table-scroll"><table><thead><tr>
        <th>方案</th><th>代数</th><th>{METRIC_META.total_mass_kg.label}</th><th>{METRIC_META.flight_time_min.label}</th>
        <th>{METRIC_META.tracking_rmse_m.label}</th><th>评估状态</th><th>方案评价</th><th>参数详情</th>
      </tr></thead><tbody>
        {candidates.map(c => {
          const change = lineage.get(c.candidate_id);
          return <Fragment key={c.candidate_id}>
          <tr tabIndex={0} aria-label={`查看候选 ${c.proposal_index + 1}`} className={candidate?.candidate_id === c.candidate_id ? 'focused' : ''}
            onClick={() => select(c)} onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(c); } }}>
            <td><strong>方案 {String(c.proposal_index + 1).padStart(3, '0')}</strong>
              {c.source === 'manual_revision' && <span className="lineage-badge">{GLOSSARY.manual_revision.uiLabel}</span>}
              <small>{change ? `父方案 ${change.parentIndex + 1} · ` : ''}{c.ir_hash.slice(0, 8)}</small></td>
            <td>{c.source === 'manual_revision' ? '手动' : `G${String(c.generation).padStart(2, '0')}`}</td>
            <MetricCell metric="total_mass_kg" value={c.metrics.total_mass_kg} delta={change?.deltaMassKg}/>
            <MetricCell metric="flight_time_min" value={c.metrics.flight_time_min} delta={change?.deltaFlightMin}/>
            <MetricCell metric="tracking_rmse_m" value={c.metrics.tracking_rmse_m} delta={change?.deltaRmseM}/>
            <td><Status value={c.status}/></td>
            <td>{preferred.has(c.candidate_id) ? <span className="pareto-label"><Check size={13}/>{GLOSSARY.pareto.uiLabel}</span> : '—'}</td>
            <td><button className="button secondary compact" onClick={e => { e.stopPropagation(); select(c, true); }}>查看参数</button></td>
          </tr>
          {state.selected?.candidate_id === c.candidate_id && c.violations.length > 0 && <tr className="violation-row"><td colSpan={8}>
            {c.violations.map(violation => `${violationLabel(violation.rule)}（${formatViolationValues(violation)}）`).join(' · ')}
          </td></tr>}
        </Fragment>;
        })}
        {!candidates.length && <tr><td colSpan={8}><div className="empty-state"><FlaskConical size={28}/>
          <strong>{state.onlyPareto ? '暂无优选方案' : '等待第一组候选方案'}</strong>
          {!state.onlyPareto && state.health?.worker_alive === false && <span>计算服务未响应。服务恢复后，评估结果会自动显示。</span>}
        </div></td></tr>}
      </tbody></table></div>
    </section>
    <section className="panel event-panel"><div className="panel-heading"><h3>运行日志</h3><span className="subtle" data-transport={transport}>{connectionLabel}</span></div>
      <div className="event-list">{run.events.slice(-12).reverse().map(event => <div key={event.seq}>
        <time>{new Date(event.created_at * 1000).toLocaleTimeString('zh-CN')}</time><span className={`event-kind ${event.kind.toLowerCase()}`}>{event.kind}</span>
        <span>{event.kind === 'COMPLETED' && run.stop_reason ? formatStopReason(run.stop_reason) : event.message}</span>
      </div>)}{!run.events.length && <p className="muted">暂无运行记录。</p>}</div>
    </section>
  </>;
}
