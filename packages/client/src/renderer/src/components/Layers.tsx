import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

/* ───────────── tooltip ───────────── */

export function Tooltip({ text, side = 'top', children, wrap }: { text: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left'; children: ReactElement<any>; wrap?: boolean }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!rect || !ref.current) return;
    const t = ref.current.getBoundingClientRect();
    const gap = 8;
    let left = 0;
    let top = 0;
    if (side === 'top') {
      left = rect.left + rect.width / 2 - t.width / 2;
      top = rect.top - t.height - gap;
    } else if (side === 'bottom') {
      left = rect.left + rect.width / 2 - t.width / 2;
      top = rect.bottom + gap;
    } else if (side === 'right') {
      left = rect.right + gap + 4;
      top = rect.top + rect.height / 2 - t.height / 2;
    } else {
      left = rect.left - t.width - gap;
      top = rect.top + rect.height / 2 - t.height / 2;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
    top = Math.max(8, top);
    setPos({ left, top });
  }, [rect, side]);

  if (!text) return children;
  const child = cloneElement(children, {
    onMouseEnter: (e: React.MouseEvent) => {
      children.props.onMouseEnter?.(e);
      setRect((e.currentTarget as HTMLElement).getBoundingClientRect());
    },
    onMouseLeave: (e: React.MouseEvent) => {
      children.props.onMouseLeave?.(e);
      setRect(null);
      setPos(null);
    },
    onMouseDown: (e: React.MouseEvent) => {
      children.props.onMouseDown?.(e);
      setRect(null);
      setPos(null);
    },
  });
  return (
    <>
      {child}
      {rect &&
        createPortal(
          <div ref={ref} className={`tooltip${wrap ? ' wrap' : ''}`} style={pos ?? { left: -9999, top: -9999 }}>
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ───────────── context menus & popouts ───────────── */

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; icon?: ReactNode; checked?: boolean; disabled?: boolean }
  | { separator: true }
  /** Arbitrary content (e.g. a slider); clicking it doesn't close the menu. */
  | { render: () => ReactNode }
  | null
  | false
  | undefined;

interface LayerState {
  menu: { x: number; y: number; items: MenuItem[] } | null;
  popout: { rect: DOMRect; side: 'right' | 'left' | 'top' | 'bottom'; render: () => ReactNode; key: string } | null;
}
export const useLayers = create<LayerState>(() => ({ menu: null, popout: null }));

export function openContextMenu(e: React.MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  useLayers.setState({ menu: { x: e.clientX, y: e.clientY, items }, popout: null });
}

export function openPopout(e: React.MouseEvent | DOMRect, key: string, render: () => ReactNode, side: 'right' | 'left' | 'top' | 'bottom' = 'right') {
  const rect = e instanceof DOMRect ? e : (e.currentTarget as HTMLElement).getBoundingClientRect();
  if (!(e instanceof DOMRect)) e.stopPropagation();
  const cur = useLayers.getState().popout;
  if (cur?.key === key) return closeLayers();
  useLayers.setState({ popout: { rect, side, render, key }, menu: null });
}

export function closeLayers() {
  useLayers.setState({ menu: null, popout: null });
}

function clampToViewport(el: HTMLElement, x: number, y: number) {
  const r = el.getBoundingClientRect();
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
  };
}

function ContextMenuView() {
  const menu = useLayers((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (menu && ref.current) setPos(clampToViewport(ref.current, menu.x, menu.y));
    else setPos(null);
  }, [menu]);
  if (!menu) return null;
  const items = menu.items.filter(Boolean) as Exclude<MenuItem, null | false | undefined>[];
  // Drop leading/trailing/double separators.
  const clean = items.filter((it, i) => !('separator' in it) || (i > 0 && i < items.length - 1 && !('separator' in items[i - 1])));
  return (
    <div ref={ref} className="context-menu" style={pos ?? { left: menu.x, top: menu.y, visibility: 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      {clean.map((it, i) =>
        'separator' in it ? (
          <div key={i} className="cm-sep" />
        ) : 'render' in it ? (
          <div key={i} className="cm-custom">{it.render()}</div>
        ) : (
          <button
            key={i}
            className={`cm-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            style={it.disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
            onClick={() => {
              if (it.disabled) return;
              closeLayers();
              it.onClick();
            }}
          >
            {it.label}
            {it.checked !== undefined ? (
              <span className="cm-right">
                <span className={`cm-check${it.checked ? ' on' : ''}`}>{it.checked ? '✓' : ''}</span>
              </span>
            ) : (
              it.icon && <span className="cm-right">{it.icon}</span>
            )}
          </button>
        ),
      )}
    </div>
  );
}

function PopoutView() {
  const popout = useLayers((s) => s.popout);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!popout || !ref.current) return setPos(null);
    const r = popout.rect;
    const el = ref.current.getBoundingClientRect();
    let x = r.right + 8;
    let y = r.top;
    if (popout.side === 'left') x = r.left - el.width - 8;
    if (popout.side === 'top') {
      x = r.left;
      y = r.top - el.height - 8;
    }
    if (popout.side === 'bottom') {
      x = r.left;
      y = r.bottom + 8;
    }
    setPos(clampToViewport(ref.current, x, y));
  }, [popout]);
  if (!popout) return null;
  return (
    <div ref={ref} className="popout" style={pos ?? { left: -9999, top: -9999 }} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      {popout.render()}
    </div>
  );
}

export function LayerHost() {
  const open = useLayers((s) => !!s.menu || !!s.popout);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeLayers();
    const onDown = () => closeLayers();
    const onBlur = () => closeLayers();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);
  return createPortal(
    <div onMouseDown={(e) => e.stopPropagation()}>
      <ContextMenuView />
      <PopoutView />
    </div>,
    document.body,
  );
}
