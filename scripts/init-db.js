const fs   = require('fs');
const path = require('path');
const db   = require('../db');

async function main() {
  // Apply schema
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  console.log('Applying schema...');
  await db.query(sql);

  // Seed initial data only if table is empty
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM urgent_orders');
  if (rows[0].n === 0) {
    console.log('Seeding initial data...');
    const seed = [
      { wo_number: 'WO-272', material: 'Crane Sticker WLL',              customer: 'Cyrus Industrial',          priority: 'Critical', deadline: '2026-05-30T18:00:00Z', submitted_at: '2026-05-30T14:30:00Z', remarks: 'Urgent delivery to site, no delay' },
      { wo_number: 'WO-271', material: 'Treated Water Signages',          customer: 'Sodexo',                    priority: 'High',     deadline: '2026-05-30T20:00:00Z', submitted_at: '2026-05-30T13:00:00Z', remarks: 'Safety compliance required' },
      { wo_number: 'WO-270', material: 'Cleanline Sticker',               customer: 'GE',                        priority: 'High',     deadline: '2026-05-30T21:00:00Z', submitted_at: '2026-05-30T13:30:00Z', remarks: 'Client requested same-day dispatch' },
      { wo_number: 'WO-269', material: 'World Environment Day 2026 Board',customer: 'Schaffler',                 priority: 'Medium',   deadline: '2026-05-31T10:00:00Z', submitted_at: '2026-05-30T12:00:00Z', remarks: 'Event on 5 June, prep starts tomorrow' },
      { wo_number: 'WO-268', material: 'Work Permit Board',               customer: 'Schaeffler India Limited-Talegaon', priority: 'Critical', deadline: '2026-05-30T19:30:00Z', submitted_at: '2026-05-30T11:00:00Z', remarks: 'In progress - client waiting at factory gate' },
      { wo_number: 'WO-267', material: 'SCM Functioning Area Signage',    customer: 'Gabriel',                   priority: 'High',     deadline: '2026-05-30T22:00:00Z', submitted_at: '2026-05-30T10:30:00Z', remarks: 'Safety zone signage, pending approval' },
      { wo_number: 'WO-265', material: 'Webbing Sling WLL Board',         customer: 'Ultara',                    priority: 'Medium',   deadline: '2026-05-31T12:00:00Z', submitted_at: '2026-05-30T09:00:00Z', remarks: 'crane safety compliance board' },
      { wo_number: 'WO-256', material: 'B1800 Kaizen Wall Branding',      customer: 'Jabil',                     priority: 'Critical', deadline: '2026-05-30T17:30:00Z', submitted_at: '2026-05-30T12:00:00Z', remarks: 'CEO visit tomorrow morning - cutting in progress' },
      { wo_number: 'WO-254', material: 'World Environment Day 2026 Signage', customer: 'Precast India',          priority: 'High',     deadline: '2026-05-31T14:00:00Z', submitted_at: '2026-05-30T08:30:00Z', remarks: 'Delayed - needs priority push' },
      { wo_number: 'WO-252', material: '5S Nameplate Set',                customer: 'Jabil',                     priority: 'High',     deadline: '2026-05-31T09:00:00Z', submitted_at: '2026-05-30T15:00:00Z', remarks: 'CNC routing in progress' },
    ];

    for (const o of seed) {
      await db.query(
        `INSERT INTO urgent_orders (wo_number, material, customer, priority, deadline, submitted_at, remarks)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [o.wo_number, o.material, o.customer, o.priority, o.deadline, o.submitted_at, o.remarks]
      );
    }
    console.log(`Seeded ${seed.length} orders.`);
  } else {
    console.log(`Skipping seed — table already has ${rows[0].n} rows.`);
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => { console.error('init-db failed:', err); process.exit(1); });
