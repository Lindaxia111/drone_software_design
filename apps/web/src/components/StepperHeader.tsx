import { useEffect, useRef } from 'react';
import { ChevronDown, Download, ListChecks, Pause, Pencil, Play, RotateCcw, SlidersHorizontal, Square, Trash2, type LucideIcon } from 'lucide-react';
import type { Run } from '../api';
import { isRunning, type WorkbenchStage } from '../workbench/state';

export type RunAction = 'pause' | 'resume' | 'cancel' | 'retry';

interface Props {
  run: Run;
  activeStage: WorkbenchStage;
  busy: boolean;
  onStage: (stage: WorkbenchStage) => void;
  onConfig: () => void;
  onAdjust: () => void;
  onControl: (action: RunAction) => void;
  onRename: () => void;
  onDelete: () => void;
}

const steps: { stage: WorkbenchStage; label: string }[] = [
  { stage: 'monitor', label: '漏斗运行' },
  { stage: 'compare', label: '优选对比' },
  { stage: 'studio', label: '3D 改参' },
];

function primaryAction({ run, onAdjust, onStage, onControl }: Props): { label: string; icon: LucideIcon; act: () => void } {
  if (run.status === 'PAUSED') return { label: run.next_index === 0 ? '启动实验' : '继续运行', icon: Play, act: () => onControl('resume') };
  if (isRunning(run.status)) return { label: '暂停计算', icon: Pause, act: () => onControl('pause') };
  if (run.status === 'CANCELLED') return { label: '重新测试', icon: RotateCcw, act: () => onControl('retry') };
  if (run.pareto_ids.length) return { label: '对比优选方案', icon: ListChecks, act: () => onStage('compare') };
  return { label: '调整约束重测', icon: SlidersHorizontal, act: onAdjust };
}

export function StepperHeader(props: Props) {
  const { run, activeStage, busy, onStage, onConfig, onControl, onRename, onDelete } = props;
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const { label, icon: Icon, act } = primaryAction(props);

  useEffect(() => {
    function onOutside(event: PointerEvent) {
      if (menu.current?.open && event.target instanceof Node && !menu.current.contains(event.target)) menu.current.open = false;
    }
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, []);

  function close() {
    if (menu.current) menu.current.open = false;
    trigger.current?.focus();
  }

  return <div className="stepper-header">
    <nav aria-label="实验步骤">
      <ol className="stepper-steps">
        <li><button type="button" onClick={onConfig}><span>1</span>场景配置</button></li>
        {steps.map(({ stage, label }, index) => <li key={stage}>
          <button type="button" onClick={() => onStage(stage)} aria-current={activeStage === stage ? 'step' : undefined}><span>{index + 2}</span>{label}</button>
        </li>)}
      </ol>
    </nav>
    <div className="stepper-actions">
      <button type="button" className="button primary" disabled={busy} onClick={act}><Icon size={16}/>{label}</button>
      <details className="experiment-menu" ref={menu} onKeyDown={event => {
        if (event.key === 'Escape' && menu.current?.open) { event.stopPropagation(); close(); }
      }}>
        <summary className="button secondary" ref={trigger}>更多<ChevronDown size={16}/></summary>
        <div className="experiment-menu-items">
          <button type="button" onClick={() => { close(); onConfig(); }}><ListChecks size={16}/>实验参数</button>
          <button type="button" disabled={busy} onClick={() => { close(); onRename(); }}><Pencil size={16}/>重命名</button>
          {run.status !== 'CANCELLED' && <button type="button" disabled={busy} onClick={() => { close(); onControl('retry'); }}><RotateCcw size={16}/>重新测试</button>}
          <a href={`/api/experiments/${encodeURIComponent(run.id)}/report`} download onClick={close}><Download size={16}/>导出报告</a>
          {(isRunning(run.status) || run.status === 'PAUSED') && <button type="button" disabled={busy} onClick={() => { close(); onControl('cancel'); }}><Square size={16}/>取消实验</button>}
          <button type="button" className="danger" disabled={busy} onClick={() => { close(); onDelete(); }}><Trash2 size={16}/>删除实验</button>
        </div>
      </details>
    </div>
  </div>;
}
