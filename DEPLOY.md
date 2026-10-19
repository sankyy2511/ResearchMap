# Deployment

| Part | Where |
|---|---|
| Web app (static files) | Firebase Hosting, project `research-map-88f54` |
| Backend + AI service | One Docker container (`Dockerfile`), for example on Google Cloud Run |
| Database | Managed PostgreSQL with pgvector (Neon) |

The web app calls the backend directly at its public address with a Bearer session token, so it works in every browser, including Safari and Incognito.

## 1. Backend container

Build from the repository root with `Dockerfile`. The container starts the AI service on `127.0.0.1:8000` and the backend on `$PORT`.

Environment variables:

| Key | Value |
|---|---|
| `APP_ENV` | `production` |
| `GIN_MODE` | `release` |
| `TRUSTED_PROXIES` | `0.0.0.0/0,::/0` (behind the host's proxy) |
| `WEB_ORIGINS` | `https://research-map-88f54.web.app,https://research-map-88f54.firebaseapp.com` |
| `PUBLIC_API_URL` | the backend's public address, for example `https://api.example.com` |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET`, `AGENT_INTERNAL_KEY` | long random strings |
| `GEMINI_API_KEY_1` to `_4` | Gemini API keys |
| `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | email account for sign-up codes |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |

Health check: `/api/v1/healthz`. Readiness (database, extensions, AI service): `/api/v1/readyz`.

## 2. Web app on Firebase Hosting

In the `frontend` folder:

```bash
npm install -g firebase-tools
firebase login
copy .env.firebase.example .env.firebase
```

Edit `.env.firebase`: set `NEXT_PUBLIC_API_BASE_URL=<backend public address>/api/v1`. Then:

```bash
npm run build:firebase
firebase deploy --only hosting
```

The site is at `https://research-map-88f54.web.app`.

To test the same build on this computer first: `npm run serve:static` and open http://127.0.0.1:5050 (add `http://127.0.0.1:5050` to `WEB_ORIGINS` of a local backend).

## 3. Google sign-in

Google Cloud console > Google Auth Platform > Clients > your client:

- Authorised JavaScript origins: `https://research-map-88f54.web.app`
- Authorised redirect URIs: `<backend public address>/api/v1/auth/google/callback`
- Audience: **Publish app** (only name and email are requested).

## 4. Chrome extension

`extension/manifest.json` allows `research-map-88f54.web.app` and `.firebaseapp.com`. The ZIP offered on the install page is rebuilt from the `extension` folder by every web app build.

## 5. Check after deploying

Sign up (email code arrives), sign in with Google, install the extension, create a workspace with a goal, Start Tracking, open a few pages, check the clusters and the goal panel, stop and read the report, share a link and open it in Incognito, and connect Gemini CLI with the command from Settings.
