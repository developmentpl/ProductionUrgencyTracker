const express = require('express');
const path    = require('path');
const fs      = require('fs');
const dotenv  = require('dotenv');
const db      = require('./db');

const router = express.Router();

// ── Env helper ────────────────────────────────────────────────────────────────
const _localEnv = (() => {
  const p = path.join(__dirname, '.env');
  return fs.existsSync(p) ? dotenv.parse(fs.readFileSync(p)) : {};
})();
const _getEnv = (k) => (_localEnv[k] !== undefined ? _localEnv[k] : process.env[k]);

// Body parsing
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────
// AUTH — the portal's single sign-on
// ─────────────────────────────────────────────
// No login of our own. Whoever is signed in to the portal is signed in here,
// through its portal_session cookie; editing needs urgency.write in the
// portal's rights matrix (Auth admin → Roles). The TV dashboard and the reads
// it makes stay open: the shop-floor TV has nobody to sign in.
const portalAuth = (() => {
  const candidates = [
    '/var/www/portal-auth/middleware',   // VPS
    '../authentification/middleware',    // local dev, repo name
    '../portal-auth/middleware',         // local dev, older folder name
  ];
  for (const modPath of candidates) {
    try { return require(modPath); }
    catch (e) {
      // Move on only when THIS path is missing — a broken dependency inside
      // the module throws MODULE_NOT_FOUND too and must not be swallowed.
      const missingThisPath =
        e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`'${modPath}'`);
      if (!missingThisPath) throw e;
    }
  }
  console.warn('[production-urgency-tracker] portal-auth not found — editing is disabled.');
  return null;
})();

// Fail closed without portal-auth rather than leave editing open to anyone.
const authUnavailable = (_req, res) =>
  res.status(503).json({ success: false, error: 'Portal sign-in is not available' });
const signedIn = portalAuth ? portalAuth.requireAuth : authUnavailable;
const canRead  = portalAuth ? [signedIn, portalAuth.requirePermission('urgency.read')]  : authUnavailable;
const canEdit  = portalAuth ? [signedIn, portalAuth.requirePermission('urgency.write')] : authUnavailable;

// Admin page — registered ahead of express.static so /admin.html cannot
// bypass the gate. Signed-out browsers are sent to the portal sign-in.
router.get(['/admin', '/admin.html'], signedIn, (req, res) => {
  if (!portalAuth.userHasPermission(req.user, 'urgency.write')) {
    return res.status(403).send(
      '<p style="font:16px system-ui;padding:40px">You are signed in, but your portal role cannot edit the ' +
      'Urgency Tracker. Ask a portal admin for <b>Urgency Tracker → write</b> access. ' +
      '<a href="/">Back to Portal</a></p>');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Static files — public folder
router.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
router.get('/api/health', (_req, res) => res.json({ ok: true }));

async function logActivity(username, action, orderId, woNumber, details) {
  try {
    await db.query(
      `INSERT INTO activity_log (username, action, order_id, wo_number, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [username, action, orderId || null, woNumber || null, details || '']
    );
  } catch (err) {
    console.error('[production-urgency-tracker] logActivity failed', err);
  }
}

// GET /api/me — who the portal says is signed in, for the header badge
router.get('/api/me', signedIn, (req, res) => {
  const { username, display_name, is_admin } = req.user;
  res.json({ success: true, user: { username, display_name, is_admin } });
});

// ─────────────────────────────────────────────
// ACTIVITY LOG — who did what, when
// ─────────────────────────────────────────────
router.get('/api/activity-log', canRead, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const r = await db.query(
      'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT $1', [limit]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────
// GET all active urgent orders
// ─────────────────────────────────────────────
router.get('/api/urgent-orders', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM urgent_orders WHERE is_done = FALSE ORDER BY deadline ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[production-urgency-tracker] GET /api/urgent-orders', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST a new urgent order
// ─────────────────────────────────────────────
router.post('/api/urgent-orders', canEdit, async (req, res) => {
  try {
    const { wo_number, material, customer, priority, deadline, remarks } = req.body;
    if (!wo_number || !customer || !deadline) {
      return res.status(400).json({ success: false, error: 'wo_number, customer, and deadline are required' });
    }
    const by = req.user.display_name || req.user.username;
    const result = await db.query(
      `INSERT INTO urgent_orders (wo_number, material, customer, priority, deadline, remarks, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING *`,
      [wo_number, material || '', customer, priority || 'High', deadline, remarks || '', by]
    );
    logActivity(req.user.username, 'add', result.rows[0].id, wo_number,
      `Added ${wo_number} — ${material || ''} for ${customer} (${priority || 'High'}, deadline ${deadline})`);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[production-urgency-tracker] POST /api/urgent-orders', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PUT — edit an existing urgent order
// ─────────────────────────────────────────────
router.put('/api/urgent-orders/:id', canEdit, async (req, res) => {
  try {
    const { id } = req.params;
    const { wo_number, material, customer, priority, deadline, remarks } = req.body;
    const by = req.user.display_name || req.user.username;
    const result = await db.query(
      `UPDATE urgent_orders SET
         wo_number   = COALESCE($1, wo_number),
         material    = COALESCE($2, material),
         customer    = COALESCE($3, customer),
         priority    = COALESCE($4, priority),
         deadline    = COALESCE($5, deadline),
         remarks     = COALESCE($6, remarks),
         updated_by  = $7,
         updated_at  = NOW()
       WHERE id = $8
       RETURNING *`,
      [wo_number, material, customer, priority, deadline, remarks, by, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    const o = result.rows[0];
    logActivity(req.user.username, 'edit', o.id, o.wo_number,
      `Edited ${o.wo_number} — ${o.material} for ${o.customer} (${o.priority}, deadline ${o.deadline instanceof Date ? o.deadline.toISOString() : o.deadline})`);
    res.json({ success: true, data: o });
  } catch (err) {
    console.error('[production-urgency-tracker] PUT /api/urgent-orders/:id', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// COMPLETE — mark an urgent order as done
// ─────────────────────────────────────────────
router.post('/api/urgent-orders/:id/complete', canEdit, async (req, res) => {
  try {
    const { id } = req.params;
    const by = req.user.display_name || req.user.username;
    const result = await db.query(
      `UPDATE urgent_orders SET is_done = TRUE, updated_by = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [by, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    const o = result.rows[0];
    logActivity(req.user.username, 'complete', o.id, o.wo_number,
      `Completed ${o.wo_number} — ${o.material} for ${o.customer}`);
    res.json({ success: true, data: o });
  } catch (err) {
    console.error('[production-urgency-tracker] POST /api/urgent-orders/:id/complete', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE — remove an urgent order
// ─────────────────────────────────────────────
router.delete('/api/urgent-orders/:id', canEdit, async (req, res) => {
  try {
    const { id } = req.params;
    const old = (await db.query('SELECT wo_number, material, customer FROM urgent_orders WHERE id = $1', [id])).rows[0];
    await db.query('DELETE FROM urgent_orders WHERE id = $1', [id]);
    if (old) {
      logActivity(req.user.username, 'delete', Number(id), old.wo_number,
        `Deleted ${old.wo_number} — ${old.material} for ${old.customer}`);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[production-urgency-tracker] DELETE /api/urgent-orders/:id', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Projects search — WO typeahead in Add form
// Proxies to the projects-table sub-app over the loopback.
// Tries port 3000 then 3010 so the same code works on both VPS deployments.
// Override with PROJECTS_API_URL in .env if needed.
// ─────────────────────────────────────────────
const PROJECTS_API_CANDIDATES = (() => {
  const explicit = _getEnv('PROJECTS_API_URL');
  if (explicit) return [explicit];
  return [
    'http://localhost:3000/projects/api/work-orders',
    'http://localhost:3010/projects/api/work-orders',
  ];
})();

async function fetchProjectsUpstream(q, limit) {
  const params = new URLSearchParams();
  if (q) params.set('search', q);
  params.set('limit', String(limit));
  params.set('page', '1');

  for (const base of PROJECTS_API_CANDIDATES) {
    try {
      const ctrl = new AbortController();
      const t    = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(`${base}?${params}`, {
        signal: ctrl.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(t);
      if (!resp.ok) continue;
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('application/json')) continue;

      const json = await resp.json();
      const list  = Array.isArray(json.data) ? json.data
                  : Array.isArray(json)       ? json
                  : [];
      const total = (json.pagination && Number(json.pagination.total)) || list.length;

      const projects = list
        .map(r => ({
          id:       r.work_order_no != null ? String(r.work_order_no) : '',
          name:     r.wo_name       || '',
          customer: r.company_name  || '',
          status:   r.wo_status     || '',
        }))
        .filter(r => r.id && r.id.trim());

      return { ok: true, projects, total };
    } catch {
      // try next candidate
    }
  }
  return null;
}

router.get('/api/projects/search', async (req, res) => {
  try {
    const q     = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const data  = await fetchProjectsUpstream(q, limit);
    if (data === null) {
      return res.json({ ok: false, projects: [], total: 0, message: 'Projects app did not respond.' });
    }
    res.json(data);
  } catch (err) {
    console.error('[production-urgency-tracker] GET /api/projects/search', err);
    res.json({ ok: false, projects: [], total: 0, message: err.message });
  }
});

// ─────────────────────────────────────────────
// SPA fallback — sends index.html for unmatched GETs
// ─────────────────────────────────────────────
router.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// Error handler
// ─────────────────────────────────────────────
router.use((err, _req, res, _next) => {
  console.error('[production-urgency-tracker]', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

module.exports = router;
