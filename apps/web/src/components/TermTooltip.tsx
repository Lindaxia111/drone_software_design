import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { GLOSSARY, type TermKey } from '../workbench/glossary';

export function TermTooltip({ term, inlineLabel, showIconOnly = false }: {
  term: TermKey;
  inlineLabel?: string;
  showIconOnly?: boolean;
}) {
  const entry = GLOSSARY[term];
  const label = inlineLabel ?? entry.uiLabel;
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const open = pinned || (!dismissed && (hovered || focused));
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  function stopLeaving() { clearTimeout(leaveTimer.current); }
  function leave() {
    stopLeaving();
    leaveTimer.current = setTimeout(() => setHovered(false), 180);
  }

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      if (!trigger.current || !bubble.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const box = bubble.current.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      const roomBelow = height - anchor.bottom;
      const flip = roomBelow < box.height + 12 && anchor.top > roomBelow;
      setPosition({
        left: Math.max(8, Math.min(width - box.width - 8, anchor.left + (anchor.width - box.width) / 2)),
        top: Math.max(8, Math.min(height - box.height - 8, flip ? anchor.top - box.height - 8 : anchor.bottom + 8)),
      });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function dismiss() { setPinned(false); setDismissed(true); }
    function onEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (trigger.current?.contains(document.activeElement)) {
        event.preventDefault();
        event.stopPropagation();
      }
      dismiss();
    }
    function onOutside(event: PointerEvent) {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !bubble.current?.contains(event.target)) dismiss();
    }
    document.addEventListener('keydown', onEscape, true);
    document.addEventListener('pointerdown', onOutside);
    return () => {
      document.removeEventListener('keydown', onEscape, true);
      document.removeEventListener('pointerdown', onOutside);
    };
  }, [open]);

  return <span className="term-tooltip">
    {!showIconOnly && <span>{label}</span>}
    <button type="button" ref={trigger} className="term-tooltip-trigger" aria-label={`了解${label}`}
      aria-describedby={open ? id : undefined}
      onPointerEnter={event => { if (event.pointerType !== 'touch') { stopLeaving(); setHovered(true); setDismissed(false); } }}
      onPointerLeave={leave}
      onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)}
      onClick={event => { event.stopPropagation(); setDismissed(pinned); setPinned(!pinned); }}>?</button>
    {open && createPortal(<span ref={bubble} role="tooltip" id={id} className="term-tooltip-bubble" style={position} onPointerEnter={stopLeaving} onPointerLeave={leave}>
      <strong>{label}</strong><small>{entry.techTerm}</small><span>{entry.plainDesc}</span>
      {entry.decisionTip && <span>{entry.decisionTip}</span>}
    </span>, trigger.current?.closest('dialog') ?? document.body)}
  </span>;
}
