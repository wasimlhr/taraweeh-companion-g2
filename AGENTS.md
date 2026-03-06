# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Taraweeh Companion is a real-time Quran recitation recognition app for Even Realities G2 smart glasses. It has a Node.js backend (Express + WebSocket) that serves a single-file vanilla HTML frontend.

### Running the dev server

```bash
npm run backend:dev
```

This starts the backend with `node --watch` on port 3001 (HTTP) and 3443 (HTTPS). The frontend is served from the same origin at `/`. No separate frontend dev server is needed.

### Linting / testing

- There is **no ESLint or formal test framework** configured. Validate syntax with `node --check <file>` for backend JS files.
- `npm run test-pipeline` runs an end-to-end pipeline test (requires real `HUGGINGFACE_TOKEN` in `backend/.env`).
- Quran data integrity can be verified by importing `keywordMatcher.js` and calling `loadQuran()`.

### Key caveats

- The `backend/.env` file must exist (copy from `backend/.env.example`). The server starts without real API keys but Whisper transcription calls will fail.
- Self-signed HTTPS certs are pre-generated in `backend/certs/`. If missing, run `node backend/genCerts.js`.
- The `postinstall` script in root `package.json` automatically runs `cd backend && npm install`, so a single `npm install` at the root installs both root and backend dependencies.
- The app works in "phone-only mode" in a browser without G2 glasses hardware. Manual verse navigation (Prev/Next buttons) works without any API keys.
- There is no build step — the frontend is a single HTML file and the backend runs directly with Node.js.
