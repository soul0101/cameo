import { DeviceMobile, Flask, MapPin, Megaphone, Tag, UsersThree } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { useProject } from '@/store/project';
import type { Audience, AudienceId, AudienceKind } from '@/store/project';

/**
 * Audience helpers shared by every page. Every page reads the
 * live list from the project store. Ids are free strings: the starter audiences use IN / JP / ID,
 * added ones get generated ids (`a-…`). Nothing is special-cased on an id.
 */

export type { Audience, AudienceId, AudienceKind } from '@/store/project';

/** Per kind: the word, the Phosphor icon (regular, 16 in bars) and the name field's placeholder. */
export const AUDIENCE_KINDS: Record<AudienceKind, { label: string; icon: Icon; placeholder: string }> = {
  place: { label: 'Place', icon: MapPin, placeholder: 'Japan' },
  platform: { label: 'Platform', icon: DeviceMobile, placeholder: 'TikTok' },
  segment: { label: 'Segment', icon: UsersThree, placeholder: 'Coffee lovers 18–24' },
  sponsor: { label: 'Sponsor', icon: Megaphone, placeholder: 'Brewno launch' },
  test: { label: 'Test', icon: Flask, placeholder: 'Variant B' },
  custom: { label: 'Custom', icon: Tag, placeholder: 'Name' },
};

/** Kinds in chip order. */
export const AUDIENCE_KIND_ORDER: AudienceKind[] = ['place', 'platform', 'segment', 'sponsor', 'test', 'custom'];

/** Every audience of the episode, in order (React; re-renders on add / rename / remove). */
export function useAudiences(): Audience[] {
  return useProject((s) => s.audiences);
}

/** Every audience of the episode, non-reactive. */
export function audienceList(): Audience[] {
  return useProject.getState().audiences;
}

/** The audience's name ("Japan", "Variant B"), falling back to the id. */
export function audienceLabel(id: AudienceId): string {
  return useProject.getState().audiences.find((a) => a.id === id)?.name ?? id;
}

/** "3 audiences" */
export const audienceCount = (n: number) => `${n} ${n === 1 ? 'audience' : 'audiences'}`;

/* ---------- "Sees products from" ---------- */

/**
 * The default "Sees products from" for a new audience of this kind: the first audience for
 * Platform / Segment / Sponsor / Test / Custom (a cut of an existing version), none for Place
 * (a place has its own products).
 */
export function defaultBasedOn(kind: AudienceKind, audiences: Audience[], self?: AudienceId): AudienceId | undefined {
  if (kind === 'place') return undefined;
  return audiences.find((a) => a.id !== self)?.id;
}

/** The audience this one sees products from (direct parent), if any. */
export function basisOf(a: Audience | null | undefined, audiences: Audience[]): Audience | undefined {
  return a?.basedOn ? audiences.find((x) => x.id === a.basedOn) : undefined;
}

/** Audiences directly based on `id` (re-pointed when it is removed). */
export function dependantsOf(id: AudienceId, audiences: Audience[]): Audience[] {
  return audiences.filter((a) => a.basedOn === id);
}

/**
 * Audiences `self` may be based on: every other audience except those that already (recursively)
 * see products from `self` (that would loop).
 */
export function basisOptions(self: AudienceId | undefined, audiences: Audience[]): Audience[] {
  if (!self) return audiences;
  const leadsTo = (a: Audience): boolean => {
    const seen = new Set<AudienceId>();
    for (let cur: Audience | undefined = a; cur; cur = audiences.find((x) => x.id === cur!.basedOn)) {
      if (cur.id === self) return true;
      if (seen.has(cur.id)) return false;
      seen.add(cur.id);
    }
    return false;
  };
  return audiences.filter((a) => a.id !== self && !leadsTo(a));
}
