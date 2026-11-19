import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Drag-and-drop mit Pointer Events (Maus, Finger, Stift – auch auf dem iPad).
 * Ziele markieren sich mit data-drop="<wert>"; beim Loslassen wird das Element unter dem Finger gesucht.
 * Ohne Bewegung (< 6 px) gilt die Geste als Tippen.
 */
export function startDrag(
  e: ReactPointerEvent,
  label: string,
  handlers: { onDrop: (target: string) => void; onTap?: () => void },
): void {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  let ghost: HTMLDivElement | null = null;
  let lastTarget: Element | null = null;
  const findTarget = (x: number, y: number) => {
    if (ghost) ghost.style.display = 'none';
    const el = document.elementFromPoint(x, y)?.closest('[data-drop]') ?? null;
    if (ghost) ghost.style.display = '';
    return el;
  };
  const move = (ev: PointerEvent) => {
    if (!ghost && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.textContent = label;
      ghost.className = 'fd-drag-ghost';
      document.body.appendChild(ghost);
    }
    ghost.style.left = `${ev.clientX}px`;
    ghost.style.top = `${ev.clientY}px`;
    const t = findTarget(ev.clientX, ev.clientY);
    if (t !== lastTarget) {
      lastTarget?.classList.remove('fd-drop-hover');
      t?.classList.add('fd-drop-hover');
      lastTarget = t;
    }
  };
  const end = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', cancel);
    lastTarget?.classList.remove('fd-drop-hover');
    if (!ghost) { handlers.onTap?.(); return; }
    ghost.remove();
    const t = findTarget(ev.clientX, ev.clientY);
    const value = t?.getAttribute('data-drop');
    if (value != null) handlers.onDrop(value);
  };
  const cancel = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', cancel);
    lastTarget?.classList.remove('fd-drop-hover');
    ghost?.remove();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', cancel);
}
