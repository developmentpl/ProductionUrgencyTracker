const express = require('express');
const path    = require('path');
const fs      = require('fs');
const dotenv  = require('dotenv');
const { Pool }= require('pg');
const db      = require('./db');

const router = express.Router();

// ── Print-Order Details DB pool (read-only, for WO typeahead) ─────────────────
// Derive the print_order_details URL from this app's own DATABASE_URL by
// swapping the DB name. Both DBs use fivesuser on the same Postgres instance.
const _localEnv = (() => {
  const p = path.join(__dirname, '.env');
  return fs.existsSync(p) ? dotenv.parse(fs.readFileSync(p)) : {};
})();
const _getEnv = (k) => (_localEnv[k] !== undefined ? _localEnv[k] : process.env[k]);

let _printOrderPool = null;
function getPrintOrderPool() {
  if (_printOrderPool) return _printOrderPool;
  const base = _getEnv('DATABASE_URL') || '';
  const url  = base.replace(/\/[^/?]+(\?.*)?$/, '/print_order_details$1');
  if (!url) return null;
  _printOrderPool = new Pool({ connectionString: url });
  return _printOrderPool;
}

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
router.post('/api/urgent-orders', async (req, res) => {
  try {
    const { wo_number, material, customer, priority, deadline, remarks } = req.body;
    if (!wo_number || !customer || !deadline) {
      return res.status(400).json({ success: false, error: 'wo_number, customer, and deadline are required' });
    }
    const result = await db.query(
      `INSERT INTO urgent_orders (wo_number, material, customer, priority, deadline, remarks)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [wo_number, material || '', customer, priority || 'High', deadline, remarks || '']
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[production-urgency-tracker] POST /api/urgent-orders', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PUT — edit an existing urgent order
// ─────────────────────────────────────────────
router.put('/api/urgent-orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { wo_number, material, customer, priority, deadline, remarks } = req.body;
    const result = await db.query(
      `UPDATE urgent_orders SET
         wo_number   = COALESCE($1, wo_number),
         material    = COALESCE($2, material),
         customer    = COALESCE($3, customer),
         priority    = COALESCE($4, priority),
         deadline    = COALESCE($5, deadline),
         remarks     = COALESCE($6, remarks),
         updated_at  = NOW()
       WHERE id = $7
       RETURNING *`,
      [wo_number, material, customer, priority, deadline, remarks, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[production-urgency-tracker] PUT /api/urgent-orders/:id', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE — remove an urgent order
// ─────────────────────────────────────────────
router.delete('/api/urgent-orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM urgent_orders WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[production-urgency-tracker] DELETE /api/urgent-orders/:id', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Print-Order search — WO typeahead in Add form
// ─────────────────────────────────────────────
router.get('/api/print-orders/search', async (req, res) => {
  try {
    const pool = getPrintOrderPool();
    if (!pool) return res.json({ ok: false, items: [], message: 'Print Order DB not configured.' });

    const q = (req.query.q || '').trim();
    let rows;
    if (q) {
      ({ rows } = await pool.query(
        `SELECT DISTINCT ON (wo_no)
           wo_no, wo_name, company_name
         FROM print_details
         WHERE wo_no IS NOT NULL
           AND (CAST(wo_no AS TEXT) ILIKE $1 OR wo_name ILIKE $1 OR company_name ILIKE $1)
         ORDER BY wo_no DESC, added_time DESC NULLS LAST
         LIMIT 60`,
        [`%${q}%`]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT DISTINCT ON (wo_no) wo_no, wo_name, company_name
         FROM print_details
         WHERE wo_no IS NOT NULL
         ORDER BY wo_no DESC, added_time DESC NULLS LAST
         LIMIT 60`
      ));
    }

    const items = rows.map(r => ({
      wo_number:     String(r.wo_no),
      title:         r.wo_name      || '',
      customer_name: r.company_name || '',
    }));
    res.json({ ok: true, items });
  } catch (err) {
    console.error('[production-urgency-tracker] GET /api/print-orders/search', err);
    res.json({ ok: false, items: [], message: err.message });
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
    const base = _getEnv('PORTAL_INTERNAL_BASE') || 'http://localhost:3000';
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 7000);

    let raw;
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
    } finally { clearTimeout(t); }

    const data = (Array.isArray(raw) ? raw : [])
      .filter(o => !o.completedAt)                  // skip fully-completed WOs
      .map(o => {
        // Split "10836 - Zero defect hpt" → wo_no="10836", wo_name="Zero defect hpt"
        const m       = String(o.title || '').match(/^\s*(\d+)\s*[-–—:]\s*(.*)/s);
        const wo_no   = m ? m[1].trim() : '';
        const wo_name = m ? m[2].trim() : (o.title || '');

        // Derive overall status from all stage statuses
        const stageStats = Object.values(o.stages || {}).map(s => (s.status || '').toLowerCase());
        let overall = 'Pending';
        if (stageStats.some(s => s === 'delayed'))       overall = 'Delayed';
        else if (stageStats.some(s => s === 'in_progress')) overall = 'In Progress';

        // Calendar days since WO creation
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
