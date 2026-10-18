# Cameo web

Cameo places the right product for each audience into finished video. Gemini finds the spots, Nano Banana previews them and Gemini Omni edits the shot. This is the browser app: Vite, React 18, TypeScript, Tailwind v4, Zustand, Framer Motion, React Router 6 and Recharts.

## Pages

- **Landing**: upload a video (up to 10 seconds are processed) or open a ready-made sample.
- **Catalog**: the product library and the audiences it is sold to.
- **Scenes**: Gemini's boxes follow the video through each shot. Boxes you draw are identified with Cloud Vision and Gemini. Pick a product per box and audience.
- **Previews**: Nano Banana renders a still of each scene for each audience; edit the prompt, then approve.
- **Render**: Gemini Omni edits the shot's own video to match the approved still, at 360p, and Gemini checks the clip.
- **Watch**: the episode with the products shown beside it, timed to the shots they sit in.
- **Analytics**: impressions, shop clicks, product views and saves per audience.

## Run

```sh
npm install
cp .env.example .env     # VITE_API_URL, default http://localhost:8787
npm run dev              # the API in ../agents must be running
npm run build            # tsc -b, then vite build into dist/
npm run typecheck
```

Deploy `dist/` to Firebase Hosting with `firebase deploy --only hosting`; `firebase.json` rewrites every route to `index.html`.

## State

Projects, the catalog and audiences live in the browser (Zustand, persisted to localStorage) and travel in request bodies (`src/services/payload.ts`). The API keeps no project state between requests beyond its file cache. When it sleeps, a "Waking up" strip shows while the first request waits; when it does not answer, pages offer a retry. Polling stops while the tab is hidden or idle, so the server can scale to zero (`src/lib/activity.ts`).

```
src/
  data/       episode and detection model, catalog, prompts
  store/      project, placements, theme
  services/   API client
  features/   one folder per page
  ui/         shared components
```
