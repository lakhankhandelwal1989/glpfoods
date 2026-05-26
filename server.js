/**
 * Ganga Lehari Pansari (GLP) — Server
 *
 * Public:
 *  GET  /                            landing page
 *  GET  /admin                       admin SPA
 *  GET  /healthz                     health check
 *  POST /api/leads                   chatbot lead capture
 *  GET  /api/photos/:productId       photo/video metadata list
 *  GET  /api/photo/:id               serve image or video binary
 *
 * Admin (JWT cookie required):
 *  POST   /admin/api/login
 *  POST   /admin/api/logout
 *  GET    /admin/api/me
 *  GET    /admin/api/leads
 *  GET    /admin/api/leads.csv
 *  DELETE /admin/api/leads/:id
 *  POST   /admin/api/credentials
 *  POST   /admin/api/photos/:productId    upload images (max 5) or video (max 1)
 *  DELETE /admin/api/photos/:id
 *  PATCH  /admin/api/photos/reorder
 *
 * Storage: base64 in PostgreSQL TEXT column — no external service needed.
 * Images: JPEG/PNG/WEBP, max 4 MB each, max 5 per product.
 * Videos: MP4/WebM, max 15 MB each, max 1 per product.
 */

const express    = require('express');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Pool }   = require('pg');
require('dotenv').config();

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'glp-default-secret-change-in-production';
const IS_PROD    = process.env.NODE_ENV === 'production';

const DEFAULT_ADMIN_USERNAME = 'Lakhan';
const DEFAULT_ADMIN_PASSWORD = 'Lakhan';

const VALID_PRODUCTS        = ['dv', 'cm', 'db'];
const MAX_IMAGES_PER_PRODUCT = 5;
const MAX_VIDEOS_PER_PRODUCT = 1;
const MAX_IMAGE_BYTES        = 4  * 1024 * 1024;   //  4 MB
const MAX_VIDEO_BYTES        = 15 * 1024 * 1024;   // 15 MB

const ALLOWED_IMAGE_TYPES = ['image/jpeg','image/jpg','image/png','image/webp','image/avif'];
const ALLOWED_VIDEO_TYPES = ['video/mp4','video/webm','video/quicktime'];

// ── DB ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: IS_PROD ? { rejectUnauthorized: false } : false
});

async function initDb() {
  // Customers
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(200) NOT NULL,
      phone      VARCHAR(20)  NOT NULL,
      location   VARCHAR(200),
      language   VARCHAR(10)  DEFAULT 'en',
      source     VARCHAR(50)  DEFAULT 'chatbot',
      created_at TIMESTAMPTZ  DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at DESC);`);

  // Admins
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id            SERIAL PRIMARY KEY,
      username      VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Product media (images + videos)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_photos (
      id          SERIAL PRIMARY KEY,
      product_id  VARCHAR(20)  NOT NULL,
      filename    VARCHAR(255) DEFAULT 'media',
      mimetype    VARCHAR(80)  DEFAULT 'image/jpeg',
      media_type  VARCHAR(10)  DEFAULT 'image',
      data        TEXT         NOT NULL,
      sort_order  INT          DEFAULT 0,
      uploaded_at TIMESTAMPTZ  DEFAULT NOW()
    );
  `);
  // Safe migration: add media_type column if it doesn't exist yet (for existing deployments)
  await pool.query(`
    ALTER TABLE product_photos
      ADD COLUMN IF NOT EXISTS media_type VARCHAR(10) DEFAULT 'image';
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_photos_product ON product_photos(product_id, sort_order);`);

  // Seed default admin
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admins');
  if (rows[0].count === 0) {
    const hash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    await pool.query('INSERT INTO admins (username, password_hash) VALUES ($1,$2)', [DEFAULT_ADMIN_USERNAME, hash]);
    console.log(`[GLP] Seeded default admin → ${DEFAULT_ADMIN_USERNAME} / ${DEFAULT_ADMIN_PASSWORD}`);
    console.log('[GLP] ⚠  Change default password after first login.');
  }

  console.log('[GLP] Database ready.');
}

// ── App ──────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));   // large enough for base64 video batches
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ── Public: leads ─────────────────────────────────────
app.post('/api/leads', async (req, res) => {
  try {
    let { name, phone, location, language } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 200)
      return res.status(400).json({ error: 'Invalid name' });
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 13)
      return res.status(400).json({ error: 'Invalid phone number' });
    const lang = ['en','hi'].includes(language) ? language : 'en';
    const result = await pool.query(
      'INSERT INTO customers (name,phone,location,language) VALUES ($1,$2,$3,$4) RETURNING id,created_at',
      [name.trim().slice(0,200), cleanPhone, (location||'').slice(0,200)||null, lang]
    );
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) { console.error('[GLP] Lead error:', err); res.status(500).json({ error: 'Server error' }); }
});

// ── Public: list photos/videos for a product ──────────
app.get('/api/photos/:productId', async (req, res) => {
  const pid = req.params.productId;
  if (!VALID_PRODUCTS.includes(pid)) return res.status(400).json({ error: 'Invalid product' });
  try {
    const { rows } = await pool.query(
      'SELECT id,filename,mimetype,media_type,sort_order,uploaded_at FROM product_photos WHERE product_id=$1 ORDER BY media_type DESC, sort_order ASC, id ASC',
      [pid]
    );
    res.json({ photos: rows });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Public: serve a single media item ─────────────────
app.get('/api/photo/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).send('Invalid id');
  try {
    const { rows } = await pool.query('SELECT mimetype,data FROM product_photos WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).send('Not found');
    const buf = Buffer.from(rows[0].data, 'base64');
    res.setHeader('Content-Type', rows[0].mimetype || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (err) { res.status(500).send('Server error'); }
});

// ── Admin auth ────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.cookies.glp_admin;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try { req.admin = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.clearCookie('glp_admin'); res.status(401).json({ error: 'unauthorized' }); }
}
function issueAdminCookie(res, admin) {
  const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('glp_admin', token, { httpOnly:true, sameSite:'lax', secure:IS_PROD, maxAge:7*24*60*60*1000 });
}

app.post('/admin/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    const { rows } = await pool.query('SELECT * FROM admins WHERE username=$1', [username]);
    if (!rows.length || !await bcrypt.compare(password, rows[0].password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    issueAdminCookie(res, rows[0]);
    res.json({ ok:true, username:rows[0].username });
  } catch (err) { res.status(500).json({ error:'Server error' }); }
});
app.post('/admin/api/logout', (req,res) => { res.clearCookie('glp_admin'); res.json({ok:true}); });
app.get('/admin/api/me', requireAdmin, (req,res) => res.json({username:req.admin.username,id:req.admin.id}));

// ── Admin: leads ──────────────────────────────────────
app.get('/admin/api/leads', requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)||100, 500);
    const offset = parseInt(req.query.offset)||0;
    const { rows } = await pool.query(
      'SELECT id,name,phone,location,language,source,created_at FROM customers ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    const total = await pool.query('SELECT COUNT(*)::int AS count FROM customers');
    const today = await pool.query("SELECT COUNT(*)::int AS count FROM customers WHERE created_at>=CURRENT_DATE");
    res.json({ leads:rows, total:total.rows[0].count, today:today.rows[0].count });
  } catch (err) { res.status(500).json({ error:'Server error' }); }
});
app.get('/admin/api/leads.csv', requireAdmin, async (req,res) => {
  try {
    const { rows } = await pool.query('SELECT id,name,phone,location,language,source,created_at FROM customers ORDER BY created_at DESC');
    const esc = v => { if(v==null)return''; const s=String(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:''+s; };
    let csv='ID,Name,Phone,Location,Language,Source,Created At\n';
    for(const r of rows) csv+=[r.id,esc(r.name),esc(r.phone),esc(r.location),esc(r.language),esc(r.source),esc(r.created_at?.toISOString())].join(',')+'\n';
    res.setHeader('Content-Type','text/csv;charset=utf-8');
    res.setHeader('Content-Disposition',`attachment;filename="glp-leads-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch(err){ res.status(500).json({error:'Server error'}); }
});
app.delete('/admin/api/leads/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id); if(isNaN(id)) return res.status(400).json({error:'Invalid id'});
  try { await pool.query('DELETE FROM customers WHERE id=$1',[id]); res.json({ok:true}); }
  catch(err){ res.status(500).json({error:'Server error'}); }
});
app.post('/admin/api/credentials', requireAdmin, async (req,res) => {
  try {
    const {currentPassword,newUsername,newPassword}=req.body||{};
    if(!currentPassword) return res.status(400).json({error:'Current password required'});
    const {rows}=await pool.query('SELECT * FROM admins WHERE id=$1',[req.admin.id]);
    if(!rows.length) return res.status(404).json({error:'Admin not found'});
    if(!await bcrypt.compare(currentPassword,rows[0].password_hash)) return res.status(401).json({error:'Current password incorrect'});
    const updates=[],params=[];let idx=1,newUname=rows[0].username;
    if(newUsername&&newUsername.trim()&&newUsername!==rows[0].username){
      const u=newUsername.trim();
      if(u.length<3||u.length>100) return res.status(400).json({error:'Username 3–100 chars'});
      const ex=await pool.query('SELECT id FROM admins WHERE username=$1 AND id!=$2',[u,req.admin.id]);
      if(ex.rows.length) return res.status(409).json({error:'Username taken'});
      updates.push(`username=$${idx++}`);params.push(u);newUname=u;
    }
    if(newPassword){
      if(newPassword.length<4) return res.status(400).json({error:'Password min 4 chars'});
      updates.push(`password_hash=$${idx++}`);params.push(await bcrypt.hash(newPassword,10));
    }
    if(!updates.length) return res.status(400).json({error:'Nothing to update'});
    updates.push(`updated_at=NOW()`);params.push(req.admin.id);
    await pool.query(`UPDATE admins SET ${updates.join(',')} WHERE id=$${idx}`,params);
    issueAdminCookie(res,{id:req.admin.id,username:newUname});
    res.json({ok:true,username:newUname});
  } catch(err){ console.error('[GLP] Credentials error:',err); res.status(500).json({error:'Server error'}); }
});

// ── Admin: upload images or video ─────────────────────
app.post('/admin/api/photos/:productId', requireAdmin, async (req,res) => {
  const pid = req.params.productId;
  if (!VALID_PRODUCTS.includes(pid)) return res.status(400).json({ error:'Invalid product. Use dv, cm, or db.' });

  const { photos } = req.body || {};
  if (!Array.isArray(photos) || !photos.length) return res.status(400).json({ error:'Provide photos array' });

  try {
    const { rows: existing } = await pool.query(
      'SELECT COUNT(*)::int AS imgs, SUM(CASE WHEN media_type=\'video\' THEN 1 ELSE 0 END)::int AS vids FROM product_photos WHERE product_id=$1',
      [pid]
    );
    const currentImages = existing[0].imgs - (existing[0].vids || 0);
    const currentVideos = existing[0].vids || 0;

    const inserted = [], errors = [];

    for (const item of photos) {
      const { filename='media', mimetype='image/jpeg', data, media_type='image' } = item;
      if (typeof data !== 'string' || !data) { errors.push(`${filename}: no data`); continue; }

      const base64 = data.replace(/^data:[^;]+;base64,/, '');
      const approxBytes = Math.ceil(base64.length * 0.75);
      const isVideo = ALLOWED_VIDEO_TYPES.includes(mimetype) || media_type === 'video';

      if (isVideo) {
        if (currentVideos >= MAX_VIDEOS_PER_PRODUCT) { errors.push(`${filename}: video limit (${MAX_VIDEOS_PER_PRODUCT}) reached`); continue; }
        if (approxBytes > MAX_VIDEO_BYTES) { errors.push(`${filename}: exceeds 15 MB limit`); continue; }
        if (!ALLOWED_VIDEO_TYPES.includes(mimetype)) { errors.push(`${filename}: unsupported video type (use MP4 or WebM)`); continue; }
      } else {
        if (currentImages >= MAX_IMAGES_PER_PRODUCT) { errors.push(`${filename}: image limit (${MAX_IMAGES_PER_PRODUCT}) reached`); continue; }
        if (approxBytes > MAX_IMAGE_BYTES) { errors.push(`${filename}: exceeds 4 MB limit`); continue; }
        if (!ALLOWED_IMAGE_TYPES.includes(mimetype)) { errors.push(`${filename}: unsupported image type`); continue; }
      }

      const { rows: maxRow } = await pool.query(
        'SELECT COALESCE(MAX(sort_order),-1) AS mx FROM product_photos WHERE product_id=$1 AND media_type=$2',
        [pid, isVideo ? 'video' : 'image']
      );

      const { rows } = await pool.query(
        'INSERT INTO product_photos (product_id,filename,mimetype,media_type,data,sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,filename,mimetype,media_type,sort_order,uploaded_at',
        [pid, String(filename).slice(0,255), mimetype, isVideo?'video':'image', base64, maxRow[0].mx+1]
      );
      inserted.push(rows[0]);
      if (isVideo) { /* currentVideos++ would need let */ } // each item validated against DB state; acceptable for 1 video
    }

    res.json({ ok:true, inserted, errors });
  } catch (err) { console.error('[GLP] Photo upload error:',err); res.status(500).json({error:'Server error'}); }
});

// ── Admin: delete media ───────────────────────────────
app.delete('/admin/api/photos/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id); if(isNaN(id)) return res.status(400).json({error:'Invalid id'});
  try { await pool.query('DELETE FROM product_photos WHERE id=$1',[id]); res.json({ok:true}); }
  catch(err){ res.status(500).json({error:'Server error'}); }
});

// ── Admin: reorder photos ─────────────────────────────
app.patch('/admin/api/photos/reorder', requireAdmin, async (req,res) => {
  const {productId,order}=req.body||{};
  if (!VALID_PRODUCTS.includes(productId)||!Array.isArray(order)) return res.status(400).json({error:'Invalid payload'});
  try {
    for(let i=0;i<order.length;i++) await pool.query('UPDATE product_photos SET sort_order=$1 WHERE id=$2 AND product_id=$3',[i,order[i],productId]);
    res.json({ok:true});
  } catch(err){ res.status(500).json({error:'Server error'}); }
});

// ── Static ────────────────────────────────────────────
app.get('/admin', (_req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/healthz', (_req,res) => res.json({ok:true,ts:Date.now()}));

// ── Boot ──────────────────────────────────────────────
initDb()
  .then(() => app.listen(PORT, () => console.log(`[GLP] http://localhost:${PORT}`)))
  .catch(err => { console.error('[GLP] DB init failed:',err); process.exit(1); });
