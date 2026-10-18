import { ScenesStep } from '@/features/scenes/ScenesStep';
import { detectedStatus, useDetected } from '@/data/detected';
import { Loadable, ScenesSkeleton } from '@/ui';

export default function Scenes() {
  const detected = useDetected();
  const status = detectedStatus();
  // Ready once the detected file is in, or it is known to be missing (the sample boxes then apply).
  const ready = !!detected || status === 'ready' || status === 'missing';
  return (
    <Loadable ready={ready} skeleton={<ScenesSkeleton />}>
      <ScenesStep />
    </Loadable>
  );
}
