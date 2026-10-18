import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { IconContext } from '@phosphor-icons/react';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/index.css';
import './store/theme'; // applies data-theme / data-resolved-theme before first render
import App from './App';

// A tab opened before a deploy still asks for the old build's page files, which the deploy removed. When one fails to
// load, reload once to pick up the new build (at most once every 10 s, so a real outage shows its error instead).
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'cameo-build-reload';
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY) ?? 0);
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage blocked: reload anyway */
  }
  if (Date.now() - last < 10_000) return;
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <IconContext.Provider value={{ size: 18, weight: 'regular' }}>
        <App />
      </IconContext.Provider>
    </MotionConfig>
  </StrictMode>,
);
