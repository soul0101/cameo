import { AnimatePresence, motion } from 'framer-motion';
import { ArrowClockwise, CircleNotch, CloudSlash } from '@phosphor-icons/react';
import { EASE } from '@/lib/motion';
import { useHealth, useHealthPolling } from '@/services/health';
import { Button } from '@/ui';

/**
 * Across every page, a calm floating strip at the top: "Waking up Cameo" while the server starts after a quiet spell,
 * and "Backend unreachable" with a retry while `GET /health` fails. Pages keep showing what this browser saved.
 */
export function ApiBanner() {
  useHealthPolling();
  const down = useHealth((s) => s.status === 'down');
  const checking = useHealth((s) => s.checking);
  const waking = useHealth((s) => s.waking);
  return (
    <AnimatePresence>
      {waking && !down && (
        <motion.div
          key="waking"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: EASE }}
          className="pointer-events-none fixed inset-x-0 top-3 z-[85] flex justify-center px-4"
        >
          <div className="surface flex max-w-[640px] items-center gap-3 rounded-[14px] py-2.5 pr-4 pl-3.5 text-13" data-testid="waking-banner">
            <CircleNotch size={18} className="shrink-0 text-accent motion-safe:animate-spin" aria-hidden />
            <p className="min-w-0 text-text-2">
              <span className="font-medium text-text">Waking up Cameo.</span> The server sleeps when nobody is using it; this takes a few seconds.
            </p>
          </div>
        </motion.div>
      )}
      {down && (
        <motion.div
          key="down"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: EASE }}
          className="pointer-events-none fixed inset-x-0 top-3 z-[85] flex justify-center px-4"
        >
          <div className="surface pointer-events-auto flex max-w-[640px] items-center gap-3 rounded-[14px] py-2 pr-2 pl-3.5 text-13 max-sm:flex-wrap" data-testid="api-banner">
            <CloudSlash size={18} className="shrink-0 text-text-2" aria-hidden />
            <p className="min-w-0 flex-1 text-text-2">
              <span className="font-medium text-text">Backend unreachable.</span> Showing what this browser saved until it's back.
            </p>
            <Button size="sm" variant="secondary" icon={<ArrowClockwise />} loading={checking} onClick={() => void useHealth.getState().check()}>
              Retry
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
