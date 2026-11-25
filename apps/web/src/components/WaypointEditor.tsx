import { Plus, Trash2 } from 'lucide-react';
import type { Waypoint } from '../contracts';
import { asInputNumber, waypointProblem } from '../workbench/experimentForm';
import { TermTooltip } from './TermTooltip';

const POSITION_FIELDS = [
  { axis: 0, label: '向北 N / m', sign: 1 },
  { axis: 1, label: '向东 E / m', sign: 1 },
  { axis: 2, label: '离地高度 / m', sign: -1 },
] as const;

export function WaypointEditor({ value, duration, altitude, onChange }: {
  value: Waypoint[];
  duration: number;
  altitude: number;
  onChange: (waypoints: Waypoint[]) => void;
}) {
  const canGenerate = Number.isFinite(duration) && duration > 0 && Number.isFinite(altitude) && altitude > 0;
  function replace(index: number, next: Waypoint) {
    onChange(value.map((waypoint, i) => i === index ? next : waypoint));
  }
  function generate(route: 'rectangle' | 'climb') {
    const points: Waypoint['position_m'][] = route === 'rectangle'
      ? [[2, 0, -altitude], [2, 2, -altitude], [0, 2, -altitude], [0, 0, -altitude]]
      : [[0, 0, -altitude], [2, 0, -(altitude + 1)], [4, 0, -(altitude + 2)], [0, 0, -altitude]];
    const times = route === 'rectangle' ? [0.2, 0.4, 0.6, 0.8] : [0, 0.25, 0.5, 0.8];
    onChange(points.map((position_m, i) => ({ t_s: Number((duration * times[i]).toPrecision(10)), position_m })));
  }
  function addWaypoint() {
    const last = value.at(-1);
    const t_s = last ? Math.min(duration, last.t_s + 1) : 0;
    onChange([...value, { t_s, position_m: last ? [...last.position_m] : [0, 0, -altitude] }]);
  }

  return <section className="experiment-editor" aria-label="航点配置">
    <div className="experiment-editor-heading"><h3>航点 <TermTooltip term="ned_frame" showIconOnly/></h3>
      <div className="experiment-editor-actions">
        <button type="button" className="button secondary compact" disabled={!canGenerate} onClick={() => generate('rectangle')}>矩形巡检</button>
        <button type="button" className="button secondary compact" disabled={!canGenerate} onClick={() => generate('climb')}>爬升折返</button>
        <button type="button" className="button secondary compact" disabled={value.length >= 100} onClick={addWaypoint}><Plus size={14}/>添加航点</button>
      </div>
    </div>
    {value.length === 0 ? <p className="muted">选一条示例路线，或手动添加航点。</p> : <>
      <div className="table-scroll waypoint-table"><table>
        <thead><tr><th scope="col">航点</th><th scope="col">时间 / s</th>{POSITION_FIELDS.map(field => <th key={field.axis} scope="col">{field.label}</th>)}<th scope="col">操作</th></tr></thead>
        <tbody>{value.map((point, index) => <tr key={index}>
          <th scope="row">{index + 1}</th>
          <td><input type="number" min="0" max={asInputNumber(duration)} step="any" aria-label={`航点 ${index + 1} 时间 / s`}
            value={asInputNumber(point.t_s)} onChange={e => replace(index, { ...point, t_s: e.target.valueAsNumber })}/></td>
          {POSITION_FIELDS.map(({ axis, sign, label }) => <td key={axis}><input type="number" step="any" aria-label={`航点 ${index + 1} ${label}`}
            value={asInputNumber(sign * point.position_m[axis])} onChange={e => {
              const position_m: Waypoint['position_m'] = [...point.position_m];
              position_m[axis] = sign * e.target.valueAsNumber;
              replace(index, { ...point, position_m });
            }}/></td>)}
          <td><button type="button" className="icon-button" aria-label={`删除航点 ${index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 size={15}/></button></td>
        </tr>)}</tbody>
      </table></div>
      {value.map((point, i) => {
        const problem = waypointProblem(point, value[i - 1], duration);
        return problem && <p key={i} className="editor-row-error">航点 {i + 1}：{problem}</p>;
      })}
    </>}
  </section>;
}
