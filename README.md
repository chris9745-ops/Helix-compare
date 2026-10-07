# Helix Dev Tool

A tool for comparing BMC Helix ITSM configuration/reference data between two
environments (e.g. Dev vs Prod), plus a light schema browser. It runs three ways
from one codebase:

- **Dev** — `npm run dev`, local web app, no login
- **Desktop app** — Mac/Windows installers, see [Packaging as a desktop app](#packaging-as-a-desktop-app)
- **Hosted site** — Netlify + Firebase (Google sign-in, per-user encrypted connections),
  updated with `git push`. See **[DEPLOY.md](DEPLOY.md)**.

## What it does

- **Connection manager** — save multiple Helix instances, test JWT auth, auto-refresh tokens
- **Compare** — two modes:
  - **Data**: diff records on any form between two connections (e.g. `CTM:Support Group`,
    `CTM:People`, `CTM:Company`), matched by a key field. Optional Company filter accepts a
    single name, a comma-separated list (OR'd), or a wildcard with `*` (e.g. `Germania*`).
  - **Schema**: diff a form's *field definitions* between environments instead of its data —
    catches things like a custom field that exists in Dev but hasn't been promoted to Prod.
  - Results render as a table (added/removed/modified rows always visible, no clicking
    required; matched/unchanged records collapse behind a toggle since they're usually the
    bulk of the data and not what you're there to look at).
- **Forms & Fields** — look up a form's field definitions by its exact name (BMC's REST API has no
  "list all forms" call). Columns are built from whatever the server returns.
  - **Form-list import:** the Mid-Tier's own "AR System Object List" screen (`…/arsys/forms`) does list every
    form — with **Show Hidden** ticked, thousands of them. Copy that table once per environment and paste it into
    the import panel; it's stored with the connection and powers typeahead in every form-name box (Forms &
    Fields, Compare). Handles tab-separated rows, one-cell-per-line copies, extra columns, and stray page text.
- **Menus** — look up a specific menu's definition by exact name
- **Diagnostics** — probe which forms are reachable via the REST API on a given instance,
  including a custom-probe box for testing your own candidate form names

## A REST API limitation worth knowing

BMC's documented REST APIs for Helix ITSM (both the "platform REST API" and the
"simplified REST API") don't expose **Active Links, Filters, or Escalations** at all —
those workflow objects only exist in the classic AR System native-protocol API that
Developer Studio speaks (a different port, not HTTP/REST). This tool can't browse or
compare those objects as a result; comparing workflow customizations between
environments still requires Developer Studio's `.def` export, or `arexportcmd`.

This was tested directly against a Helix 26.2 (container-based) server: the older "AR System Metadata:*"
forms (`arschema`, `field`, `actlink`, `filter`, `escalation`) that some on-prem versions expose as ordinary
records all return "Form does not exist on server", and BMC's own article says that technique doesn't apply to
21.05+ container environments. So there is no REST route to the form list or to workflow objects there.

Similarly, **Menus** only support lookup by exact known name — there's no bulk-list
endpoint, so unlike entries there's no way to enumerate "all menus" without another
source telling you what to look up.

**Entries on a form** (the `/api/arsys/v1/entry/{formName}` resource) are the one
object type BMC's REST API fully supports for listing/searching/diffing — which is
why Compare is scoped to configuration/reference data rather than workflow objects.

## Requirements

- Node.js 18+
- npm 8+
- A BMC Helix instance with REST API access

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

1. Click **Connections** in the sidebar, add your Dev and Prod instances, and **Test auth** on each
2. Go to **Compare**, pick Dev on the left and Prod on the right
3. Enter a form name (e.g. `CTM:Support Group`) and the field that uniquely identifies each record (e.g. `Support Group Name`)
4. **Run compare** — click a "modified" row to see which fields differ

If you're not sure of a form's exact name/fields, check **Forms & Fields** or run
**Diagnostics** first.

## Project structure

```
helix-dev-tool/
├── electron/              # Electron main process (packaged desktop app entry point)
│   └── main.js
├── netlify/functions/api.js   # Hosted entry point: wraps the Express app as a Netlify Function
├── netlify.toml · firebase.json · firestore.rules   # Hosted deploy config
├── server/               # Express backend
│   ├── app.js            # createApp() — shared by local, Electron, and Netlify
│   ├── index.js          # Local/desktop entry point — also serves client/dist
│   ├── config.js         # local vs hosted mode, allowlist
│   ├── middleware/       # auth (Firebase ID token + allowlist), error handler
│   ├── test/             # `npm test` (node:test, no extra dependencies)
│   ├── routes/
│   │   ├── connections.js  # Connection CRUD
│   │   ├── helix.js        # Forms/Fields/Menus + diagnostic probe
│   │   └── compare.js      # Entry-diff endpoint
│   ├── lib/
│   │   ├── connectionStore.js  # picks the store for the mode:
│   │   ├── stores/fileStore.js       #   local: lowdb JSON (path via HELIX_DATA_DIR)
│   │   ├── stores/firestoreStore.js  #   hosted: Firestore, per user, passwords encrypted
│   │   ├── crypto.js · urlGuard.js · firebaseAdmin.js
│   │   ├── helixClient.js      # JWT auth + REST calls
│   │   └── diff.js             # Generic key-based + deep diff
│   └── data/
│       └── connections.json    # Stored connections in dev mode (gitignore this!)
├── client/               # React frontend (Vite)
│   └── src/
│       ├── pages/          # Route pages
│       ├── components/     # Shared components
│       └── lib/            # API client + Zustand store
└── package.json          # Workspace root + Electron/electron-builder config
```

## Packaging as a desktop app

The app packages into a real installable desktop app (Electron) — a single
process embeds the Express server and serves the built React app, so end
users don't need Node.js, npm, or a terminal at all.

```bash
# One-time: install electron/electron-builder (already covered by install:all)
npm run install:all

# Build installers (runs the production client build first)
npm run dist:mac    # → release/Helix Dev Tool-<version>-arm64.dmg and -x64.dmg
npm run dist:win    # → release/Helix Dev Tool Setup <version>-x64.exe and -arm64.exe
npm run dist        # both platforms
```

You can also run `npm run electron` to launch the packaged-style app locally
(builds the client, then opens it in an Electron window) without producing
an installer — useful for a quick sanity check before a full `dist` build.

**Where user data lives once packaged:** each person's saved connections
(including passwords, stored in plaintext — same as in dev mode) live in the
OS-standard per-user app data directory, *not* inside the app bundle, so they
survive reinstalls/updates:
- macOS: `~/Library/Application Support/helix-dev-tool/data/connections.json`
- Windows: `%APPDATA%\helix-dev-tool\data\connections.json`

**Code signing:** these builds are unsigned (no Apple Developer ID / Windows
code-signing cert configured). Recipients will see a one-time OS warning on
first launch:
- macOS: right-click the app → **Open** (bypasses the "unidentified developer" Gatekeeper block)
- Windows: click **More info** → **Run anyway** on the SmartScreen prompt

If you get real signing certificates later, wire them in via `CSC_LINK`/
`CSC_KEY_PASSWORD` (Mac) and `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` (Windows)
env vars — electron-builder picks these up automatically, no config changes needed.

**Build platform note:** Mac installers were built and fully verified
end-to-end (launch, embedded server, connection CRUD, packaged data path) on
Apple Silicon. The Windows `.exe` installers were cross-built successfully
from macOS (electron-builder auto-downloads Wine for this), but haven't been
run on an actual Windows machine — the packaging pipeline is identical and
platform-agnostic (pure Node.js/Electron, no native code), so it should work,
but if something's off on first real Windows test, check `electron/main.js`
and the NSIS output in `release/win-unpacked/` first.

## Notes on SSL

If your Helix instance uses a self-signed certificate, enable **Ignore SSL** when adding the connection.
The backend uses Node's `https.Agent({ rejectUnauthorized: false })` for those connections only.

## Security note on distributing this

Connections (including passwords) are stored in **plaintext** in each user's local
`connections.json` — fine for a single person running this on their own machine, but
worth knowing before handing the packaged app to a wider group: anyone with file
access to that machine/user account can read saved Helix credentials. If this needs
to go beyond a small trusted team, encrypting that file (e.g. via the OS keychain
through Electron's `safeStorage` API) would be the next thing to add.

## Roadmap

- [ ] `.def` file upload + diff, as the real path to comparing workflow objects
- [ ] Saved compare presets (form name + key field) per connection pair
- [ ] Custom app icon (currently the default Electron icon) and code signing for a warning-free install
- [ ] Encrypt stored connection passwords via Electron's `safeStorage` API instead of plaintext
