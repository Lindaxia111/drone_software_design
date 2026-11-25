import { Plus, Trash2 } from 'lucide-react';
import type { FaultInjection, Rotor } from '../contracts';
import { asInputNumber } from '../workbench/experimentForm';
import { TermTooltip } from './TermTooltip';

export function FaultEditor({ value, rotors, duration, onChange }: {
  value: FaultInjection[];
  rotors: Rotor[];
  duration: number;
  onChange: (faults: FaultInjection[]) => void;
}) {
  function update(index: number, patch: Partial<FaultInjection>) {
    onChange(value.map((fault, i) => i === index ? { ...fault, ...patch } : fault));
  }
  function addFault() {
    if (!rotors.length) return;
    const target = rotors.find(rotor => !value.some(fault => fault.target_rotor_id === rotor.id)) ?? rotors[0];
    onChange([...value, { trigger_time_s: Math.min(2, Number.isFinite(duration) && duration > 0 ? duration / 2 : 0),
      target_rotor_id: target.id, fault_type: 'thrust_loss', severity: 0.5 }]);
  }

  return <section className="experiment-editor" aria-label="故障配置">
    <div className="experiment-editor-heading"><h3><TermTooltip term="fault_injection"/></h3>
      <button type="button" className="button secondary compact" disabled={!rotors.length || value.length >= 20} onClick={addFault}><Plus size={14}/>添加故障</button></div>
    {value.map((fault, index) => {
      const position = `故障 ${index + 1}`;
      const validRotor = rotors.some(rotor => rotor.id === fault.target_rotor_id);
      const stopped = fault.fault_type === 'motor_out';
      const percent = fault.severity * 100;
      return <div className="fault-editor-row" key={index} role="group" aria-label={position}>
        <label>触发时刻 / s<input type="number" min="0" step="any" value={asInputNumber(fault.trigger_time_s)}
          onChange={e => update(index, { trigger_time_s: e.target.valueAsNumber })}/></label>
        <label>故障旋翼<select aria-label="故障旋翼" value={fault.target_rotor_id} aria-invalid={!validRotor} onChange={e => update(index, { target_rotor_id: e.target.value })}>
          {!validRotor && <option value={fault.target_rotor_id} disabled>{fault.target_rotor_id}（当前机型没有）</option>}
          {rotors.map(rotor => <option key={rotor.id} value={rotor.id}>{rotor.id}</option>)}
        </select></label>
        <label>故障类型<select aria-label="故障类型" value={fault.fault_type} onChange={e => {
          const fault_type = e.target.value as FaultInjection['fault_type'];
          update(index, { fault_type, severity: fault_type === 'motor_out' ? 1 : 0.5 });
        }}><option value="thrust_loss">推力衰减</option><option value="motor_out">电机停转</option></select></label>
        {stopped ? <div className="fault-fixed-severity"><span>推力损失</span><strong>100%（固定）</strong></div> : <label>推力衰减 / % <strong>{Number(percent.toFixed(2))}%</strong>
          <input type="range" min="10" max="100" step="any" aria-label="推力衰减 / %" value={Math.max(10, percent)}
            onChange={e => update(index, { severity: Math.round(e.target.valueAsNumber) / 100 })}/>
          {percent < 10 && <small>原配置低于滑块范围，移动后使用 10%–100%。</small>}
        </label>}
        <button type="button" className="icon-button" aria-label={`删除${position}`} onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 size={15}/></button>
      </div>;
    })}
  </section>;
}
