const crypto = require('crypto');
const db     = require('../db');

const username     = 'sadanand';
const displayName  = 'Sadanand';
const password     = '1111';
const role         = 'admin';

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
const passwordHash = `${salt}:${hash}`;

db.query(
  `INSERT INTO users (username, display_name, password_hash, role)
   VALUES ($1, $2, $3, $4)
   ON CONFLICT (username) DO UPDATE SET password_hash = $3, display_name = $2, role = $4`,
  [username, displayName, passwordHash, role]
)
  .then(() => { console.log(`✅ Admin user "${username}" created/updated. Password: ${password}`); process.exit(0); })
  .catch(e  => { console.error('❌ Error:', e.message); process.exit(1); });
