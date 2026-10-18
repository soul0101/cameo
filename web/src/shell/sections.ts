import { ChartBar, FilmSlate, ImageSquare, Package, PlayCircle, Sparkle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';

/**
 * Project sections: two groups, Build and Publish. Every
 * section is always reachable; each page owns its empty state.
 */
export type SectionId = 'catalog' | 'scenes' | 'previews' | 'render' | 'watch' | 'analytics';

export type SectionGroup = 'Build' | 'Publish';

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: Icon;
  group: SectionGroup;
  /** `g` + key. */
  key: string;
  /** Extra query to append to the link. */
  query?: string;
}

export const SECTIONS: SectionDef[] = [
  { id: 'catalog', label: 'Catalog', icon: Package, group: 'Build', key: 'c' },
  { id: 'scenes', label: 'Scenes', icon: FilmSlate, group: 'Build', key: 's' },
  { id: 'previews', label: 'Previews', icon: ImageSquare, group: 'Build', key: 'p' },
  { id: 'render', label: 'Render', icon: Sparkle, group: 'Build', key: 'r' },
  { id: 'watch', label: 'Watch', icon: PlayCircle, group: 'Publish', key: 'w' },
  { id: 'analytics', label: 'Analytics', icon: ChartBar, group: 'Publish', key: 'a', query: '?tab=interest' },
];

export const SECTION_GROUPS: SectionGroup[] = ['Build', 'Publish'];

/** Where a project opens: Scenes for an existing project (a fresh upload goes to Catalog). */
export const HOME_SECTION: SectionId = 'scenes';

export const sectionById = Object.fromEntries(SECTIONS.map((s) => [s.id, s])) as Record<SectionId, SectionDef>;

export const sectionPath = (projectId: string, id: SectionId) => `/p/${projectId}/${id}${sectionById[id].query ?? ''}`;

export function sectionFromPath(pathname: string): SectionId | null {
  const m = pathname.match(/^\/p\/[^/]+\/([a-z]+)/);
  return m && m[1] in sectionById ? (m[1] as SectionId) : null;
}
