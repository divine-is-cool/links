/**
 * server.js
 *
 * Minimal Express server to power the Link Portal. 
 *
 * - Serves static files from project root (index.html, styles.css, script.js, etc.)
 * - Implements JSON-backed persistence in data.json for folders/links and claim timers
 * - Identifies visitors via an HttpOnly cookie (divine_uid)
 * - Enforces a 7-day-per-user claim cooldown (server-side)
 * - Admin flows (API endpoints for admin actions)
 *
 * Environment: 
 *  - ADMIN_PIN                 (required to administer)
 *  - ADMIN_SESSION_SECRET      (recommended, for express-session; fallback created if missing)
 *  - PORT                      (optional, default 3000)
 *
 * Data persistence file:  ./data.json (created if missing)
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');

const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_PIN = process. env.ADMIN_PIN || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || (Math.random().toString(36).slice(2) + Date.now());
const PORT = parseInt(process.env.PORT || '3000', 10);

// Basic in-memory rate-limit of PIN attempts per IP (prevents server-side brute force)
const pinAttempts = {}; // { ip: { count, lockUntil } }
const PIN_MAX_ATTEMPTS = 6;
const PIN_LOCK_MS = 60 * 1000;

const CLAIM_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // 7 days

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // ensure shape
    parsed.folders = Array.isArray(parsed.folders) ? parsed.folders : [];
    parsed.claims = parsed.claims && typeof parsed.claims === 'object' ? parsed.claims : {};
    return parsed;
  } catch (e) {
    // create initial data structure
    const init = { folders: [], claims: {} };
    await saveData(init);
    return init;
  }
}

let DATA_LOCK = Promise.resolve(); // simple queue so writes don't overlap
async function saveData(d) {
  // queue writes
  DATA_LOCK = DATA_LOCK.then(async () => {
    const tmp = DATA_FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(d, null, 2), 'utf8');
    await fs.rename(tmp, DATA_FILE);
  }).catch((err) => {
    console.error('Error saving data. json:', err);
  });
  return DATA_LOCK;
}

async function findLinkById(data, linkId) {
  for (const folder of data.folders || []) {
    for (const link of folder.links || []) {
      if (link.id === linkId) return { folder, link };
    }
  }
  return null;
}

function ensureUrlSafe(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Prevent data: , javascript:  etc. 
    return u.toString();
  } catch (e) {
    return null;
  }
}

const app = express();
app.use(
  helmet({
    frameguard: false, // Disable X-Frame-Options to allow iframe embedding
    contentSecurityPolicy:  false, // Disable CSP to allow iframe embedding
  })
);
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());
app.use(session({
  secret: ADMIN_SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { sameSite: 'strict', httpOnly: true, secure: false } // secure should be true behind TLS in production
}));

// ---- KEY LINE: Serve all static files from the project root ----
app.use(express.static(__dirname));
// -----------------------------------------------------------------

// Middleware to identify user with a cookie
app.use((req, res, next) => {
  let id = req.cookies && req.cookies.divine_uid;
  if (!id) {
    id = uuidv4();
    // cookie path root so client scripts can access it if needed; HttpOnly for security
    res.cookie('divine_uid', id, { httpOnly: true, sameSite: 'strict', maxAge: 10 * 365 * 24 * 3600 * 1000, path: '/' });
  }
  req.divine_uid = id;
  next();
});

// (Optional explicit root handler - static() will serve index.html by default)
// app.get('/', (req, res) => {
//   res.sendFile(path.join(__dirname, 'index.html'));
// });

// ----------------- API ROUTES BELOW ------------------

// API:  get folders & links
app.get('/divine/api/sites/links', async (req, res) => {
  const data = await loadData();
  // respond with small shape (don't include claim info)
  const out = (data.folders || []).map(f => ({
    id: f. id,
    title: f.title,
    links: (f.links || []).map(l => ({ id: l.id, name: l.name, url: l. url }))
  }));
  res.json(out);
});

// API: claim a link (enforce 7-day global claim cooldown per user)
app.post('/divine/api/sites/claim', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, message: 'Missing id' });

  const data = await loadData();
  const found = await findLinkById(data, id);
  if (!found) return res.status(404).json({ ok: false, message:  'Not found' });

  const userId = req.divine_uid;
  const record = data.claims[userId] || {};
  const last = record.lastClaimAt || 0;
  const now = Date.now();

  if (last && (now - last) < CLAIM_COOLDOWN_MS) {
    const retryAfter = Math.ceil((CLAIM_COOLDOWN_MS - (now - last)) / 1000);
    return res.status(429).json({ ok: false, retryAfter });
  }

  // record claim and persist
  data.claims[userId] = { lastClaimAt: now };
  await saveData(data);

  // Return the URL so the client can redirect
  return res.json({ ok: true, url: found.link.url });
});

// Admin PIN attempt helper
function ipKey(req) {
  return req.ip || req.headers['x-forwarded-for'] || 'unknown';
}

function isIpLocked(ip) {
  const s = pinAttempts[ip];
  if (!s) return false;
  if (s.lockUntil && s.lockUntil > Date.now()) return true;
  return false;
}

function registerPinFailure(ip) {
  const s = pinAttempts[ip] || { count: 0, lockUntil: 0 };
  s.count++;
  if (s.count >= PIN_MAX_ATTEMPTS) {
    s.lockUntil = Date.now() + PIN_LOCK_MS;
    s.count = 0;
  }
  pinAttempts[ip] = s;
}

// Admin:  verify PIN -> sets session. isAdmin true for subsequent admin calls
app.post('/divine/admin/sites/verify-pin', (req, res) => {
  const ip = ipKey(req);
  if (isIpLocked(ip)) {
    return res.status(429).json({ ok: false, message: 'Too many attempts.  Try again later.' });
  }

  const { pin } = req.body || {};
  if (!pin || ! ADMIN_PIN) {
    registerPinFailure(ip);
    return res.status(401).json({ ok: false });
  }

  if (String(pin) === String(ADMIN_PIN)) {
    req.session.isAdmin = true;
    // reset IP attempt state
    delete pinAttempts[ip];
    return res.json({ ok: true });
  } else {
    registerPinFailure(ip);
    return res.status(401).json({ ok: false });
  }
});

// Middleware for admin-protected endpoints
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ ok: false, message: 'unauthorized' });
}

// Admin: add folder
app.post('/divine/admin/sites/add-folder', requireAdmin, async (req, res) => {
  const { title } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ ok: false, message: 'title required' });
  const data = await loadData();
  const id = 'folder-' + uuidv4();
  data.folders.push({ id, title:  String(title).trim(), links: [] });
  await saveData(data);
  res.json({ ok: true, id });
});

// Admin: remove folder (and its links)
app.post('/divine/admin/sites/remove-folder', requireAdmin, async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, message: 'id required' });
  const data = await loadData();
  const idx = (data.folders || []).findIndex(f => f.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, message: 'not found' });
  data.folders.splice(idx, 1);
  await saveData(data);
  res.json({ ok: true });
});

// Admin: add link to folder
app.post('/divine/admin/sites/add-link', requireAdmin, async (req, res) => {
  const { folderId, name, url } = req.body || {};
  if (!folderId || !name || !url) return res.status(400).json({ ok: false, message: 'folderId, name, url required' });

  const safe = ensureUrlSafe(String(url).trim());
  if (!safe) return res.status(400).json({ ok: false, message: 'invalid url' });

  const data = await loadData();
  const folder = (data.folders || []).find(f => f.id === folderId);
  if (!folder) return res.status(404).json({ ok: false, message: 'folder not found' });

  const id = 'link-' + uuidv4();
  const link = { id, name:  String(name).trim(), url: safe };
  folder.links = folder.links || [];
  folder. links.push(link);
  await saveData(data);
  res.json({ ok: true, id });
});

// Admin: remove link
app.post('/divine/admin/sites/remove-link', requireAdmin, async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, message: 'id required' });

  const data = await loadData();
  for (const f of data.folders || []) {
    const li = (f.links || []).findIndex(l => l.id === id);
    if (li !== -1) {
      f.links.splice(li, 1);
      await saveData(data);
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ ok: false, message: 'link not found' });
});

// Admin: clear my timer (clears the claim cooldown for the current divine_uid)
app.post('/divine/admin/sites/clear-my-timer', requireAdmin, async (req, res) => {
  const userId = req.divine_uid;
  const data = await loadData();
  if (data.claims && data.claims[userId]) {
    delete data.claims[userId];
    await saveData(data);
  }
  res.json({ ok: true });
});

// Health check
app.get('/_health', (req, res) => res.json({ ok: true }));

// Catch-all 404 for API
app.use('/divine/api', (req, res) => res.status(404).json({ ok: false, message: 'not found' }));

// Start server
(async function start() {
  // Ensure data file exists
  await loadData();

  if (!ADMIN_PIN) {
    console.warn('WARNING:  ADMIN_PIN is not set. Administrative endpoints will always reject (set ADMIN_PIN in env).');
  }

  app.listen(PORT, () => {
    console.log(`Divine server listening on port ${PORT}`);
    console.log('Serving static files from project root');
  });
})();
