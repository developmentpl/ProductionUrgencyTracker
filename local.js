require('dotenv').config();
const express = require('express');
const router  = require('./server');

const app   = express();
const PORT  = process.env.PORT || 3001;
const MOUNT = '/urgency';

app.get('/', (_req, res) => res.redirect(MOUNT + '/'));
app.use(MOUNT, router);

app.listen(PORT, () => {
  console.log(`\nProduction Urgency Tracker running at http://localhost:${PORT}${MOUNT}/`);
  console.log(`  Dashboard: http://localhost:${PORT}${MOUNT}/`);
  console.log(`  Admin:     http://localhost:${PORT}${MOUNT}/admin`);
  console.log(`  API:       http://localhost:${PORT}${MOUNT}/api/urgent-orders\n`);
});
