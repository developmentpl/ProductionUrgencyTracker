const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
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

// Static files — public folder
router.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
router.get('/api/health', (_req, res) => res.json({ ok: true }));

// ─────────────────────────────────────────────
// AUTH — multi-user login with sessions
// ─────────────────────────────────────────────
const SESSION_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch { return false; }
}

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

async function requireAuth(req, res, next) {
  try {
    const token = req.headers['x-auth-token']
      || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ success: false, error: 'Not logged in' });
    const r = await db.query(
      `SELECT u.id, u.username, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > NOW() AND u.is_active = TRUE`,
      [token]
    );
    if (r.rows.length === 0) return res.status(401).json({ success: false, error: 'Session expired — please sign in again' });
    req.user = r.rows[0];
    next();
  } catch (err) { next(err); }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

// POST /api/login
router.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: 'Username and password required' });
    const r = await db.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [String(username).trim()]);
    const user = r.rows[0];
    if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: 'Invalid username or password' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${SESSION_DAYS} days')`,
      [token, user.id]
    );
    // Opportunistic cleanup of expired sessions
    db.query('DELETE FROM sessions WHERE expires_at < NOW()').catch(() => {});
    logActivity(user.username, 'login', null, null, 'Signed in');
    res.json({ success: true, token, user: { username: user.username, display_name: user.display_name, role: user.role } });
  } catch (err) {
    console.error('[production-urgency-tracker] POST /api/login', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/logout
router.post('/api/logout', requireAuth, async (req, res) => {
  try {
    const token = req.headers['x-auth-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    await db.query('DELETE FROM sessions WHERE token = $1', [token]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/me — validate stored token on page load
router.get('/api/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ─────────────────────────────────────────────
// USERS — admin-only management
// ─────────────────────────────────────────────
router.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const r = await db.query(
      'SELECT id, username, display_name, role, is_active, created_at FROM users ORDER BY created_at ASC'
    );
    res.json({ success: true, data: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, display_name, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: 'Username and password are required' });
    if (String(password).length < 4) return res.status(400).json({ success: false, error: 'Password must be at least 4 characters' });
    const r = await db.query(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, display_name, role, is_active, created_at`,
      [String(username).trim().toLowerCase(), display_name || username, hashPassword(password), role === 'admin' ? 'admin' : 'user']
    );
    logActivity(req.user.username, 'add-user', null, null, `Added user "${r.rows[0].username}" (${r.rows[0].role})`);
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, error: 'Username already exists' });
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/users/:id — change display name, role, active status, or reset password
router.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, role, is_active, password } = req.body;
    const target = (await db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });
    if (target.id === req.user.id && (is_active === false || (role && role !== 'admin'))) {
      return res.status(400).json({ success: false, error: 'You cannot deactivate or demote your own account' });
    }
    const r = await db.query(
      `UPDATE users SET
         display_name  = COALESCE($1, display_name),
         role          = COALESCE($2, role),
         is_active     = COALESCE($3, is_active),
         password_hash = COALESCE($4, password_hash)
       WHERE id = $5
       RETURNING id, username, display_name, role, is_active, created_at`,
      [display_name, role, is_active, password ? hashPassword(password) : null, id]
    );
    const changes = [];
    if (password) changes.push('reset password');
    if (role && role !== target.role) changes.push(`role → ${role}`);
    if (is_active !== undefined && is_active !== target.is_active) changes.push(is_active ? 'activated' : 'deactivated');
    if (display_name && display_name !== target.display_name) changes.push('renamed');
    logActivity(req.user.username, 'edit-user', null, null, `Updated user "${target.username}": ${changes.join(', ') || 'no changes'}`);
    if (password || is_active === false) {
      await db.query('DELETE FROM sessions WHERE user_id = $1', [id]); // force re-login
    }
    res.json({ success: true, data: r.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (Number(id) === req.user.id) return res.status(400).json({ success: false, error: 'You cannot delete your own account' });
    const target = (await db.query('SELECT username FROM users WHERE id = $1', [id])).rows[0];
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    logActivity(req.user.username, 'delete-user', null, null, `Deleted user "${target.username}"`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────
// ACTIVITY LOG — who did what, when
// ─────────────────────────────────────────────
router.get('/api/activity-log', requireAuth, async (req, res) => {
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
router.post('/api/urgent-orders', requireAuth, async (req, res) => {
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
router.put('/api/urgent-orders/:id', requireAuth, async (req, res) => {
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
router.post('/api/urgent-orders/:id/complete', requireAuth, async (req, res) => {
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
router.delete('/api/urgent-orders/:id', requireAuth, async (req, res) => {
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
// Production Tracker proxy — live WO list
// ─────────────────────────────────────────────
// Fetches work orders from the production-tracker sub-app over the loopback
// (Pattern A from the Integration Guide). Normalises title into WO No. +
// Work Order Name, derives overall status from stage statuses, computes age.
// Both apps run inside the same Node process on localhost, so this is <5 ms.

router.get('/api/production-orders', async (_req, res) => {
  try {
    // If PORTAL_INTERNAL_BASE is explicitly set, use it. Otherwise try port 3000
    // then 3010 so the same code works on both VPS deployments without any env change.
    const explicitBase = _getEnv('PORTAL_INTERNAL_BASE');
    const candidateBases = explicitBase
      ? [explicitBase]
      : ['http://localhost:3000', 'http://localhost:3010'];

    let raw;
    let lastErr;
    for (const base of candidateBases) {
      const ctrl = new AbortController();
      const t    = setTimeout(() => ctrl.abort(), 7000);
      try {
        const resp = await fetch(`${base}/production/api/orders`, {
          signal:  ctrl.signal,
          headers: { 'Accept': 'application/json', 'x-internal-call': 'true' },
        });
        clearTimeout(t);
        if (!resp.ok) throw new Error(`production-tracker → ${resp.status}`);
        const ct = resp.headers.get('content-type') || '';
        if (!ct.includes('application/json')) throw new Error('not JSON');
        raw = await resp.json();
        break; // success — stop trying
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
        // try next candidate
      }
    }
    if (raw === undefined) throw lastErr || new Error('production-tracker unreachable');

    const data = (Array.isArray(raw) ? raw : [])
      .filter(o => {
        // Exclude if completedAt is explicitly stamped
        if (o.completedAt) return false;
        // Also exclude if ALL stages are 'completed' — mirrors getOverallStatus()
        // in the Production Tracker front-end. Many older WOs have completedAt=null
        // because the auto-stamp was added after they were closed.
        const stageStatuses = Object.values(o.stages || {}).map(s => (s.status || '').toLowerCase());
        if (stageStatuses.length > 0 && stageStatuses.every(s => s === 'completed')) return false;
        return true;
      })
      .map(o => {
        const m       = String(o.title || '').match(/^\s*(\d+)\s*[-–—:]\s*(.*)/s);
        const wo_no   = m ? m[1].trim() : '';
        const wo_name = m ? m[2].trim() : (o.title || '');

        const stageStats = Object.values(o.stages || {}).map(s => (s.status || '').toLowerCase());
        let overall = 'Pending';
        if (stageStats.some(s => s === 'delayed'))          overall = 'Delayed';
        else if (stageStats.some(s => s === 'in_progress')) overall = 'In Progress';

        const age_days = o.createdAt
          ? Math.max(0, Math.floor((Date.now() - new Date(o.createdAt)) / 86_400_000))
          : null;

        return {
          id:       o.id,
          wo_no,
          wo_name,
          customer: o.customer || '',
          priority: o.priority || 'Medium',
          overall,
          age_days,
        };
      });

    res.json({ ok: true, data });
  } catch (err) {
    console.error('[production-urgency-tracker] GET /api/production-orders', err);
    res.json({ ok: false, data: [], message: err.message });
  }
});

// ─────────────────────────────────────────────
// Serve admin panel
// ─────────────────────────────────────────────
router.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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
