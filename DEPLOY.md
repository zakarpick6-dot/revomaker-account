# Deploying REVOMAKER STEAM

This project is a **stateful Node server**:

- SQLite database via `node:sqlite` (`data/revomaker.sqlite`)
- uploaded images in `data/uploads/`
- sessions, analytics and owner accounts in that same database
- a long-running HTTP process with in-memory rate limiting

Because of that, the host must provide a **persistent disk** for the full app
(owner console, editing, uploads and live analytics). A read-only public
catalogue can be deployed to Vercel from the same repository.

| Host | Works as-is? | Notes |
| --- | --- | --- |
| Render / Railway / Fly.io with a volume | Yes | Recommended. Full app, no code changes. |
| VPS + nginx/Caddy | Yes | Full control. |
| Vercel | Public site only | Static catalogue snapshot; no owner console or live tracking. |

---

## 1. Push the project to GitHub

```bash
cd revomaker-steam
git init -b main
git config user.name "Your Name"
git config user.email "you@example.com"
git add .
git commit -m "REVOMAKER STEAM"
```

Create an **empty** repository on <https://github.com/new> (do not add a README),
then connect it:

```bash
git remote add origin https://github.com/YOUR-USERNAME/revomaker-steam.git
git push -u origin main
```

`.gitignore` already excludes the files that must never be committed:

```text
data/
.env
.owner-credentials.txt
node_modules/
```

Verify before pushing:

```bash
git status --short
```

If `.env`, `data/` or `.owner-credentials.txt` appear, stop and fix `.gitignore`.
Because the credentials file exists locally, delete it after storing the passwords
in a password manager.

---

## 2. Deploy to Render (recommended)

Render supports a persistent disk and runs the existing `npm start` command.

### Create the service

1. In Render: **New → Web Service**, connect the GitHub repo.
2. **Runtime:** Node
3. **Build command:** `npm install`
4. **Start command:** `npm start`
5. Choose an instance type that supports disks (Starter or higher).

### Add a persistent disk

- **Name:** `data`
- **Mount path:** `/opt/render/project/src/data`
- **Size:** 1 GB is plenty

Mounting the disk at `data` keeps both the SQLite file and uploaded images.
No code changes are needed.

### Environment variables

| Key | Value |
| --- | --- |
| `NODE_VERSION` | `24` (or the latest 24.x your host provides) |
| `NODE_ENV` | `production` |
| `APP_URL` | `https://YOUR-SERVICE.onrender.com` |
| `APP_SECRET` | 64+ random hex characters |
| `COOKIE_SECURE` | `1` |
| `TRUST_PROXY` | `1` |
| `SEED_DEMO` | `0` |

Generate the secret locally:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`SEED_DEMO=0` still creates the four categories; it only skips the demo drop
catalogue. Leave it at `1` if you want the demo drops in production.

### First deploy

After the deploy finishes, open:

```text
https://YOUR-SERVICE.onrender.com/api/health
```

You should get `{"ok":true,...}`.

### Create the three owner accounts

Open the Render **Shell** for the service and run:

```bash
npm run owners create -- --email owner@revomaker.steam --name "Zak" --password "REPLACE_WITH_STRONG_PASSWORD"
npm run owners create -- --email coowner@revomaker.steam --name "Co-Owner" --password "REPLACE_WITH_STRONG_PASSWORD"
npm run owners create -- --email third@revomaker.steam --name "Third Owner" --password "REPLACE_WITH_STRONG_PASSWORD"
npm run owners list
```

The limit is enforced by a database trigger, so the fourth account will fail.
Sign in at `https://YOUR-SERVICE.onrender.com/admin/login`.

### Custom domain

1. Add the domain in Render → **Settings → Custom Domains**.
2. Change `APP_URL` to `https://your-domain.example`.
3. Redeploy so cookies, canonical URLs and the sitemap use the new origin.

### Backups

Back up the whole disk, or at least:

```text
data/revomaker.sqlite
data/uploads/
```

Render can take disk snapshots; keep them enabled.

---

## 3. Railway (also works)

1. **New Project → Deploy from GitHub repo.**
2. Add a **Volume** mounted at `/app/data`.
3. Set the same environment variables as above.
4. Use the service shell to run the three `npm run owners create` commands.

Railway's build uses the `engines` field in `package.json`; Node 24 is selected
automatically. If not, set `NODE_VERSION=24`.

---

## 4. Fly.io (also works)

```bash
fly launch --no-deploy
fly volumes create data --size 1
```

In `fly.toml` mount the volume at the app's `data` directory (match the app root
created by `fly launch`, commonly `/app/data`):

```toml
[mounts]
  source = "data"
  destination = "/app/data"
```

Set the same secrets:

```bash
fly secrets set APP_URL=https://your-app.fly.dev APP_SECRET=... COOKIE_SECURE=1 TRUST_PROXY=1 SEED_DEMO=0
fly deploy
fly ssh console -C "npm run owners list"
```

---

## 5. Vercel (public catalogue)

Vercel cannot run the stateful Node server: functions have a read-only filesystem,
`/tmp` is not persistent, `data/revomaker.sqlite` and `data/uploads/` would reset,
and upload payloads exceed the function body limit.

To make the **public site** work on Vercel anyway, this repo includes a static
catalogue mode:

- `scripts/export-static.js` writes `public/data/site.json` from the published
  drops, categories, overview statistics and popular list.
- It also writes `public/data/health.json` and one redirect page per drop under
  `public/go/<slug>.html`.
- `public/js/api.js` detects static mode from `/api/health` and serves every
  public read from the snapshot: homepage, categories, drop detail, related
  drops, search, filtering, sorting and pagination.
- `GET DROP` opens the official destination directly, and `/go/<slug>` redirects
  even when JavaScript is disabled.
- `vercel.json` sets the build command, output directory, clean URLs, and the
  `/admin`, `/admin/login`, `/category/:slug`, `/drop/:slug` and `/api/health`
  routes.

### What works on Vercel

- Every public page, including category and drop detail pages
- Search, lane filters, sorting, pagination and related drops
- View/click totals **as of the last export** (they do not update live)
- GET DROP and the `/go/<slug>` redirect pages
- The read-only notice on the owner sign-in page

### What still needs the Node host

The owner console, login, publishing/editing, image uploads and live analytics
require the database and the server process. Use Render, Railway or Fly.io for
those. On a Vercel deploy, `/admin` redirects to the sign-in page and shows a
read-only notice instead of failing silently.

### Deploying

1. Push the repo to GitHub (section 1).
2. In Vercel: **Add New → Project**, import the repository.
3. Framework Preset: **Other**. Leave the Root Directory empty.
4. Build Command: `npm run build` (also set in `vercel.json`).
5. Output Directory: `public`.
6. Deploy.

`npm run build` runs the exporter. When the database is not present (the normal
case in a Vercel build), the exporter keeps the committed snapshot and refreshes
the redirect pages, so the deploy still succeeds.

### Updating the catalogue

The Vercel site is a snapshot, not a live mirror. After changing drops on the
Node host, refresh and commit the generated files:

```bash
npm run export:static
git add public/data public/go
git commit -m "Refresh static catalogue"
git push
```

Vercel rebuilds on push. Set `SEED_DEMO=0` on the Node host so production data
is not replaced by demo drops.

### Full Vercel migration (optional, large rewrite)

To make the owner console work on Vercel itself you would need to:

1. Refactor `server/index.js` so it exports a request handler and only calls
   `listen()` when run directly.
2. Add `api/index.js` (serverless adapter) and rewrites for `/api/*`, `/go/*` and
   `/admin`.
3. Move the database to a hosted service:
   - **Turso** (hosted SQLite, closest fit) or
   - **Neon / Vercel Postgres**.
   This means replacing the synchronous `node:sqlite` calls in `server/db.js`
   and updating every route to async queries.
4. Move uploads to **Vercel Blob** or S3 and upload directly from the browser
   (to stay under the 4.5 MB function body limit).
5. Move rate limiting to Upstash Redis (optional, but recommended).
6. Provision the three owners against the hosted database.

That is a meaningful rewrite. For the full app without code changes, use
Render/Railway/Fly.io.

---

## 6. Post-deploy checklist

- `GET /api/health` returns `ok: true`
- `GET /api/setup-status` returns `owners: 3, limit: 3, ready: true`
- `/admin/login` loads over HTTPS and the session cookie is `Secure; HttpOnly`
- `npm run owners list` shows exactly three accounts
- `robots.txt` and `sitemap.xml` use the production domain
- demo traffic cleared before launch (`npm run reset:stats`)
- `.owner-credentials.txt` deleted from every machine after storing the passwords
- database + uploads backed up

### Vercel static checks

- `GET /api/health` returns `mode: "static"`
- the homepage shows categories, featured drops and the latest feed
- `/category/steam` and `/drop/<slug>` render their data without `/api/*` errors
- search and lane filters work in the browser
- **GET DROP** opens the official destination (and `/go/<slug>` redirects)
- `/admin/login` shows the read-only notice
