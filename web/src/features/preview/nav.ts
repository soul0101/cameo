import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { sectionPath } from '@/shell/sections';
import type { SectionId } from '@/shell/sections';

/** Navigate to a section of the current project (`/p/:id/<section>`). */
export function useSectionNav() {
  const navigate = useNavigate();
  const { projectId = '' } = useParams();
  return useCallback((id: SectionId, search = '') => navigate(sectionPath(projectId, id) + search), [navigate, projectId]);
}
