import { useEffect, useState, type MutableRefObject } from 'react';
import { Pause, Play } from 'lucide-react';
import type { TestScenario } from '../contracts';

const SPEEDS = [0.5, 1, 2];
const seconds = (value: number) => `${value.toFixed(2)} s`;

export function ReplayBar({ start, end, scenario, timeRef }: {
  start: number;
  end: number;
  scenario: TestScenario;
  timeRef: MutableRefObject<number>;
}) {
  const [time, setTime] = useState(() => Math.min(end, Math.max(start, timeRef.current)));
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const duration = end - start;
  const markers = [
    ...(scenario.mission.type === 'step_response' ? [{ time: scenario.mission.step_time_s, title: '突跃时刻', kind: 'step' }] : []),
    ...scenario.fault_injections.map(fault => ({ time: fault.trigger_time_s, title: `${fault.target_rotor_id} 故障触发`, kind: 'fault' })),
  ].sort((a, b) => a.time - b.time);

  useEffect(() => {
    timeRef.current = Math.min(end, Math.max(start, timeRef.current));
    setTime(timeRef.current);
  }, [start, end, timeRef]);

  useEffect(() => {
    if (!playing) return;
    let previous = performance.now();
    let frame = requestAnimationFrame(advance);
    function advance(now: number) {
      const elapsed = Math.max(0, now - previous) / 1000;
      previous = now;
      if (!document.hidden && elapsed < 0.5) {
        const next = Math.min(end, timeRef.current + elapsed * speed);
        timeRef.current = next;
        setTime(next);
        if (next >= end) { setPlaying(false); return; }
      }
      frame = requestAnimationFrame(advance);
    }
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, end, timeRef]);

  function seek(next: number) {
    timeRef.current = next;
    setTime(next);
    setPlaying(false);
  }

  return <section className="replay-bar" aria-label="飞行回放控制">
    <div className="replay-controls">
      <button type="button" className="button primary compact" disabled={duration <= 0} onClick={() => {
        if (!playing && time >= end) seek(start);
        setPlaying(!playing);
      }}>{playing ? <Pause size={15}/> : <Play size={15}/>} {playing ? '暂停回放' : '播放回放'}</button>
      <label>播放倍速<select aria-label="播放倍速" value={speed} onChange={event => setSpeed(Number(event.target.value))}>
        {SPEEDS.map(rate => <option key={rate} value={rate}>{rate}×</option>)}
      </select></label>
      <output className="replay-time" aria-label="当前回放时间" aria-live="off">{seconds(time)} / {seconds(end)}</output>
    </div>
    <div className="replay-timeline">
      <input type="range" step="any" min={start} max={end} value={time} disabled={duration <= 0} aria-label="三维回放时间轴"
        aria-valuetext={seconds(time)} onChange={event => seek(event.target.valueAsNumber)}/>
      <div className="replay-ticks" aria-hidden="true">
        {duration > 0 && markers.map((marker, index) => marker.time >= start && marker.time <= end && <span key={index} className={`replay-tick ${marker.kind}`}
          style={{ left: `${(marker.time - start) / duration * 100}%` }}/>) }
      </div>
    </div>
    {markers.length > 0 && <div className="replay-markers">{markers.map((marker, index) => {
      const outside = marker.time < start || marker.time > end;
      return <button key={index} type="button" className={`replay-marker ${marker.kind}`} disabled={outside}
        title={outside ? '超出已记录的飞行时间' : undefined} onClick={() => seek(marker.time)}>{marker.title} · {seconds(marker.time)}</button>;
    })}</div>}
  </section>;
}
