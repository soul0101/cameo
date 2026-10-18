import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { List, X } from '@phosphor-icons/react';
import { EASE } from '@/lib/motion';
import { useFocusTrap } from '@/ui';
import { SidebarContent } from './Sidebar';
import { sectionById } from './sections';
import type { SectionId } from './sections';
import { useShell } from './store';

/** ≤768: a top app bar with the section name and a menu button that opens the sidebar as a sheet. */
export function MobileBar({ projectId, current }: { projectId: string; current: SectionId | null }) {
  const open = useShell((s) => s.mobileNav);
  const set = useShell((s) => s.set);
  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b border-border bg-bg/85 px-2 backdrop-blur-md md:hidden">
        <button type="button" onClick={() => set({ mobileNav: true })} aria-label="Open navigation" aria-expanded={open} className="inline-flex size-11 items-center justify-center rounded-[10px] text-text hover:bg-surface-3">
          <List size={22} />
        </button>
        <p className="min-w-0 flex-1 truncate text-16 font-semibold text-text">{current ? sectionById[current].label : 'Cameo'}</p>
      </header>
      <NavSheet open={open} onClose={() => set({ mobileNav: false })} projectId={projectId} current={current} />
    </>
  );
}

function NavSheet({ open, onClose, projectId, current }: { open: boolean; onClose: () => void; projectId: string; current: SectionId | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open, onClose);
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60] md:hidden">
          <motion.div aria-hidden className="absolute inset-0 bg-black/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onClose} />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            initial={{ x: '-104%' }}
            animate={{ x: 0 }}
            exit={{ x: '-104%' }}
            transition={{ duration: 0.28, ease: EASE }}
            className="surface absolute top-2 bottom-2 left-2 w-[min(300px,calc(100vw-56px))] overflow-hidden"
          >
            <button type="button" onClick={onClose} aria-label="Close navigation" className="absolute top-1 right-1 z-10 inline-flex size-11 items-center justify-center rounded-[10px] text-text-3 hover:bg-surface-3 hover:text-text">
              <X size={18} />
            </button>
            <SidebarContent projectId={projectId} current={current} collapsed={false} onNavigate={onClose} />
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
