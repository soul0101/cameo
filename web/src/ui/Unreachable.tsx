import { useState } from 'react';
import { ArrowClockwise } from '@phosphor-icons/react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';

/**
 * The calm state for "the API did not answer": what happened and a retry.
 */
export function Unreachable({ onRetry, className, what = 'this page' }: { onRetry: () => unknown; className?: string; what?: string }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  };
  return (
    <EmptyState
      className={className}
      title="Cameo is not answering"
      body={<>The server may be waking up (it sleeps when nobody uses it), so {what} cannot load yet. Try again in a few seconds.</>}
      actions={
        <Button variant="primary" icon={<ArrowClockwise />} loading={busy} onClick={() => void retry()}>
          Retry
        </Button>
      }
    />
  );
}
