import { RenderStep } from '@/features/render/RenderStep';
import { Loadable, PreviewsSkeleton } from '@/ui';

export default function Render() {
  return (
    <Loadable ready skeleton={<PreviewsSkeleton />}>
      <RenderStep />
    </Loadable>
  );
}
