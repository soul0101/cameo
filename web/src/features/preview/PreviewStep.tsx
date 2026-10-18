import { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { ArrowRight, Checks, Sparkle } from '@phosphor-icons/react';
import { useBoxSync } from '@/features/scenes/model';
import { usePlacements, useApprovedVersions, useSceneVersions, versionId } from '@/store/placements';
import { Button, ConfirmDialog, EmptyState, StepTitle, toast } from '@/ui';
import { apiConfig } from '@/services/api';
import { generateStills, useStills } from './stills';
import { useWritePrompts } from './writePrompts';
import { sceneItems, scenePromptFor } from '@/store/placements';
import { useSectionNav } from './nav';
import { Stage } from './Stage';
import { AudienceTabs, VersionRail } from './VersionRail';

/**
 * Previews: the included scenes at the left; the
 * selected scene's audiences as tabs above the stage (Before / After). Nano Banana makes each After
 * still from the edit prompt. "Generate all" (after a cost confirmation) runs every version without
 * a still; "Approve all" approves every version whose still is current. Opens on the first version.
 */
export function PreviewStep() {
  useBoxSync();
  const go = useSectionNav();
  const reduce = useReducedMotion();
  const versions = useSceneVersions();
  // Gemini writes the edit prompt for every product the producer picked, now that the choices are made.
  useWritePrompts(versions);
  const approvedSet = usePlacements((s) => s.approved);
  const approved = useApprovedVersions().length;
  const stills = useStills((s) => s.stills);
  const running = useStills((s) => Object.keys(s.running).length);
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    apiConfig().then((c) => setPrice(c.imagePrice), () => undefined);
  }, []);
  const [confirmAll, setConfirmAll] = useState(false);
  // Versions with no still yet: what "Generate all" makes.
  const missing = versions.filter((v) => !stills[versionId(v)] && sceneItems(v.sceneId, v.audienceId).length > 0 && scenePromptFor(v.sceneId, v.audienceId).text.trim());
  // Generated, not approved: what "Approve all" approves.
  const pending = versions.filter((v) => !approvedSet[v.sceneId]?.[v.audienceId] && stills[versionId(v)]);
  const approveAll = () => {
    usePlacements.getState().approveVersions(pending);
    toast({ title: `${pending.length} ${pending.length === 1 ? 'preview' : 'previews'} approved`, tone: 'pass' });
  };
  const [picked, setPicked] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);

  const ids = versions.map(versionId);
  const select = (id: string) => {
    setPicked(id);
    setFocus(null);
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };
  const current = versions[picked ? Math.max(0, ids.indexOf(picked)) : 0];
  const n = versions.length;
  const fact = n ? `${n} ${n === 1 ? 'version' : 'versions'} · ${approved} approved` : 'No scenes included yet';

  // Next unapproved version after the current one, wrapping; none when every other one is approved.
  const at = current ? ids.indexOf(versionId(current)) : -1;
  let next: (typeof versions)[number] | undefined;
  for (let k = 1; k < n; k++) {
    const v = versions[(at + k) % n];
    if (!approvedSet[v.sceneId]?.[v.audienceId]) {
      next = v;
      break;
    }
  }

  return (
    <div className="flex flex-col pb-2">
      <ConfirmDialog
        open={confirmAll}
        title={`Generate ${missing.length} ${missing.length === 1 ? 'preview' : 'previews'}?`}
        description={`Nano Banana makes one still per version${price !== null ? `, about $${(price * missing.length).toFixed(2)} in all ($${price.toFixed(3)} each)` : ''}. Stills already made are kept and never charged again.`}
        confirmLabel="Generate"
        onConfirm={() => {
          setConfirmAll(false);
          void generateStills(missing);
        }}
        onCancel={() => setConfirmAll(false)}
      />
      <StepTitle
        title="Preview your scenes"
        fact={fact}
        className="pb-5 max-md:[&>div:last-child]:w-full"
        actions={
          <>
            {n > 0 && (
              <Button
                variant={missing.length && !running ? 'primary' : 'secondary'}
                icon={<Sparkle />}
                loading={running > 0}
                disabled={!missing.length || running > 0}
                onClick={() => setConfirmAll(true)}
                className="max-md:h-11 max-md:w-full"
              >
                {running ? `Generating ${running}` : missing.length ? `Generate all · ${missing.length}` : 'All generated'}
              </Button>
            )}
            {n > 0 && (
              <Button variant={!missing.length && pending.length ? 'primary' : 'secondary'} icon={<Checks />} disabled={!pending.length} onClick={approveAll} className="max-md:h-11 max-md:w-full">
                {pending.length ? `Approve all · ${pending.length}` : 'All approved'}
              </Button>
            )}
            <Button variant={pending.length ? 'secondary' : 'primary'} trailing={<ArrowRight />} className="max-md:h-11 max-md:w-full" onClick={() => go('render')}>
              Continue to Render
            </Button>
          </>
        }
      />

      {current ? (
        <div className="grid grid-cols-[280px_minmax(0,1fr)] items-start gap-6 max-md:grid-cols-1 max-md:gap-4">
          <VersionRail versions={versions} selected={versionId(current)} onSelect={(v) => select(versionId(v))} />
          <Stage
            key={versionId(current)}
            version={current}
            focus={focus}
            onFocus={setFocus}
            tabs={<AudienceTabs items={versions.filter((v) => v.sceneId === current.sceneId)} selected={versionId(current)} onSelect={(v) => setPicked(versionId(v))} />}
            onNext={next ? () => select(versionId(next!)) : undefined}
          />
        </div>
      ) : (
        <EmptyState
          title="No scenes included yet"
          body="Put a product in a scene and keep Include on. Each included scene gets a version per audience here to review."
          actions={
            <Button variant="primary" trailing={<ArrowRight />} onClick={() => go('scenes')}>
              Go to Scenes
            </Button>
          }
        />
      )}
    </div>
  );
}
