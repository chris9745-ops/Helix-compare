# Helix Dev Tool

A web-based replacement for BMC Developer Studio — runs on Mac, Windows, Linux.
Built for Helix AR System **25.x and newer** (full workflow read/write REST API).

## What it does

- **Connection manager** — save multiple Helix instances, test JWT auth, auto-refresh tokens
- **Active Link browser** — search, view, edit, create, delete active links
- **Filter browser** — view and manage server-side filters by form
- **Escalation browser** — view scheduled workflow
- **Forms & Fields** — browse form schemas and field definitions side-by-side
- **Menu browser** — inspect AR menus

## Requirements

- Node.js 18+
- npm 8+
- A BMC Helix 25.x instance with REST API access

## Setup

```bash
# 1. Install all dependencies
npm run install:all

# 2. Start both backend and frontend (dev mode)
npm run dev
```

Then open **http://localhost:5173** in your browser.

The backend runs on port **3001** and the React dev server on **5173**.
Vite proxies all `/api` calls to the backend automatically.

## First steps

1. Click **Connections** in the sidebar
2. Click **Add connection** and enter your Helix instance URL, username, and password
3. Click **Test auth** to verify the connection works
4. Click **Use this instance** to activate it
5. Navigate to **Active Links**, **Filters**, etc.

## Project structure

```
helix-dev-tool/
├── server/               # Express backend
│   ├── index.js          # Entry point
│   ├── routes/
│   │   ├── connections.js  # Connection CRUD
│   │   └── helix.js        # Helix API proxy
│   ├── lib/
│   │   ├── connectionStore.js  # lowdb persistence
│   │   └── helixClient.js      # JWT auth + all API calls
│   └── data/
│       └── connections.json    # Stored connections (gitignore this!)
├── client/               # React frontend (Vite)
│   └── src/
│       ├── pages/          # Route pages
│       ├── components/     # Shared components
│       └── lib/            # API client + Zustand store
└── package.json          # Workspace root
```

## Notes on SSL

If your Helix instance uses a self-signed certificate, enable **Ignore SSL** when adding the connection.
The backend uses Node's `https.Agent({ rejectUnauthorized: false })` for those connections only.

## Roadmap

- [ ] Active Link visual editor (trigger → condition → action builder)
- [ ] Filter editor
- [ ] Field creator with type/properties form
- [ ] `.def` export/import
- [ ] AI workflow builder ("describe what you want → generates the JSON")
- [ ] Diff/compare workflow between two instances
