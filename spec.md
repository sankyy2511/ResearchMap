---
doc: spec
status: approved
---

# Research Map — Technical Spec

## How This Works, In Plain Language
Research Map has five parts:

- **Chrome extension** — sits in the browser. While tracking is on, it reads the text of each page you stay on and sends it to the backend. It also shows the off-goal notice.
- **Web app** — the website you open. It shows the canvas, the panels, the report and the settings.
- **Backend** — the main server. It saves everything, checks who can see what, runs the steps for each new page, and sends live updates to every open screen.
- **AI service** — a small server that talks to Google Gemini. Only the backend can call it. It also turns text into numbers (embeddings) so similar pages can be found.
- **Database** — PostgreSQL. It stores accounts, workspaces, pages, summaries, sessions and reports.

We split the AI work into its own service so all Gemini calls, retries and checks live in one place, and the backend stays simple.

## The Core Journey Through the System
PRD ref: `prd.md > The Core Journey`.

1. The person clicks Start Tracking in the web app → the backend starts a session → the web app tells the extension which workspace to track.
2. The person opens a page → after about 1 second the extension asks the backend for a goal check → the backend asks the AI service → Gemini says on goal or not → if not, the extension shows a notice.
3. After 5 seconds the extension sends the page text, title, address and the page it came from → the backend saves it and sends a new card to every open screen over WebSocket.
4. The backend asks the AI service to understand the page → Gemini writes the summary, topics and key points → the card updates on every screen.
5. The backend finds similar pages using embeddings → asks Gemini how the new page relates to them → the page joins a group → Gemini names the group → the card moves into it.
6. The backend compares new key points with similar key points from other pages → Gemini labels any real disagreement → Conflict Radar updates.
7. The person clicks End Session → the backend collects the session's pages and time → Gemini writes the report → the report page shows it.

## Stack
| Part | Choice | Why |
|---|---|---|
| AI | Google Gemini API: `gemini-flash-latest` and `gemini-flash-lite-latest` ([docs](https://ai.google.dev/gemini-api/docs)) | Fast and good at short structured answers. Lite for steps that run on every page, Flash for longer writing. |
| Embeddings | FastEmbed with `BAAI/bge-small-en-v1.5` ([docs](https://qdrant.github.io/fastembed/)) | Runs inside the AI service, so no extra API is needed. |
| Web app | Next.js 16, React 19, React Flow, Zustand, TanStack Query, Tailwind CSS ([Next.js](https://nextjs.org/docs), [React Flow](https://reactflow.dev)) | React Flow gives a ready canvas with zoom and drag. |
| Backend | Go with Gin, pgx, goose and the MCP Go SDK ([Gin](https://gin-gonic.com/docs/), [MCP](https://modelcontextprotocol.io)) | Fast, simple to deploy as one small container, good for many live connections. |
| AI service | Python with FastAPI and httpx ([FastAPI](https://fastapi.tiangolo.com)) | Python has the best tools for AI and embeddings. |
| Database | PostgreSQL with pgvector and pg_trgm ([pgvector](https://github.com/pgvector/pgvector)) | One database for normal data, meaning search and fuzzy text search. |
| Extension | Chrome Manifest V3 with Mozilla Readability ([docs](https://developer.chrome.com/docs/extensions)) | Readability pulls the main text out of a page and drops menus and ads. |

## Where It Runs and How Someone Tries It
- **Live:** web app on Firebase Hosting at https://researhmap.in. The backend and the AI service run together in one Docker container (`Dockerfile`) on Google Cloud Run. Inside the container the AI service listens only on `127.0.0.1`, so only the backend can reach it. The database is on Neon (managed PostgreSQL).
- **Local:** needs Go 1.26+, Python 3.12 or 3.13 with uv, Node.js 20+, Chrome, a PostgreSQL database with pgvector, and at least one Gemini API key.
- **Start commands** (each in its own terminal, after copying the `.env.example` files):
  - AI service: `cd agent && uv sync && uv run uvicorn app.main:app --port 8000 --env-file .env`
  - Backend: `cd backend && go run ./cmd/server`
  - Web app: `cd frontend && npm install && npm run dev`
- Then open http://localhost:3000, load the `extension` folder in `chrome://extensions` with Developer mode on, and click Connect extension in Settings.
- **Demo recording:** sign in, create a workspace with a goal, click Start Tracking, open a few pages, open one unrelated page, end the session, open the report.

## Look and Feel
- Warm light background, soft colour for each group, rounded cards with light shadows.
- Cards styled as small browser tabs with a preview image.
- Clear, calm type with plenty of space. Few buttons on screen at one time.
- Interface text and all Gemini answers in simple formal English.

## Components

### Chrome extension
Records pages and time per tab, keeps track of which page opened which tab, runs goal checks, shows notices, and keeps a queue of captures to resend if the server is down. Talks only to the backend.
PRD ref: `prd.md > Capturing pages`, `prd.md > Goal tracking`.

### Web app
All screens. Sends normal requests to the backend and listens on a WebSocket for live updates. Lays out the canvas in the browser every time the data changes, so nothing about the layout needs saving.
PRD ref: `prd.md > Screens and Layout`.

### Backend
Accounts, workspaces, capture, the page pipeline (`backend/internal/app/pipeline.go`), goal checks, reports, share links, live updates and the MCP server. Talks to the database and the AI service.
PRD ref: `prd.md > Features and Behavior`.

### AI service
Every Gemini call goes through one router (`agent/app/providers.py`). Every answer must be valid JSON that matches a schema before it is used. Page text is always passed as data, and Gemini is told never to follow instructions inside it.
PRD ref: `prd.md > Understanding pages`, `prd.md > Session report`.

### MCP server
Lives in the backend at `/api/v1/mcp`. Gives AI assistants tools such as `start_research`, `add_source`, `add_finding` and `get_session_report`. Everything they add goes to the "AI Agent" branch.
PRD ref: `prd.md > AI assistant access`.

## Data Model
All data lives in PostgreSQL. Tables are created and updated by the backend when it starts.

| Table | Holds |
|---|---|
| `users`, `email_codes`, `api_tokens` | Accounts, sign-up and reset codes (hashed), extension and MCP tokens (hashed) |
| `workspaces`, `workspace_members`, `share_links`, `branches` | Workspaces, roles, share links, main canvas and AI Agent branch |
| `pages`, `claims` | Page text, summary, topics and embedding; key points with quotes and embeddings |
| `nodes`, `edges` | Cards and groups on the canvas, and stored relations |
| `sessions`, `visits`, `goal_checks`, `reports` | Tracking sessions, time per visit, goal results, session reports |
| `conflicts`, `annotations` | Conflict Radar results, notes and comments |

When the person leaves and comes back, everything is loaded again from the database.

## File Structure
```
project/
├── agent/        # AI service: Gemini prompts, model router, embeddings, tests
├── backend/      # Go server: API, capture, page pipeline, WebSocket, MCP, migrations
├── frontend/     # Next.js web app: canvas, views, panels, report, settings
├── extension/    # Chrome extension: capture, time tracking, goal notices
├── scripts/      # End-to-end MCP test and start script
├── docs/         # Screenshots
├── devpost/      # Planning documents: scope, PRD, spec
├── Dockerfile    # One container with the backend and AI service, for Cloud Run
└── README.md
```

## External Services and Dependencies
| Service | Use | Keys | Limits and cost |
|---|---|---|---|
| Google Gemini API | All AI steps, called with `generateContent` and a JSON response format | `GEMINI_API_KEY_1` to `_4` | Free tier limits; the AI service keeps to 60 calls per minute |
| Groq | Emergency backup, used only when every Gemini key and model has failed | Groq API key (optional) | Free tier |
| Google Cloud Run | Runs the one container with the backend and AI service | Google Cloud project | Free tier covers a demo |
| Firebase Hosting | Serves the web app | Firebase project | Free tier |
| Neon PostgreSQL | Database | `DATABASE_URL` | Free tier |
| Google OAuth | Continue with Google | Client ID and secret | Free |
| Gmail SMTP | Sends 6-digit codes | App password | Free, daily send limit |

## Important Failure Modes
- **Gemini rate limit (429)** → the AI service moves to the next API key, then to the next model. The person sees the summary a little later.
- **Gemini down or timing out** → the other Gemini model is tried, then the Groq backup. If all fail, the page is saved without a summary and analysed again later. The goal check uses local similarity instead, so no notice is ever blocked.
- **Server unreachable from the extension** → captures wait in a queue in the extension and are sent when the server is back.

## What Was Simplified and Why
- **Extension loaded from a ZIP** instead of the Chrome Web Store — store review takes days. The full version needs a store listing and review.
- **Groups instead of relation lines on the canvas** — lines were hard to read. Relations are still stored for search, conflicts and AI assistants.
- **Embeddings run inside the AI service** instead of an external API — fewer keys and no extra cost. A larger model could give better matches later.

## Decisions and Open Issues
- **Two Gemini models with key rotation** — chosen because the free tier hits rate limits quickly during a demo. Tradeoff: more code in the router, but the product keeps working.
- **Generous goal check** — a page counts as on goal if Gemini says so, if the score is 40 or more, or if local similarity is 0.62 or more. Tradeoff: some off-goal pages are missed, but people are not annoyed by wrong warnings.
- **Uncertainty we worked through:** how long a person must stay on a page before it is added. Too short adds pages the person only passes through; too long misses quick reads. We chose 5 seconds.
- **Open:** none that block the demo.
