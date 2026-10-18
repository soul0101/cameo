import { WatchStep } from '@/features/watch/WatchStep';
import { Loadable, WatchSkeleton } from '@/ui';

export default function Watch() {
  return (
    <Loadable ready skeleton={<WatchSkeleton />}>
      <WatchStep />
    </Loadable>
  );
}
