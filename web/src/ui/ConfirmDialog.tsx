import { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { EASE } from '@/lib/motion';
import { Button } from './Button';
import { useFocusTrap } from './useFocusTrap';

/** Centred confirm dialog for destructive actions. Focus starts on Cancel; Esc cancels; focus returns. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(ref, open, onCancel);
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <motion.div aria-hidden className="absolute inset-0 bg-black/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onCancel} />
          <motion.div
            ref={ref}
            role="alertdialog"
            aria-modal
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="surface relative w-full max-w-[400px] rounded-[20px]! p-6 shadow-[var(--shadow-lift)]!"
          >
            <h2 id={titleId} className="text-16 font-semibold text-text">{title}</h2>
            {description && <p id={descId} className="mt-2 text-14 text-text-2">{description}</p>}
            <div className="mt-6 flex justify-end gap-2 max-md:flex-col-reverse max-md:[&>button]:h-11">
              <Button variant="ghost" onClick={onCancel} data-autofocus>{cancelLabel}</Button>
              <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
