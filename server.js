const express = require('express');
const path    = require('path');
const db      = require('./db');

const router = express.Router();

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
