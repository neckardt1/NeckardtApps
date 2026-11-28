import { useImperativeHandle, useLayoutEffect, useRef, type PointerEvent, type Ref } from 'react';
import type { DueCard } from './review-session.ts';
import { FormattedText } from './FormattedText.tsx';

type Drag = { id: number; x: number; y: number; width: number; origin: number; axis?: 'x' | 'y' };
const isBack = (angle: number) => Math.abs(Math.round(angle / 180) % 2) === 1;

export function ReviewCard({ card, index, count, revealed, disabled, entering, showFace, flipRef }: {
  card: DueCard; index: number; count: number; revealed: boolean; disabled: boolean;
  entering: boolean; showFace: (back: boolean, focus: boolean) => void; flipRef: Ref<() => void>;
}) {
  const rotor = useRef<HTMLDivElement>(null);
  const angle = useRef(revealed ? 180 : 0);
  const drag = useRef<Drag | null>(null);
  const firstFlip = useRef<number | null>(null);
  // Capture entrance only when a different card actually mounts.
  const slideIn = useRef(entering).current;

  function rotate(degrees: number) {
    rotor.current!.style.transform = `rotateY(${degrees}deg)`;
  }
  useLayoutEffect(() => {
    if (disabled) return;
    // Restore the durable face on resume, external updates or a failed write.
    if (isBack(angle.current) !== revealed) angle.current += revealed ? 180 : -180;
    drag.current = null;
    delete rotor.current!.dataset.dragging;
    rotate(angle.current);
  }, [revealed, disabled]);

  function settle(degrees: number, focus = false) {
    angle.current = degrees;
    rotate(degrees);
    const back = isBack(degrees);
    if (back !== revealed) {
      firstFlip.current ??= performance.now();
      showFace(back, focus);
    }
  }
  function canFlip() {
    return !disabled && (firstFlip.current === null || performance.now() - firstFlip.current >= 100);
  }
  function flip(focus = false) {
    if (canFlip()) settle(angle.current + (revealed ? -180 : 180), focus);
  }
  useImperativeHandle(flipRef, () => () => flip(true));

  function down(event: PointerEvent<HTMLDivElement>) {
    if (!canFlip() || !event.isPrimary || event.button !== 0 || (event.target as Element).closest('a')) return;
    const width = window.visualViewport?.width || window.innerWidth;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width, origin: angle.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const gesture = drag.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 6) {
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (gesture.axis === 'x') {
        // Pick up an interrupted CSS transition at its current visual angle.
        const transform = getComputedStyle(rotor.current!).transform;
        if (transform !== 'none') {
          const matrix = new DOMMatrixReadOnly(transform);
          const visible = Math.atan2(-matrix.m13, matrix.m11) * 180 / Math.PI;
          gesture.origin = visible + 360 * Math.round((angle.current - visible) / 360);
        }
        rotor.current!.dataset.dragging = '';
      }
    }
    if (gesture.axis === 'x') rotate(gesture.origin + dx * 720 / gesture.width);
  }
  function end(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const gesture = drag.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    drag.current = null;
    delete rotor.current!.dataset.dragging;
    if (cancelled) rotate(angle.current);
    else if (gesture.axis === 'x') {
      const degrees = gesture.origin + (event.clientX - gesture.x) * 720 / gesture.width;
      settle(Math.round(degrees / 180) * 180);
    } else if (!gesture.axis) flip();
  }

  return <div className={'review-card flip-scene' + (slideIn ? ' card-enter' : '')}>
    <p className="eyebrow">Card {index + 1} of {count}</p>
    <div className="card-surface" onPointerDown={down} onPointerMove={move} onPointerUp={end}
      onPointerCancel={event => end(event, true)} onLostPointerCapture={event => end(event, true)}>
      <div className="card-rotor" ref={rotor}>
        <div className="card-face" inert={revealed}><h1 className="prompt">{card.front}</h1></div>
        <div className="card-face card-back" inert={!revealed}>
          <h1 className="prompt">{card.front}</h1>
          <div className="answer-panel" aria-label="Answer"><FormattedText text={card.back} /></div>
        </div>
      </div>
    </div>
  </div>;
}
