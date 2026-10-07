# Hosting Helix Dev Tool online (Netlify + Firebase)

The same codebase runs three ways:

| Mode | How | Login | Where connections live |
|---|---|---|---|
| **Dev** | `npm run dev` | none | `server/data/connections.json` |
| **Desktop app** | the `.dmg` / `.exe` | none | your user-data folder |
| **Hosted site** (this guide) | Netlify | Google sign-in, email allowlist | Firestore, passwords encrypted |

```
 Browser ──► Netlify CDN ── static React app
    │
    └─ /api/* ─► Netlify Function (the Express API)
                    ├─► Firestore   users/{uid}/connections  (passwords AES-256-GCM encrypted)
                    └─► your Helix instances (server-to-server)
```

**Updating the site = `git push`.** Netlify rebuilds and goes live in about a minute.

---

## One-time setup (~20 minutes)

### 1. Firebase project

At <https://console.firebase.google.com>:

1. **Add project** (Google Analytics not needed).
2. **Build → Authentication → Get started → Sign-in method →** enable **Google**.
3. **Build → Firestore Database → Create database →** *production mode*, pick a nearby region.
4. **Firestore → Rules →** paste the contents of [`firestore.rules`](firestore.rules) and **Publish**.
   (It denies all direct browser access. Only the server reads/writes, using the Admin SDK.)
5. **Project settings (⚙) → General → Your apps → Add app → Web (`</>`)** and register it.
   Copy `apiKey`, `authDomain`, `projectId`, `appId` — these become the `VITE_FIREBASE_*` values below.
   (They're public by design; they ship in the browser bundle.)
6. **Project settings → Service accounts → Generate new private key.** From the JSON that downloads, you need
   `project_id`, `client_email`, `private_key`. **Treat this file like a password:** put the values into Netlify,
   then delete the file (or keep it in a password manager). Never commit it.

### 2. Encryption key for saved Helix passwords

```bash
openssl rand -base64 32
```

Save the output in your password manager and use it as `CREDENTIAL_ENC_KEY`.
**If you lose or change it, saved Helix passwords become unreadable** and everyone has to re-enter them
(nothing else breaks).

### 3. GitHub

Create an **empty private** repository (no README/license), then from the project folder:

```bash
cd /Users/clanglais/Claude/Projects/helix-dev-tool
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

(Before the first push this repo was checked: no saved connections, credentials, or customer hostnames are
in any tracked file or in git history. `.gitignore` also excludes `connections.json`, `.env*`, and build output.)

### 4. Netlify

1. **Add new site → Import an existing project →** GitHub → pick the repo.
   Build settings come from [`netlify.toml`](netlify.toml); leave the UI fields as detected.
2. **Site configuration → Environment variables**, add these. Mark the secret ones as *secret values* and give
   them the **Functions** scope; the `VITE_*` ones need the **Builds** scope.

| Variable | Value | Scope |
|---|---|---|
| `ALLOWED_EMAILS` | `you@gmail.com, colleague@company.com` (an entry like `@company.com` allows a whole domain — only for a domain *you* control) | Functions |
| `CREDENTIAL_ENC_KEY` | the `openssl` output from step 2 | Functions · secret |
| `FIREBASE_PROJECT_ID` | `project_id` from the service-account JSON | Functions |
| `FIREBASE_CLIENT_EMAIL` | `client_email` from the JSON | Functions |
| `FIREBASE_PRIVATE_KEY` | `private_key` from the JSON (paste as-is; literal `\n`, real newlines, or surrounding quotes all work) | Functions · secret |
| `VITE_AUTH_MODE` | `firebase` | Builds |
| `VITE_FIREBASE_API_KEY` | from step 1.5 | Builds |
| `VITE_FIREBASE_AUTH_DOMAIN` | from step 1.5 | Builds |
| `VITE_FIREBASE_PROJECT_ID` | from step 1.5 | Builds |
| `VITE_FIREBASE_APP_ID` | from step 1.5 | Builds |

   `HELIX_MODE` is **not** needed — the function forces hosted mode itself so it can never start without login.

   > Netlify caps the total size of function environment variables at a few KB. The private key is ~1.7 KB, so
   > keep the rest short.

3. **Deploy** (or **Deploys → Trigger deploy** if it already ran before you added the variables).
4. Back in Firebase: **Authentication → Settings → Authorized domains → Add domain** →
   your site's domain (e.g. `your-site.netlify.app`, plus any custom domain). Without this, Google sign-in fails
   with `auth/unauthorized-domain`.

### 5. Try it

Open the site → **Sign in with Google** → **Connections → Add connection → Test auth**.

---

## Day-to-day

```bash
npm run dev      # work locally, exactly as before (no login, local file)
npm test         # 48 tests: encryption, per-user isolation, allowlist, SSRF guard, the function entry point
git commit -am "…"
git push         # → Netlify builds and deploys
```

- **Roll back:** Netlify → **Deploys** → pick an older deploy → **Publish deploy**.
- **Change who has access:** edit `ALLOWED_EMAILS`, then **trigger a new deploy** (function env vars are applied
  at deploy time). Removal takes effect immediately for new requests — the allowlist is checked on every call.
- **Preview before going live:** deploy previews get their own URLs, and Google sign-in only works on domains listed
  under Firebase *Authorized domains*. Easiest: keep a long-lived `staging` branch (stable URL), add that one domain,
  and merge to `main` when happy.

---

## What protects the Helix credentials

- Sign-in is required for every API call except `/api/health`, and the verified Google email must be on the allowlist.
- Each user's connections live under their own Firestore path; a user can't read, test, or compare with another
  user's connection (tested).
- Passwords are AES-256-GCM encrypted before they reach Firestore, with the key only in a Netlify env var, and are
  bound to the owner + connection id (a ciphertext copied elsewhere won't decrypt). They're decrypted only inside the
  function, and never sent to the browser.
- Firestore rules deny all direct client access.
- Connections must be `https://` public hostnames — not `localhost`, private ranges, or cloud-metadata addresses —
  and "Ignore SSL errors" is refused on the hosted site.
- If any required setting is missing, the API refuses to serve rather than falling back to something open.

**Still true:** the Helix passwords are held by Google (Firestore) and Netlify on your behalf, and anyone on the
allowlist can make the server call out to public HTTPS hosts. Check this fits NimbusNow's and your customers'
policies before saving customer-environment credentials here. The desktop app remains available for anything that
shouldn't leave a laptop.

---

## Limits to know about

- **Request time.** Netlify's synchronous functions have a short timeout (historically ~10 s; check your plan's
  current limit). A compare of a very large form across two instances can exceed it. Narrow it with the Company
  filter or "Fields to compare". If it keeps biting, the API can move to Firebase Cloud Functions (much longer
  timeouts) without touching the frontend or the data.
- **Response size** is capped at a few MB on Netlify; compare responses are already trimmed to what the table shows.
- **Records per side:** a compare reads up to 1,000 records per instance (unchanged from the desktop app).
- **IP allow-lists.** The hosted API calls Helix from changing Netlify/AWS addresses. A Helix instance that only
  accepts approved IPs can't be reached from the hosted site — use the desktop app for those.
- **Cold starts.** After idle, the first request re-logs-in to Helix (the token cache lives per warm function instance),
  so it's a little slower.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Banner or API error: *"The hosted site is not fully configured yet"* + a list of names | Those environment variables are missing/blank in Netlify. Add them and redeploy. |
| *"The server could not initialise Firebase"* | `FIREBASE_PRIVATE_KEY` is malformed (truncated, or the wrong field). Re-copy `private_key` from the JSON. |
| `auth/unauthorized-domain` on sign-in | Add the site's domain under Firebase → Authentication → Settings → Authorized domains. |
| *"Not authorized"* after signing in | That email isn't in `ALLOWED_EMAILS` (check spelling/commas), or the change hasn't been redeployed yet. |
| *"Your session expired — sign in again"* in a loop | Check the site and Firebase project IDs match (`FIREBASE_PROJECT_ID` vs `VITE_FIREBASE_PROJECT_ID`). |
| Build fails complaining about secrets in the output | `netlify.toml` already omits the public Firebase web keys from scanning; make sure you didn't mark a `VITE_*` value as secret or add other values that appear in the bundle. |
| Compare fails with a timeout / 502 | See *Request time* above. |
