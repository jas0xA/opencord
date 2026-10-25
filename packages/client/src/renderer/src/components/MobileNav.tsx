import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { useStore } from '../lib/store';

/**
 * Phone layout: the server rail, channel list and user panel live in a drawer opened from the
 * title bar. Hidden on wider screens by CSS. Navigating closes the drawer.
 */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const route = useStore((s) => s.route);
  useEffect(() => {
    document.documentElement.classList.toggle('mobile-nav-open', open);
  }, [open]);
  useEffect(() => setOpen(false), [JSON.stringify(route)]);
  return (
    <>
      <button className="mobile-nav-btn" aria-label="Menu" onClick={() => setOpen(!open)}>
        <Menu size={20} />
      </button>
      {open && <div className="mobile-nav-backdrop" onClick={() => setOpen(false)} />}
    </>
  );
}
