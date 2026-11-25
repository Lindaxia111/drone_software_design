import { Plus, Trash2 } from 'lucide-react';
import type { Constraint, DesignGoal, Objective, SearchParameter } from '../contracts';
import { asInputNumber, SEARCH_PARAMETERS, validSearchBounds } from '../workbench/experimentForm';
import { METRIC_META, type MetricKey } from '../workbench/metricMeta';

const metrics = Object.keys(METRIC_META) as MetricKey[];
const defaultOperator = (metric: MetricKey): Constraint['operator'] => METRIC_META[metric].direction === 'maximize' ? '>=' : '<=';

export function GoalRulesEditor({ goal, onChange, searchOpen, onSearchToggle }: {
  goal: DesignGoal;
  onChange: (patch: Partial<DesignGoal>) => void;
  searchOpen: boolean;
  onSearchToggle: (open: boolean) => void;
}) {
  const { objectives, constraints, search_space } = goal;
  const availableMetrics = metrics.filter(metric => !objectives.some(objective => objective.metric === metric));
  const availablePaths = Object.keys(SEARCH_PARAMETERS).filter(path => !search_space.some(parameter => parameter.param_path === path));
  const updateObjective = (index: number, patch: Partial<Objective>) => onChange({ objectives: objectives.map((item, i) => i === index ? { ...item, ...patch } : item) });
  const updateConstraint = (index: number, patch: Partial<Constraint>) => onChange({ constraints: constraints.map((item, i) => i === index ? { ...item, ...patch } : item) });
  const updateParameter = (index: number, patch: Partial<SearchParameter>) => onChange({ search_space: search_space.map((item, i) => i === index ? { ...item, ...patch } : item) });

  function addObjective() {
    const metric = availableMetrics[0];
    if (metric) onChange({ objectives: [...objectives, { metric, direction: METRIC_META[metric].direction, weight: 1 }] });
  }
  function addConstraint() {
    const metric = metrics.find(key => !constraints.some(item => item.metric === key)) ?? metrics[0];
    onChange({ constraints: [...constraints, { metric, operator: defaultOperator(metric), limit: NaN }] });
  }
  function addParameter() {
    const param_path = availablePaths[0];
    if (param_path) onChange({ search_space: [...search_space, { param_path, type: 'continuous', bounds: [...SEARCH_PARAMETERS[param_path].bounds] }] });
  }

  return <>
    <section className="experiment-editor" aria-label="优化目标配置">
      <div className="experiment-editor-heading"><h3>优化目标</h3><button type="button" className="button secondary compact" disabled={objectives.length >= 5} onClick={addObjective}><Plus size={14}/>添加目标</button></div>
      {objectives.map((objective, i) => <div className="goal-editor-row" key={i} role="group" aria-label={`目标 ${i + 1}`}>
        <label>目标指标<select aria-label="目标指标" value={objective.metric} onChange={e => {
          const metric = e.target.value as MetricKey;
          updateObjective(i, { metric, direction: METRIC_META[metric].direction });
        }}>{metrics.filter(metric => metric === objective.metric || availableMetrics.includes(metric)).map(metric => <option key={metric} value={metric}>{METRIC_META[metric].label}</option>)}</select></label>
        <label>优化方向<select aria-label="优化方向" value={objective.direction} onChange={e => updateObjective(i, { direction: e.target.value as Objective['direction'] })}>
          <option value="maximize">越大越好</option><option value="minimize">越小越好</option></select></label>
        <label>权重<input type="number" min="0" step="any" value={asInputNumber(objective.weight)} onChange={e => updateObjective(i, { weight: e.target.valueAsNumber })}/></label>
        <button type="button" className="icon-button" disabled={objectives.length === 1} aria-label={`删除目标 ${i + 1}`} onClick={() => onChange({ objectives: objectives.filter((_, index) => index !== i) })}><Trash2 size={15}/></button>
      </div>)}
    </section>
    <section className="experiment-editor" aria-label="淘汰约束配置">
      <div className="experiment-editor-heading"><h3>淘汰约束</h3><button type="button" className="button secondary compact" disabled={constraints.length >= 20} onClick={addConstraint}><Plus size={14}/>添加约束</button></div>
      {constraints.map((constraint, i) => <div className="goal-editor-row" key={i} role="group" aria-label={`约束 ${i + 1}`}>
        <label>约束指标<select aria-label="约束指标" value={constraint.metric} onChange={e => {
          const metric = e.target.value as MetricKey;
          updateConstraint(i, { metric, operator: defaultOperator(metric), limit: NaN });
        }}>{metrics.map(metric => <option key={metric} value={metric}>{METRIC_META[metric].label}</option>)}</select></label>
        <label>比较条件<select aria-label="比较条件" value={constraint.operator} onChange={e => updateConstraint(i, { operator: e.target.value as Constraint['operator'] })}>
          <option value="&lt;=">≤ 不超过</option><option value="&gt;=">≥ 不低于</option><option value="==">= 等于</option></select></label>
        <label>限值 / {METRIC_META[constraint.metric].unit || '无量纲'}<input type="number" step="any" value={asInputNumber(constraint.limit)}
          onChange={e => updateConstraint(i, { limit: e.target.valueAsNumber })}/></label>
        <button type="button" className="icon-button" aria-label={`删除约束 ${i + 1}`} onClick={() => onChange({ constraints: constraints.filter((_, index) => index !== i) })}><Trash2 size={15}/></button>
      </div>)}
    </section>
    <details className="experiment-search" open={searchOpen} onToggle={e => onSearchToggle(e.currentTarget.open)}>
      <summary>搜索参数范围 <span className="count">{search_space.length} 项</span></summary>
      {search_space.map((parameter, i) => {
        const unit = SEARCH_PARAMETERS[parameter.param_path]?.unit;
        const valid = validSearchBounds(parameter.bounds);
        return <div className="goal-editor-row" key={i} role="group" aria-label={`搜索参数 ${i + 1}`}>
          <label>搜索参数<select aria-label="搜索参数" value={parameter.param_path} onChange={e => {
            const param_path = e.target.value;
            updateParameter(i, { param_path, bounds: [...SEARCH_PARAMETERS[param_path].bounds] });
          }}>
            <option value={parameter.param_path}>{SEARCH_PARAMETERS[parameter.param_path]?.label ?? parameter.param_path}</option>
            {availablePaths.map(path => <option key={path} value={path}>{SEARCH_PARAMETERS[path].label}</option>)}
          </select></label>
          {(['下界', '上界'] as const).map((label, bound) => <label key={label}>{label}{unit ? ` / ${unit}` : ''}
            <input type="number" min="0" step="any" aria-invalid={!valid} value={asInputNumber(parameter.bounds[bound])} onChange={e => {
              const bounds: SearchParameter['bounds'] = [...parameter.bounds];
              bounds[bound] = e.target.valueAsNumber;
              updateParameter(i, { bounds });
            }}/></label>)}
          <button type="button" className="icon-button" aria-label={`删除搜索参数 ${i + 1}`} onClick={() => onChange({ search_space: search_space.filter((_, index) => index !== i) })}><Trash2 size={15}/></button>
        </div>;
      })}
      <button type="button" className="button secondary compact" disabled={!availablePaths.length} onClick={addParameter}><Plus size={14}/>添加搜索参数</button>
    </details>
  </>;
}
