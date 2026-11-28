import { useEffect, useRef } from "react";

type Direction = "left" | "right";

export function useTaskSwipe(onSwipe: (side: Direction) => void) {
  const wrapper = useRef<HTMLDivElement>(null);
  const callback = useRef(onSwipe);
  callback.current = onSwipe;

  useEffect(() => {
    const element = wrapper.current!;
    const row = element.querySelector<HTMLElement>(".tasks-row")!;
    const listeners = new AbortController();
    const passive = { passive: true, signal: listeners.signal };
    const active = { passive: false, signal: listeners.signal };
    let gesture: {
      kind: "pointer" | "touch"; id: number; x: number; y: number;
      lastX: number; lastY: number; scroll: number; locked: boolean;
      reducedMotion: boolean; listeners: AbortController;
    } | null = null;
    let frame = 0;
    let offset = 0;
    let suppressClick = false;

    function reset() {
      const previous = gesture;
      gesture = null;
      previous?.listeners.abort();
      cancelAnimationFrame(frame);
      frame = 0;
      delete element.dataset.swipe;
      row.style.removeProperty("transform");
      if (previous?.kind === "pointer" && element.hasPointerCapture(previous.id)) element.releasePointerCapture(previous.id);
    }

    function start(kind: "touch" | "pointer", id: number, x: number, y: number) {
      reset();
      suppressClick = false;
      const listeners = new AbortController();
      gesture = { kind, id, x, y, lastX: x, lastY: y, scroll: window.scrollY, locked: false,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, listeners };
      window.addEventListener("blur", reset, { signal: listeners.signal });
      return listeners.signal;
    }

    function move(x: number, y: number, touchEvent?: TouchEvent) {
      if (!gesture) return;
      const dx = x - gesture.x;
      const horizontal = Math.abs(dx), vertical = Math.abs(y - gesture.y);
      if (!gesture.locked) {
        const stepX = Math.abs(x - gesture.lastX), stepY = Math.abs(y - gesture.lastY);
        gesture.lastX = x;
        gesture.lastY = y;
        if (Math.max(horizontal, vertical) < 12) return;
        // A deliberate vertical movement belongs to native scrolling. Once sideways
        // intent is established the finger can arc vertically without losing the row.
        if (vertical > horizontal * 2.2 || (vertical >= horizontal && stepY >= 4 && stepY > stepX * 2.2)) {
          reset();
          return;
        }
      }
      if (touchEvent) {
        if (!touchEvent.cancelable || (!gesture.locked && Math.abs(window.scrollY - gesture.scroll) > 18)) {
          reset();
          return;
        }
        touchEvent.preventDefault();
      }
      if (!gesture.locked) {
        if (horizontal < 15 || horizontal < vertical * 0.85) return;
        if (touchEvent && window.scrollY !== gesture.scroll) window.scrollTo({ top: gesture.scroll, behavior: "instant" });
        gesture.locked = true;
        if (gesture.kind === "pointer") element.setPointerCapture(gesture.id);
      }
      element.dataset.swipe = dx < 0 ? "left" : "right";
      if (gesture.reducedMotion) return;
      offset = Math.sign(dx) * (Math.min(horizontal, 72) + Math.min(36, Math.max(0, horizontal - 72) * 0.32));
      if (!frame) frame = requestAnimationFrame(() => {
        row.style.transform = `translate3d(${offset}px,0,0)`;
        frame = 0;
      });
    }

    function finish(x: number, event: Event) {
      if (!gesture) return;
      const dx = x - gesture.x;
      const locked = gesture.locked;
      if (locked) {
        suppressClick = true;
        if (event.cancelable) event.preventDefault();
      }
      reset();
      if (locked && Math.abs(dx) >= 48) callback.current(dx < 0 ? "left" : "right");
    }

    element.addEventListener("touchstart", event => {
      if (event.touches.length !== 1) return reset();
      const finger = event.changedTouches[0];
      const signal = start("touch", finger.identifier, finger.clientX, finger.clientY);
      document.addEventListener("touchstart", next => {
        if (next.touches.length > 1) reset();
      }, { signal, passive: true, capture: true });
    }, passive);
    // Safari needs a cancelable native touchmove on the row to keep a curved
    // horizontal swipe. A passive React handler or pointermove alone loses it.
    element.addEventListener("touchmove", event => {
      if (gesture?.kind !== "touch") return;
      const finger = event.touches[0];
      if (event.touches.length !== 1 || finger.identifier !== gesture.id) return reset();
      move(finger.clientX, finger.clientY, event);
    }, active);
    element.addEventListener("touchend", event => {
      if (gesture?.kind !== "touch") return;
      const finger = event.changedTouches[0];
      if (event.touches.length || finger.identifier !== gesture.id) return reset();
      finish(finger.clientX, event);
    }, active);
    element.addEventListener("touchcancel", reset, passive);
    element.addEventListener("pointerdown", event => {
      if (gesture || event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return;
      const signal = start("pointer", event.pointerId, event.clientX, event.clientY);
      document.addEventListener("pointermove", next => {
        if (next.pointerId === event.pointerId) move(next.clientX, next.clientY);
      }, { signal });
      document.addEventListener("pointerup", next => {
        if (next.pointerId === event.pointerId) finish(next.clientX, next);
      }, { signal });
      document.addEventListener("pointercancel", reset, { signal });
      element.addEventListener("lostpointercapture", reset, { signal });
    }, passive);
    element.addEventListener("click", event => {
      if (suppressClick && event.detail > 0) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick = false;
      }
    }, { capture: true, signal: listeners.signal });
    return () => { listeners.abort(); reset(); };
  }, []);
  return wrapper;
}
