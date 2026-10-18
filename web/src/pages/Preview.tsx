import { PreviewStep } from '@/features/preview/PreviewStep';
import { Loadable, PreviewsSkeleton } from '@/ui';

export default function Preview() {
  return (
    <Loadable ready skeleton={<PreviewsSkeleton />}>
      <PreviewStep />
    </Loadable>
  );
}
