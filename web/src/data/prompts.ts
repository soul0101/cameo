import type { CatalogProduct } from './catalog';
import { geminiDefaultPrompt } from './detected';
import { useWrittenPrompts, writtenKey } from './writtenPrompts';
import type { AudienceId } from '@/store/project';
import type { SceneBox } from '@/store/placements';

/**
 * Edit prompts. Gemini writes one per box and audience for its top pick
 * there: stage 3 for detected boxes (`defaultPrompts`), identify for drawn boxes (`prompts`). When
 * the box holds another product, a plain template stands in and is labelled as such; the user can
 * edit the composed prompt either way.
 */

/** Where a box's prompt came from. */
export type PromptSource = 'gemini' | 'template';

/** The prompt a box starts with for a product in an audience (before any edit). */
export function promptBase(box: SceneBox, product: CatalogProduct, audienceId: AudienceId): { text: string; source: PromptSource } {
  const gemini =
    box.source === 'gemini'
      ? geminiDefaultPrompt(box.id, audienceId, product.id)
      : box.picks?.[audienceId]?.[0]?.productId === product.id
        ? box.prompts?.[audienceId]
        : undefined;
  if (gemini) return { text: gemini, source: 'gemini' };
  const written = useWrittenPrompts.getState().prompts[writtenKey(box.id, product.id)];
  if (written) return { text: written, source: 'gemini' };
  // Plain fallback, only until Gemini writes one (Previews asks), in the same style; the models never see a box.
  const where = (box.geminiLabel ?? box.label).toLowerCase();
  const text =
    box.kind === 'apparel'
      ? `Dress the wearer of the ${where} in the ${product.full}, in its place if it is the same kind of garment or over it if it is a layer; keep the face, body, pose and lighting identical.`
      : box.kind === 'wall' || box.kind === 'sign' || box.kind === 'screen'
        ? `Show the ${product.full} on the ${where}, unobstructed; keep the people, lighting and camera move identical.`
        : `Place the ${product.full} at the ${where} where the camera sees it clearly, front facing the camera; keep the people, lighting and reflections identical.`;
  return { text, source: 'template' };
}

/**
 * The combined prompt for one scene version, composed from the per-box prompts: each box's
 * instruction without its own "Keep … identical." sentence, numbered when there is more than one,
 * then one shared keep line.
 *   "In this shot: (1) replace …; (2) replace …. Keep faces, hands, lighting and reflections identical."
 */
export function composeScenePrompt(boxPrompts: ReadonlyArray<readonly [string, number]>): string {
  const parts = boxPrompts
    .map(([p, n]) => [
      n,
      p
        .split(/(?<=\.)\s+/)
        .filter((sentence) => !/^keep\b/i.test(sentence.trim()))
        .join(' ')
        .replace(/[;,]\s*(and\s+)?keep(ing)?\b[^.;]*/gi, '')
        .trim()
        .replace(/\.$/, ''),
    ] as const)
    .filter(([, p]) => !!p)
    .map(([n, p]) => [n, p.charAt(0).toLowerCase() + p.slice(1)] as const);
  if (!parts.length) return '';
  const body = parts.length === 1 ? parts[0][1] : parts.map(([n, p]) => `(${n}) ${p}`).join('; ');
  return `In this shot: ${body}. Keep faces, hands, lighting and reflections identical.`;
}
