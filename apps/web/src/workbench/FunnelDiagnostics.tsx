import { Check, Lightbulb } from 'lucide-react';
import type { Run } from '../api';
import { TermTooltip } from '../components/TermTooltip';
import { aggregateViolations, formatStopReason, isInitialScreenRejection } from './analytics';
import { GLOSSARY, evaluationLevelLabel } from './glossary';

const percentage = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });

export function FunnelDiagnostics({ run }: { run: Run }) {
  const initialRejections = run.candidates.filter(isInitialScreenRejection);
  const reasons = aggregateViolations(initialRejections).slice(0, 4);
  const mostFrequent = reasons[0];
  const stopReason = formatStopReason(run.stop_reason);
  const mode = run.request.evaluation_mode;
  const stages = [
    { key: 'generated', label: '已生成', used: run.next_index, limit: run.budget.max_generations * run.budget.batch_size },
    { key: 'l1', label: evaluationLevelLabel('L1', mode), term: 'l1_screen', used: run.l1_used, limit: run.budget.max_l1_evals },
    { key: 'l2', label: evaluationLevelLabel('L2', mode), term: 'l2_sim', used: run.l2_used, limit: run.budget.max_l2_evals },
  ] as const;

  return <section className="panel funnel-diagnostics" aria-labelledby="funnel-heading">
    <div className="panel-heading"><h3 id="funnel-heading">漏斗透视</h3></div>
    <div className="funnel-columns">
      <div className="funnel-progress">
        <ol aria-label="候选评估进度">
          {stages.map(stage => <li key={stage.key} data-funnel-stage={stage.key}>
            <div className="funnel-progress-label">
              <strong>{'term' in stage ? <TermTooltip term={stage.term} inlineLabel={stage.label}/> : stage.label}</strong>
              <span>{stage.used} / {stage.limit}</span>
            </div>
            <progress aria-label={stage.label} max={stage.limit || 1} value={Math.min(stage.used, stage.limit)}/>
          </li>)}
        </ol>
        <div className="funnel-outcomes">
          <span>通过评估 <strong>{run.passed}</strong></span>
          <span><TermTooltip term="pareto"/> <strong>{run.pareto_ids.length}</strong></span>
        </div>
        <p className="funnel-caption">每关预算按实际执行次数计算。{GLOSSARY.cache_hits.uiLabel}会省去一次重复计算。</p>
        {stopReason && <p className="funnel-stop"><Check size={15} aria-hidden="true"/>{stopReason}</p>}
      </div>
      <div className="funnel-reasons">
        <h4>初筛淘汰原因 Top 4</h4>
        {reasons.length ? <>
          <p className="funnel-caption">{initialRejections.length} 个候选被初筛淘汰，同一候选可能触发多条规则。</p>
          <ol>
            {reasons.map(({ rule, label, sampleMessage, ratio, count }) => <li key={rule} title={sampleMessage}>
              <div className="funnel-progress-label"><span>{label}</span><strong>{count} 个 · {percentage.format(ratio)}</strong></div>
              <div className="funnel-reason-track" aria-hidden="true"><span style={{ width: `${ratio * 100}%` }}/></div>
            </li>)}
          </ol>
          {mostFrequent.ratio > 0.6 && <p className="funnel-tip"><Lightbulb size={16} aria-hidden="true"/>
            <span>多数初筛淘汰涉及{mostFrequent.label}。可先在候选详情中核对实际值和阈值，再调整对应的约束或搜索范围。</span></p>}
        </> : <p className="funnel-caption">{initialRejections.length ? '当前的淘汰记录暂无具体原因。' : '当前没有候选在初筛中因约束被淘汰。'}</p>}
      </div>
    </div>
  </section>;
}
