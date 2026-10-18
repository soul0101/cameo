import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { CrumbFrame, ProjectIndex, ProjectLayout, RootLayout } from './shell/AppShell';
import Landing from './pages/Landing';

const CatalogPage = lazy(() => import('./pages/CatalogPage'));
const Scenes = lazy(() => import('./pages/Scenes'));
const Preview = lazy(() => import('./pages/Preview'));
const Render = lazy(() => import('./pages/Render'));
const Watch = lazy(() => import('./pages/Watch'));
const Processing = lazy(() => import('./pages/Processing'));
const Admin = lazy(() => import('./pages/Admin'));

/** Each page loads as its own chunk (Watch brings the charts with it). */
const page = (node: ReactNode) => <Suspense fallback={null}>{node}</Suspense>;

/**
 * Watch and Analytics are one page (WatchStep) with a Player | Interest tab in `?tab=interest`.
 * /analytics always shows Interest (a bare /analytics gains ?tab=interest); choosing Player there moves to /watch, and vice versa, so the
 * sidebar highlights the right section.
 */
function WatchRoute({ analytics }: { analytics: boolean }) {
  const { projectId } = useParams();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const interest = params.get('tab') === 'interest';
  // While a section fades out (AnimatePresence) this element still renders under the NEW location:
  // only redirect when the location is actually this route, or Player ↔ Interest would bounce back.
  const here = pathname.endsWith(analytics ? '/analytics' : '/watch');
  if (here && analytics && !interest) {
    const q = new URLSearchParams(params);
    q.set('tab', 'interest');
    return <Navigate to={`/p/${projectId}/analytics?${q.toString()}`} replace />;
  }
  if (here && !analytics && interest) return <Navigate to={`/p/${projectId}/analytics?${params.toString()}`} replace />;
  return (
    <CrumbFrame id={analytics ? 'analytics' : 'watch'}>
      {page(<Watch />)}
    </CrumbFrame>
  );
}

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/', element: <Landing /> },
      { path: '/admin', element: page(<Admin />) },
      { path: '/p/:projectId/processing', element: page(<Processing />) },
      {
        path: '/p/:projectId',
        element: <ProjectLayout />,
        children: [
          { index: true, element: <ProjectIndex /> },
          { path: 'catalog', element: page(<CatalogPage />) },
          { path: 'scenes', element: page(<CrumbFrame id="scenes"><Scenes /></CrumbFrame>) },
          { path: 'previews', element: page(<CrumbFrame id="previews"><Preview /></CrumbFrame>) },
          { path: 'render', element: page(<CrumbFrame id="render"><Render /></CrumbFrame>) },
          { path: 'watch', element: <WatchRoute analytics={false} /> },
          { path: 'analytics', element: <WatchRoute analytics /> },
          { path: '*', element: <ProjectIndex /> },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} future={{ v7_startTransition: true }} />;
}
