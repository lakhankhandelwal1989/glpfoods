/**
 * Ganga Lehari Pansari (GLP) — Server
 * Express + PostgreSQL backend for the GLP D2C site.
 *
 * Endpoints:
 *  GET  /                       — landing page (public/index.html)
 *  GET  /admin                  — admin login + dashboard SPA (public/admin.html)
 *  GET  /healthz                — health check
 *
 *  POST /api/leads              — chatbot submits {name, phone, location, language}
 *
 *  POST /admin/api/login        — login with {username, password} → sets httpOnly JWT cookie
 *  POST /admin/api/logout       — clears cookie
 *  GET  /admin/api/me           — current admin (auth check)
 *  GET  /admin/api/leads        — paginated list of customer leads
 *  GET  /admin/api/leads.csv    — CSV export of all leads
 *  DELETE /admin/api/leads/:id  — remove a lead
 *  POST /admin/api/credentials  — change username and/or password
 *
 * Defaults:
 *   On first run (no admin rows), seeds username=Lakhan, password=Lakhan.
 */

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'glp-default-secret-please-set-JWT_SECRET-env-var';
const IS_PROD = process.env.NODE_ENV === 'production';

const DEFAULT_ADMIN_USERNAME = 'Lakhan';
const DEFAULT_ADMIN_PASSWORD = 'Lakhan';

// ───────────────────────── DB ─────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: IS_PROD ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(200) NOT NULL,
      phone       VARCHAR(20)  NOT NULL,
      location    VARCHAR(200),
      language    VARCHAR(10)  DEFAULT 'en',
      source      VARCHAR(50)  DEFAULT 'chatbot',
      created_at  TIMESTAMPTZ  DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at DESC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id            SERIAL PRIMARY KEY,
      username      VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admins');
  if (rows[0].count === 0) {
    const hash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    await pool.query(
      'INSERT INTO admins (username, password_hash) VALUES ($1, $2)',
      [DEFAULT_ADMIN_USERNAME, hash]
    );
    console.log(`[GLP] Seeded default admin → username: ${DEFAULT_ADMIN_USERNAME}, password: ${DEFAULT_ADMIN_PASSWORD}`);
    console.log('[GLP] ⚠ Change the default password immediately after first login.');
  }

  console.log('[GLP] Database initialised.');
}

// ───────────────────────── APP ─────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ─────────────────────── PUBLIC API ──────────────────────
app.post('/api/leads', async (req, res) => {
  try {
    let { name, phone, location, language } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 200) {
      return res.status(400).json({ error: 'Invalid name' });
    }
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 13) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    const cleanLoc = location ? String(location).trim().slice(0, 200) : null;
    const lang = ['en', 'hi'].includes(language) ? language : 'en';

    const result = await pool.query(
      'INSERT INTO customers (name, phone, location, language) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
      [name.trim().slice(0, 200), cleanPhone, cleanLoc, lang]
    );
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error('[GLP] Lead capture error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────── ADMIN AUTH ──────────────────────
function requireAdmin(req, res, next) {
  const token = req.cookies.glp_admin;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('glp_admin');
    res.status(401).json({ error: 'unauthorized' });
  }
}

function issueAdminCookie(res, admin) {
  const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('glp_admin', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

app.post('/admin/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    issueAdminCookie(res, rows[0]);
    res.json({ ok: true, username: rows[0].username });
  } catch (err) {
    console.error('[GLP] Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/admin/api/logout', (req, res) => {
  res.clearCookie('glp_admin');
  res.json({ ok: true });
});

app.get('/admin/api/me', requireAdmin, (req, res) => {
  res.json({ username: req.admin.username, id: req.admin.id });
});

app.get('/admin/api/leads', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await pool.query(
      'SELECT id, name, phone, location, language, source, created_at FROM customers ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    const total = await pool.query('SELECT COUNT(*)::int AS count FROM customers');
    const today = await pool.query("SELECT COUNT(*)::int AS count FROM customers WHERE created_at >= CURRENT_DATE");
    res.json({
      leads: rows,
      total: total.rows[0].count,
      today: today.rows[0].count
    });
  } catch (err) {
    console.error('[GLP] Fetch leads error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/admin/api/leads.csv', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, phone, location, language, source, created_at FROM customers ORDER BY created_at DESC'
    );
    const esc = v => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    let csv = 'ID,Name,Phone,Location,Language,Source,Created At\n';
    for (const r of rows) {
      csv += [r.id, esc(r.name), esc(r.phone), esc(r.location), esc(r.language), esc(r.source), esc(r.created_at?.toISOString())].join(',') + '\n';
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="glp-leads-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[GLP] CSV export error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/admin/api/leads/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
    await pool.query('DELETE FROM customers WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[GLP] Delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/admin/api/credentials', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newUsername, newPassword } = req.body || {};
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });

    const { rows } = await pool.query('SELECT * FROM admins WHERE id = $1', [req.admin.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Admin not found' });

    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password incorrect' });

    const updates = [];
    const params = [];
    let idx = 1;
    let newUname = rows[0].username;

    if (newUsername && newUsername.trim() && newUsername !== rows[0].username) {
      const u = newUsername.trim();
      if (u.length < 3 || u.length > 100) return res.status(400).json({ error: 'Username must be 3–100 characters' });
      const exists = await pool.query('SELECT id FROM admins WHERE username = $1 AND id != $2', [u, req.admin.id]);
      if (exists.rows.length > 0) return res.status(409).json({ error: 'Username already taken' });
      updates.push(`username = $${idx++}`);
      params.push(u);
      newUname = u;
    }

    if (newPassword) {
      if (newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
      const newHash = await bcrypt.hash(newPassword, 10);
      updates.push(`password_hash = $${idx++}`);
      params.push(newHash);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    updates.push(`updated_at = NOW()`);
    params.push(req.admin.id);
    await pool.query(`UPDATE admins SET ${updates.join(', ')} WHERE id = $${idx}`, params);

    // re-issue cookie so the session reflects the new username
    issueAdminCookie(res, { id: req.admin.id, username: newUname });
    res.json({ ok: true, username: newUname });
  } catch (err) {
    console.error('[GLP] Update credentials error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────── ADMIN PAGE ──────────────────────
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─────────────────────── HEALTH ──────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ─────────────────────── BOOT ──────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[GLP] Listening on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('[GLP] Failed to initialise DB:', err);
    process.exit(1);
  });
