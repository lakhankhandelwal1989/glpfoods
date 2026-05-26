/**
 * Ganga Lehari Pansari (GLP) — Server
 * Express + PostgreSQL backend for the GLP D2C site.
 *
 * Public endpoints:
 *  GET  /                            — landing page
 *  GET  /admin                       — admin SPA
 *  GET  /healthz                     — health check
 *  POST /api/leads                   — chatbot lead capture
 *  GET  /api/photos/:productId       — list photo metadata for a product
 *  GET  /api/photo/:id               — serve a single photo (binary)
 *
 * Admin endpoints (require JWT cookie):
 *  POST   /admin/api/login
 *  POST   /admin/api/logout
 *  GET    /admin/api/me
 *  GET    /admin/api/leads
 *  GET    /admin/api/leads.csv
 *  DELETE /admin/api/leads/:id
 *  POST   /admin/api/credentials
 *  POST   /admin/api/photos/:productId   — upload up to 5 photos (base64 JSON)
 *  DELETE /admin/api/photos/:id          — delete a photo
 *  PATCH  /admin/api/photos/reorder      — update sort_order array
 *
 * Photo storage: base64-encoded image data stored in PostgreSQL (TEXT column).
 * No external storage service required. Max 5 photos per product, 4 MB each.
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

const VALID_PRODUCTS = ['dv', 'cm', 'db']; // Dahi Vada, Chaat Masala, Doodh Bahaar
const MAX_PHOTOS_PER_PRODUCT = 5;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // 4 MB per image

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

  // Product photos — images stored as base64 text in PostgreSQL
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_photos (
      id          SERIAL PRIMARY KEY,
      product_id  VARCHAR(20)  NOT NULL,
      filename    VARCHAR(255) DEFAULT 'photo',
      mimetype    VARCHAR(50)  DEFAULT 'image/jpeg',
      data        TEXT         NOT NULL,
      sort_order  INT          DEFAULT 0,
      uploaded_at TIMESTAMPTZ  DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_photos_product ON product_photos(product_id, sort_order);`);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admins');
  if (rows[0].count === 0) {
    const hash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    await pool.query(
      'INSERT INTO admins (username, password_hash) VALUES ($1, $2)',
      [DEFAULT_ADMIN_USERNAME, hash]
    );
    console.log(`[GLP] Seeded default admin → username: ${DEFAULT_ADMIN_USERNAME}, password: ${DEFAULT_ADMIN_PASSWORD}`);
    console.log('[GLP] ⚠  Change the default password immediately after first login.');
  }

  console.log('[GLP] Database initialised.');
}

// ───────────────────────── APP ─────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' })); // large enough for base64 image batches
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ─────────────────── PUBLIC: LEADS ───────────────────
app.post('/api/leads', async (req, res) => {
  try {
    let { name, phone, location, language } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 200)
      return res.status(400).json({ error: 'Invalid name' });
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 13)
      return res.status(400).json({ error: 'Invalid phone number' });
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

// ─────────────────── PUBLIC: PHOTOS ───────────────────
// List photo metadata (ids + order) for a product — frontend uses these ids to build <img src>
app.get('/api/photos/:productId', async (req, res) => {
  const pid = req.params.productId;
  if (!VALID_PRODUCTS.includes(pid)) return res.status(400).json({ error: 'Invalid product' });
  try {
    const { rows } = await pool.query(
      'SELECT id, filename, mimetype, sort_order, uploaded_at FROM product_photos WHERE product_id = $1 ORDER BY sort_order ASC, id ASC',
      [pid]
    );
    res.json({ photos: rows });
  } catch (err) {
    console.error('[GLP] Photo list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve a single photo by id — streams binary image
app.get('/api/photo/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).send('Invalid id');
  try {
    const { rows } = await pool.query('SELECT mimetype, data FROM product_photos WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).send('Not found');
    const buf = Buffer.from(rows[0].data, 'base64');
    res.setHeader('Content-Type', rows[0].mimetype || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (err) {
    console.error('[GLP] Photo serve error:', err);
    res.status(500).send('Server error');
  }
});

// ─────────────────── ADMIN AUTH ───────────────────────
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
    httpOnly: true, sameSite: 'lax', secure: IS_PROD,
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

app.post('/admin/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
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

// ─────────────────── ADMIN: LEADS ────────────────────
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
    res.json({ leads: rows, total: total.rows[0].count, today: today.rows[0].count });
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
    for (const r of rows)
      csv += [r.id, esc(r.name), esc(r.phone), esc(r.location), esc(r.language), esc(r.source), esc(r.created_at?.toISOString())].join(',') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="glp-leads-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) {
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
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/admin/api/credentials', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newUsername, newPassword } = req.body || {};
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    const { rows } = await pool.query('SELECT * FROM admins WHERE id = $1', [req.admin.id]);
    if (!rows.length) return res.status(404).json({ error: 'Admin not found' });
    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password incorrect' });
    const updates = []; const params = []; let idx = 1; let newUname = rows[0].username;
    if (newUsername && newUsername.trim() && newUsername !== rows[0].username) {
      const u = newUsername.trim();
      if (u.length < 3 || u.length > 100) return res.status(400).json({ error: 'Username must be 3–100 characters' });
      const exists = await pool.query('SELECT id FROM admins WHERE username = $1 AND id != $2', [u, req.admin.id]);
      if (exists.rows.length) return res.status(409).json({ error: 'Username already taken' });
      updates.push(`username = $${idx++}`); params.push(u); newUname = u;
    }
    if (newPassword) {
      if (newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
      updates.push(`password_hash = $${idx++}`); params.push(await bcrypt.hash(newPassword, 10));
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push(`updated_at = NOW()`); params.push(req.admin.id);
    await pool.query(`UPDATE admins SET ${updates.join(', ')} WHERE id = $${idx}`, params);
    issueAdminCookie(res, { id: req.admin.id, username: newUname });
    res.json({ ok: true, username: newUname });
  } catch (err) {
    console.error('[GLP] Credentials error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────── ADMIN: PHOTOS ───────────────────
// Upload 1–5 photos for a product
// Body: { photos: [{ filename, mimetype, data }] } where data is base64 string
app.post('/admin/api/photos/:productId', requireAdmin, async (req, res) => {
  const pid = req.params.productId;
  if (!VALID_PRODUCTS.includes(pid)) return res.status(400).json({ error: 'Invalid product ID. Must be dv, cm, or db.' });

  const { photos } = req.body || {};
  if (!Array.isArray(photos) || photos.length === 0)
    return res.status(400).json({ error: 'Provide photos array' });

  try {
    // Count existing
    const { rows: existing } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM product_photos WHERE product_id = $1', [pid]
    );
    const slots = MAX_PHOTOS_PER_PRODUCT - existing[0].count;
    if (slots <= 0) return res.status(400).json({ error: `Already have ${MAX_PHOTOS_PER_PRODUCT} photos for this product. Delete some first.` });

    const toInsert = photos.slice(0, slots);
    const inserted = [];

    for (let i = 0; i < toInsert.length; i++) {
      const { filename = 'photo', mimetype = 'image/jpeg', data } = toInsert[i];
      if (typeof data !== 'string' || !data) continue;

      // Strip data URL prefix if present (data:image/jpeg;base64,...)
      const base64 = data.replace(/^data:[^;]+;base64,/, '');

      // Rough size check
      const approxBytes = Math.ceil(base64.length * 0.75);
      if (approxBytes > MAX_PHOTO_BYTES)
        return res.status(400).json({ error: `Photo "${filename}" exceeds 4 MB limit` });

      const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/avif'];
      const mt = allowed.includes(mimetype) ? mimetype : 'image/jpeg';

      // Sort order = current max + index
      const { rows: maxRow } = await pool.query(
        'SELECT COALESCE(MAX(sort_order), -1) AS mx FROM product_photos WHERE product_id = $1', [pid]
      );
      const sortOrder = maxRow[0].mx + 1 + i;

      const { rows } = await pool.query(
        'INSERT INTO product_photos (product_id, filename, mimetype, data, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id, filename, mimetype, sort_order, uploaded_at',
        [pid, String(filename).slice(0, 255), mt, base64, sortOrder]
      );
      inserted.push(rows[0]);
    }

    res.json({ ok: true, inserted, skipped: photos.length - toInsert.length });
  } catch (err) {
    console.error('[GLP] Photo upload error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a product photo
app.delete('/admin/api/photos/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    await pool.query('DELETE FROM product_photos WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Reorder photos — body: { productId, order: [id, id, id, ...] }
app.patch('/admin/api/photos/reorder', requireAdmin, async (req, res) => {
  const { productId, order } = req.body || {};
  if (!VALID_PRODUCTS.includes(productId) || !Array.isArray(order))
    return res.status(400).json({ error: 'Invalid payload' });
  try {
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE product_photos SET sort_order = $1 WHERE id = $2 AND product_id = $3',
        [i, order[i], productId]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────── STATIC PAGES ────────────────────
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ─────────────────── BOOT ────────────────────────────
initDb()
  .then(() => app.listen(PORT, () => console.log(`[GLP] Listening on http://localhost:${PORT}`)))
  .catch(err => { console.error('[GLP] Failed to initialise DB:', err); process.exit(1); });
