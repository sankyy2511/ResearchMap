# Research Map: web app

Next.js 16, React 19, React Flow, Tailwind CSS and Zustand. The live map, the workspaces, the session report and the settings.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. The settings come from `.env.local` (copy `.env.example`).

## Build for Firebase Hosting

```bash
npm run build:firebase
firebase deploy --only hosting
```

The settings come from `.env.firebase` (copy `.env.firebase.example`). See `../DEPLOY.md` for the full steps.
