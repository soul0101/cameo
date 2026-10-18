import { useEffect } from 'react';
import { activeEpisodeId } from '@/data/episode';
import { useWrittenPrompts, writtenKey } from '@/data/writtenPrompts';
import { sceneById } from '@/features/scenes/model';
import { writePrompt } from '@/services/api';
import { sceneItems } from '@/store/placements';
import type { SceneItem, SceneVersion } from '@/store/placements';

/** Keys that failed this session (the template stays; no retry loop). */
const failed = new Set<string>();

function needed(v: SceneVersion): Array<{ key: string; item: SceneItem; shotId: string }> {
  const shotId = sceneById[v.sceneId]?.shot.id;
  if (!shotId) return [];
  return sceneItems(v.sceneId, v.audienceId)
    .filter((i) => i.promptSource === 'template')
    .map((item) => ({ key: writtenKey(item.box.id, item.product.id), item, shotId }));
}

async function write(key: string, item: SceneItem, shotId: string) {
  const st = useWrittenPrompts.getState();
  if (st.prompts[key] || st.pending[key] || failed.has(key)) return;
  useWrittenPrompts.setState((s) => ({ pending: { ...s.pending, [key]: true } }));
  try {
    const text = await writePrompt(activeEpisodeId, {
      shotId,
      box: item.box.box,
      label: item.box.geminiLabel ?? item.box.label,
      kind: item.box.kind,
      product: { brand: item.product.brand, name: item.product.name, category: item.product.category, description: item.product.description },
    });
    useWrittenPrompts.setState((s) => ({ prompts: { ...s.prompts, [key]: text } }));
  } catch {
    failed.add(key);
  } finally {
    useWrittenPrompts.setState((s) => {
      const pending = { ...s.pending };
      delete pending[key];
      return { pending };
    });
  }
}

/**
 * Previews only: Gemini writes the edit prompt for every product the producer placed that has none yet
 * (Gemini's own picks come with theirs), three at a time. Done here, not in Scenes, so edits there cost nothing.
 */
export function useWritePrompts(versions: SceneVersion[]) {
  useEffect(() => {
    const todo = new Map<string, { item: SceneItem; shotId: string }>();
    for (const v of versions) for (const n of needed(v)) todo.set(n.key, n);
    const queue = [...todo.entries()];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await write(next[0], next[1].item, next[1].shotId);
    };
    void Promise.all([worker(), worker(), worker()]);
  }, [versions]);
}

/** True while Gemini is writing a prompt this version needs. */
export function useVersionWriting(v: SceneVersion): boolean {
  const pending = useWrittenPrompts((s) => s.pending);
  return needed(v).some((n) => pending[n.key]);
}

/** Resolves once no prompt this version needs is being written (a Generate waits for it). */
export function promptsReady(v: SceneVersion): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (needed(v).some((n) => useWrittenPrompts.getState().pending[n.key]) ? setTimeout(check, 400) : resolve());
    check();
  });
}
