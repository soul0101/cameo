import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFlow } from '@/store/flow';
import { useProject } from '@/store/project';
import { useTheme } from '@/store/theme';
import type { ThemeMode } from '@/store/theme';
import { Button, ConfirmDialog, Field, Segmented, Sheet, ShortcutsPanel, toast } from '@/ui';
import { useShell } from './store';
import { ProductModal } from '@/ui/ProductModal';
import { useApprovedSigs } from '@/features/preview/changed';
import { useSaved } from '@/store/saved';
import { activeEpisodeId } from '@/data/episode';
import { isSample, restoreSample } from '@/features/samples/seed';

/** Shortcuts panel, settings sheet, the Rename sheet and the Start over confirm. Mounted once at the root. */
export function ShellOverlays() {
  const shortcuts = useShell((s) => s.shortcuts);
  const settings = useShell((s) => s.settings);
  const confirmReset = useShell((s) => s.confirmReset);
  const renaming = useShell((s) => s.rename);
  const name = useProject((s) => s.name);
  const set = useShell((s) => s.set);
  const mode = useTheme((s) => s.mode);
  const setMode = useTheme((s) => s.setMode);
  const navigate = useNavigate();

  const sample = isSample(activeEpisodeId);
  const startOver = () => {
    set({ confirmReset: false, settings: false });
    if (sample) return restoreSample(activeEpisodeId);
    // Every store, not just navigation: the starter catalog, boxes reseeded with Gemini's picks,
    // approvals, edited prompts and saved products.
    useProject.getState().reset();
    useFlow.getState().reset();
    useApprovedSigs.setState({ sigs: {} });
    useSaved.setState({ items: [] });
    navigate('/');
    toast({ title: 'Project reset', description: `${name} is back to a fresh start` });
  };

  return (
    <>
      <ProductModal />
      <ShortcutsPanel open={shortcuts} onClose={() => set({ shortcuts: false })} />
      <Sheet open={settings} onClose={() => set({ settings: false })} title="Settings" width={420}>
        <div className="flex flex-col gap-6 px-5 pt-1 pb-6">
          <section className="flex flex-col gap-2">
            <h3 className="text-12 font-medium text-text-3">Appearance</h3>
            <div className="flex items-center justify-between gap-4">
              <span className="text-14 text-text">Theme</span>
              <Segmented<ThemeMode>
                label="Theme"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            </div>
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-12 font-medium text-text-3">Project</h3>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-14 text-text">{sample ? 'Restore sample' : 'Start over'}</p>
                <p className="text-13 text-text-2">{sample ? 'Brings back its products, stills and clips' : 'Clears scenes, approvals and edited prompts'}</p>
              </div>
              <Button variant="danger" size="sm" onClick={() => set({ confirmReset: true })}>
                {sample ? 'Restore' : 'Start over'}
              </Button>
            </div>
          </section>
        </div>
      </Sheet>
      <RenameSheet open={renaming} name={name} onClose={() => set({ rename: false })} />
      <ConfirmDialog
        open={confirmReset}
        title={sample ? 'Restore the sample?' : 'Start over?'}
        description={
          sample
            ? `Your changes to ${name} are cleared, and it comes back as it ships: its products, approved stills and rendered clips.`
            : `This clears every product in your scenes, every approval and every edited prompt for ${name}, and restores the starter catalog. The episode stays.`
        }
        confirmLabel={sample ? 'Restore sample' : 'Start over'}
        onConfirm={startOver}
        onCancel={() => set({ confirmReset: false })}
      />
    </>
  );
}

/** Rename the project: one field, Save or Esc. */
function RenameSheet({ open, name, onClose }: { open: boolean; name: string; onClose: () => void }) {
  const [value, setValue] = useState(name);
  useEffect(() => {
    if (open) setValue(name);
  }, [open, name]);
  const save = () => {
    const next = value.trim();
    if (next && next !== name) {
      useProject.getState().rename(next);
      toast({ title: 'Project renamed', description: next });
    }
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Rename project"
      width={420}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!value.trim()} onClick={save}>
            Save
          </Button>
        </div>
      }
    >
      <form
        className="px-5 pt-1 pb-6"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Name" value={value} onChange={(e) => setValue(e.target.value)} maxLength={60} autoComplete="off" data-autofocus />
      </form>
    </Sheet>
  );
}
