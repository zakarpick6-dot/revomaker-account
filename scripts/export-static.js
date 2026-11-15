'use strict';

/**
 * Build a read-only catalogue snapshot for static hosts (Vercel).
 *
 * The live app is a stateful Node server. On a static host there is no
 * `/api/*`, no SQLite database and no `/go/:slug` handler, so the public site
 * reads this snapshot instead. Run this after changing drops:
 *
 *   npm run export:static
 *
 * When the database is absent (for example during a Vercel build) the
 * committed snapshot is kept as-is. Nothing private is written: no users,
 * emails, sessions, hashes or uploads — only published drop data that the
 * public API already exposes.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(PUBLIC_DIR, 'data');
const GO_DIR = path.join(PUBLIC_DIR, 'go');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'site.json');
const HEALTH_FILE = path.join(DATA_DIR, 'health.json');
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(ROOT, 'data', 'revomaker.sqlite');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GO_DIR, { recursive: true });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsString(value) {
  return JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function hostOf(value) {
  try {
    return new URL(String(value)).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function buildFromDatabase() {
  const { all, get } = require('../server/db');
  const { serialize } = require('../server/routes/public');
  const { categoryStats, publicOverview, popularDrops, series } = require('../server/stats');

  const rows = all(
    `SELECT d.*, c.slug AS category_slug, c.name AS category_name,
            c.accent AS category_accent, c.icon AS category_icon
       FROM drops d
       JOIN categories c ON c.id = d.category_id
      WHERE d.status = 'published'
      ORDER BY d.published_at DESC, d.id DESC`
  );

  const drops = rows.map(serialize).map((drop) => ({
    ...drop,
    externalUrl: safeExternalUrl(drop.externalUrl) || drop.externalUrl,
    externalHost: hostOf(drop.externalUrl),
  }));

  const owners = get('SELECT COUNT(*) AS c FROM users').c;
  const overview = publicOverview();

  return {
    generatedAt: new Date().toISOString(),
    mode: 'static',
    overview,
    categories: categoryStats(),
    drops,
    popular: popularDrops(10),
    activity: { series: series(30) },
    setup: { owners, limit: 3, ready: owners > 0 },
  };
}

function readSnapshot() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.drops)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildRedirectPages(snapshot) {
  fs.rmSync(GO_DIR, { recursive: true, force: true });
  fs.mkdirSync(GO_DIR, { recursive: true });

  let written = 0;
  for (const drop of snapshot.drops || []) {
    if (!/^[a-z0-9-]{1,80}$/.test(String(drop.slug || ''))) continue;
    const url = safeExternalUrl(drop.externalUrl);
    if (!url) continue;

    const title = drop.title || 'this drop';
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="referrer" content="no-referrer" />
<meta http-equiv="refresh" content="0;url=${escapeHtml(url)}" />
<title>Opening ${escapeHtml(title)} — REVOMAKER STEAM</title>
<link rel="icon" type="image/png" href="/assets/brand/favicon.png" />
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
         background: #0b0710; color: #f4f0ff; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 34rem; text-align: center; border: 1px solid #2a2036; border-radius: 18px;
         padding: 32px 28px; background: #140d1d; }
  p { margin: 0 0 14px; color: #c9bfe0; }
  strong { color: #fff; }
  a { color: #c4b5fd; }
</style>
</head>
<body>
<main>
  <p>Opening <strong>${escapeHtml(title)}</strong>…</p>
  <p><a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow">Continue to the official destination</a></p>
</main>
<script>window.location.replace(${jsString(url)});</script>
</body>
</html>
`;
    fs.writeFileSync(path.join(GO_DIR, `${drop.slug}.html`), html, 'utf8');
    written += 1;
  }
  return written;
}

function writeHealth(mode = 'static') {
  writeJson(HEALTH_FILE, {
    ok: true,
    service: 'revomaker-steam',
    version: '1.0.0',
    mode,
    time: new Date().toISOString(),
  });
}

function main() {
  ensureDirs();

  if (!fs.existsSync(DB_PATH)) {
    const snapshot = readSnapshot();
    if (!snapshot) {
      console.error(`No database at ${DB_PATH} and no ${SNAPSHOT_FILE}.`);
      console.error('Run "npm run export:static" on a machine that has the database.');
      process.exit(1);
    }
    const redirects = buildRedirectPages(snapshot);
    writeHealth('static');
    console.log(
      `No database at ${DB_PATH}; kept the committed snapshot ` +
        `(${snapshot.drops.length} drops, ${redirects} redirect pages).`
    );
    return;
  }

  const snapshot = buildFromDatabase();
  writeJson(SNAPSHOT_FILE, snapshot);
  const redirects = buildRedirectPages(snapshot);
  writeHealth('static');

  console.log(
    `Exported ${snapshot.drops.length} published drops, ` +
      `${snapshot.categories.length} categories and ${redirects} redirect pages.`
  );
  console.log(`Snapshot: ${path.relative(ROOT, SNAPSHOT_FILE)}`);
}

main();
