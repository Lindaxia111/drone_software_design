import { Activity, MapPin, Play, ShieldCheck, SlidersHorizontal, Wind } from 'lucide-react';
import type { PresetSpec } from '../contracts';

const icons = {
  wind_hover_starter: Wind,
  step_agility: Activity,
  waypoint_patrol: MapPin,
  rotor_fault_tolerance: ShieldCheck,
};
const difficultyLabels: Record<PresetSpec['difficulty'], string> = {
  starter: '入门', intermediate: '进阶', advanced: '高级',
};

export function EmptyOnboarding({ presets, error, busy, onRetry, onRun, onEdit }: {
  presets: PresetSpec[] | null;
  error: string;
  busy: boolean;
  onRetry: () => void;
  onRun: (preset: PresetSpec) => void;
  onEdit: (preset: PresetSpec) => void;
}) {
  return <section className="onboarding" aria-labelledby="onboarding-heading">
    <div className="onboarding-heading">
      <h2 id="onboarding-heading">选一个场景，开始第一次实验</h2>
      <p>从一个现成的飞行任务开始，也可以先调整参数。</p>
    </div>
    {error && <div className="onboarding-unavailable" role="status">
      <p>场景模板加载失败。{error}</p>
      <button type="button" className="button secondary" onClick={onRetry}>重新加载</button>
    </div>}
    {!error && !presets && <p className="muted" role="status">正在加载场景模板…</p>}
    <div className="preset-grid">
      {presets?.map(preset => {
        const Icon = icons[preset.id as keyof typeof icons] ?? Activity;
        return <article className="preset-card" key={preset.id} aria-labelledby={`preset-${preset.id}`}>
          <div className="preset-meta"><span className="preset-icon"><Icon size={21} aria-hidden="true"/></span>
            <span>{difficultyLabels[preset.difficulty]} · 约 {preset.estimated_sec} 秒</span></div>
          <h3 id={`preset-${preset.id}`}>{preset.title}</h3>
          <p>{preset.summary}</p>
          <div className="preset-actions">
            <button type="button" className="button primary" disabled={busy} onClick={() => onRun(preset)}><Play size={15}/>一键运行</button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => onEdit(preset)}><SlidersHorizontal size={15}/>微调参数</button>
          </div>
        </article>;
      })}
    </div>
  </section>;
}
