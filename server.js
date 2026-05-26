/**
 * Ganga Lehari Pansari (GLP) — Server
 *
 * PUBLIC ENDPOINTS:
 *  GET  /                          landing page
 *  GET  /admin                     admin SPA
 *  GET  /healthz                   health check
 *  POST /api/leads                 chatbot lead capture
 *  GET  /api/photos/:productId     photo/video metadata list
 *  GET  /api/photo/:id             serve image or video binary
 *  GET  /api/products              public product catalog (visible only)
 *  GET  /api/packages              public packages (visible only)
 *
 * ADMIN ENDPOINTS (JWT cookie required):
 *  Auth:       POST /admin/api/login|logout   GET /admin/api/me
 *  Leads:      GET  /admin/api/leads          GET  /admin/api/leads.csv
 *              DELETE /admin/api/leads/:id
 *  Settings:   POST /admin/api/credentials
 *
 *  Photos:     POST   /admin/api/photos/:productId
 *              DELETE /admin/api/photos/:id
 *              PATCH  /admin/api/photos/reorder
 *
 *  Catalog:    GET    /admin/api/catalog                  list all products
 *              POST   /admin/api/catalog                  create product
 *              PUT    /admin/api/catalog/:id              update product
 *              DELETE /admin/api/catalog/:id              delete product
 *              PATCH  /admin/api/catalog/ranks            bulk reorder
 *              GET    /admin/api/catalog.csv              export CSV
 *              POST   /admin/api/catalog/import           import CSV (JSON body)
 *
 *  Variants:   POST   /admin/api/catalog/:pid/variants    add variant
 *              PUT    /admin/api/variants/:id             update variant
 *              DELETE /admin/api/variants/:id             delete variant
 *
 *  Tags:       POST   /admin/api/catalog/:pid/tags        set tags (replaces all)
 *              DELETE /admin/api/tags/:id                 delete one tag
 *
 *  Discounts:  POST   /admin/api/catalog/:pid/discounts   add discount
 *              PUT    /admin/api/discounts/:id            update discount
 *              DELETE /admin/api/discounts/:id            delete discount
 *
 *  Packages:   GET    /admin/api/packages
 *              POST   /admin/api/packages
 *              PUT    /admin/api/packages/:id
 *              DELETE /admin/api/packages/:id
 *              POST   /admin/api/packages/:id/items       add item to package
 *              DELETE /admin/api/package-items/:id        remove item
 */

const express     = require('express');
const path        = require('path');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const cookieParser= require('cookie-parser');
const { Pool }    = require('pg');
require('dotenv').config();

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'glp-default-secret-change-in-production';
const IS_PROD    = process.env.NODE_ENV === 'production';

const DEFAULT_ADMIN_USERNAME = 'Lakhan';
const DEFAULT_ADMIN_PASSWORD = 'Lakhan';

const VALID_MEDIA_PRODUCTS  = ['dv','cm','db']; // legacy photo system
const MAX_IMAGES_PER_PRODUCT = 5;
const MAX_VIDEOS_PER_PRODUCT = 1;
const MAX_IMAGE_BYTES        = 4  * 1024 * 1024;
const MAX_VIDEO_BYTES        = 15 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES    = ['image/jpeg','image/jpg','image/png','image/webp','image/avif'];
const ALLOWED_VIDEO_TYPES    = ['video/mp4','video/webm','video/quicktime'];

// ── DB ──────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: IS_PROD ? { rejectUnauthorized: false } : false
});

async function initDb() {
  // ── Existing tables ────────────────────────────────────────────────────
  await pool.query(`CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, phone VARCHAR(20) NOT NULL,
    location VARCHAR(200), language VARCHAR(10) DEFAULT 'en',
    source VARCHAR(50) DEFAULT 'chatbot', created_at TIMESTAMPTZ DEFAULT NOW()
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at DESC);`);

  await pool.query(`CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY, username VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS product_photos (
    id SERIAL PRIMARY KEY, product_id VARCHAR(20) NOT NULL,
    filename VARCHAR(255) DEFAULT 'media', mimetype VARCHAR(80) DEFAULT 'image/jpeg',
    media_type VARCHAR(10) DEFAULT 'image', data TEXT NOT NULL,
    sort_order INT DEFAULT 0, uploaded_at TIMESTAMPTZ DEFAULT NOW()
  );`);
  await pool.query(`ALTER TABLE product_photos ADD COLUMN IF NOT EXISTS media_type VARCHAR(10) DEFAULT 'image';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_photos_product ON product_photos(product_id, sort_order);`);

  // ── New catalog tables ─────────────────────────────────────────────────
  await pool.query(`CREATE TABLE IF NOT EXISTS catalog_products (
    id             SERIAL PRIMARY KEY,
    sku            VARCHAR(50) UNIQUE NOT NULL,
    name_en        VARCHAR(200) NOT NULL,
    name_hi        VARCHAR(200) DEFAULT '',
    description_en TEXT DEFAULT '',
    description_hi TEXT DEFAULT '',
    status         VARCHAR(20) DEFAULT 'visible',
    is_featured    BOOLEAN DEFAULT false,
    featured_label VARCHAR(100) DEFAULT '',
    display_rank   INT DEFAULT 0,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS product_variants (
    id           SERIAL PRIMARY KEY,
    product_id   INT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
    label        VARCHAR(100) NOT NULL,
    price        NUMERIC(10,2) NOT NULL,
    mrp          NUMERIC(10,2),
    stock_status VARCHAR(20) DEFAULT 'in_stock',
    is_default   BOOLEAN DEFAULT false,
    sort_order   INT DEFAULT 0
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS product_tags (
    id SERIAL PRIMARY KEY, product_id INT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
    tag_en VARCHAR(100) NOT NULL, tag_hi VARCHAR(100) DEFAULT '', sort_order INT DEFAULT 0
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS product_discounts (
    id             SERIAL PRIMARY KEY,
    product_id     INT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
    variant_id     INT REFERENCES product_variants(id) ON DELETE CASCADE,
    label          VARCHAR(100) DEFAULT '',
    discount_type  VARCHAR(20) DEFAULT 'percentage',
    discount_value NUMERIC(10,2) NOT NULL,
    is_active      BOOLEAN DEFAULT true,
    valid_from     DATE,
    valid_to       DATE,
    created_at     TIMESTAMPTZ DEFAULT NOW()
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS product_packages (
    id             SERIAL PRIMARY KEY,
    name_en        VARCHAR(200) NOT NULL,
    name_hi        VARCHAR(200) DEFAULT '',
    description_en TEXT DEFAULT '',
    description_hi TEXT DEFAULT '',
    mrp            NUMERIC(10,2),
    price          NUMERIC(10,2) NOT NULL,
    status         VARCHAR(20) DEFAULT 'visible',
    display_rank   INT DEFAULT 0,
    highlight      VARCHAR(100) DEFAULT '',
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS package_items (
    id SERIAL PRIMARY KEY,
    package_id INT NOT NULL REFERENCES product_packages(id) ON DELETE CASCADE,
    product_id INT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
    variant_id INT REFERENCES product_variants(id) ON DELETE SET NULL,
    quantity   INT DEFAULT 1, sort_order INT DEFAULT 0
  );`);

  // ── Seed default admin ─────────────────────────────────────────────────
  const { rows: adminRows } = await pool.query('SELECT COUNT(*)::int AS count FROM admins');
  if (adminRows[0].count === 0) {
    const hash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    await pool.query('INSERT INTO admins (username,password_hash) VALUES ($1,$2)',[DEFAULT_ADMIN_USERNAME,hash]);
    console.log(`[GLP] Seeded default admin → ${DEFAULT_ADMIN_USERNAME} / ${DEFAULT_ADMIN_PASSWORD}`);
  }

  // ── Seed 3 heritage products if catalog is empty ───────────────────────
  const { rows: prodRows } = await pool.query('SELECT COUNT(*)::int AS count FROM catalog_products');
  if (prodRows[0].count === 0) {
    const seeds = [
      { sku:'dv', name_en:'Dahi Vada Premix', name_hi:'दही वड़ा प्रीमिक्स',
        desc_en:'Black-eyed bean batter, ready in three steps. Salt & spices already included. Makes Kanji Bada too.',
        desc_hi:'लोबिया का घोल, तीन आसान चरणों में। नमक और मसाले पहले से शामिल। कांजी बड़ा भी बनता है।',
        rank:0, variants:[{label:'350g',price:120,mrp:150,def:true}],
        tags:[{en:'5 Servings',hi:'5 सर्विंग'},{en:'Veg',hi:'शाकाहारी'},{en:'3-Step Ready',hi:'3 चरण में तैयार'}]
      },
      { sku:'cm', name_en:'Chaat Masala', name_hi:'चाट मसाला',
        desc_en:'Sixteen-spice tangy blend with kachri, anardana & black salt. The one your grandmother sprinkled on everything.',
        desc_hi:'कचरी, अनारदाना और काले नमक के साथ सोलह मसालों का खट्टा-तीखा मिश्रण।',
        rank:1, variants:[{label:'100g',price:100,mrp:120,def:true}],
        tags:[{en:'16 Spices',hi:'16 मसाले'},{en:'Min. 58% Spice',hi:'न्यूनतम 58% मसाला'},{en:'Veg',hi:'शाकाहारी'}]
      },
      { sku:'db', name_en:'Doodh Bahaar', name_hi:'दूध बहार',
        desc_en:'Almonds, pistachios, kesar and the slow-roasted warmth of a Rajasthani winter. Stir into hot milk.',
        desc_hi:'बादाम, पिस्ता, केसर और राजस्थानी सर्दी की धीमी आँच पर भुनी हुई गर्माहट। गरम दूध में मिलाएँ।',
        rank:2, variants:[{label:'200g',price:220,mrp:260,def:true}],
        tags:[{en:'Saffron',hi:'केसर'},{en:'Pistachio',hi:'पिस्ता'},{en:'Limited Batch',hi:'सीमित बैच'}]
      }
    ];
    for (const s of seeds) {
      const { rows:[p] } = await pool.query(
        `INSERT INTO catalog_products (sku,name_en,name_hi,description_en,description_hi,display_rank)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [s.sku, s.name_en, s.name_hi, s.desc_en, s.desc_hi, s.rank]
      );
      for (let i=0;i<s.variants.length;i++) {
        const v=s.variants[i];
        await pool.query(
          `INSERT INTO product_variants (product_id,label,price,mrp,is_default,sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
          [p.id, v.label, v.price, v.mrp, v.def, i]
        );
      }
      for (let i=0;i<s.tags.length;i++) {
        const t=s.tags[i];
        await pool.query(`INSERT INTO product_tags (product_id,tag_en,tag_hi,sort_order) VALUES ($1,$2,$3,$4)`,[p.id,t.en,t.hi,i]);
      }
    }
    // Seed one starter package
    const { rows:[pkg] } = await pool.query(
      `INSERT INTO product_packages (name_en,name_hi,description_en,mrp,price,highlight,display_rank)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      ['Alwar Starter Pack','अलवर स्टार्टर पैक',
       'Our three most-loved heirlooms — Dahi Vada Premix, Chaat Masala & Doodh Bahaar.',440,399,'Save ₹41 + Free Shipping',0]
    );
    const pids = await pool.query('SELECT id,sku FROM catalog_products ORDER BY display_rank');
    for (let i=0;i<pids.rows.length;i++) {
      await pool.query(`INSERT INTO package_items (package_id,product_id,quantity,sort_order) VALUES ($1,$2,1,$3)`,
        [pkg.id, pids.rows[i].id, i]);
    }
    console.log('[GLP] Seeded 3 products + Alwar Starter Pack');
  }

  console.log('[GLP] Database ready.');
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function getFullProduct(id) {
  const { rows:[p] } = await pool.query(`SELECT * FROM catalog_products WHERE id=$1`,[id]);
  if (!p) return null;
  const { rows: variants  } = await pool.query(`SELECT * FROM product_variants  WHERE product_id=$1 ORDER BY sort_order,id`,[id]);
  const { rows: tags      } = await pool.query(`SELECT * FROM product_tags       WHERE product_id=$1 ORDER BY sort_order,id`,[id]);
  const { rows: discounts } = await pool.query(`SELECT * FROM product_discounts  WHERE product_id=$1 ORDER BY id`,[id]);
  return { ...p, variants, tags, discounts };
}

function computeSalePrice(price, discount) {
  if (!discount || !discount.is_active) return null;
  const now = new Date();
  if (discount.valid_from && new Date(discount.valid_from) > now) return null;
  if (discount.valid_to   && new Date(discount.valid_to)   < now) return null;
  if (discount.discount_type === 'percentage') {
    return Math.round(price * (1 - discount.discount_value / 100) * 100) / 100;
  }
  return Math.max(0, price - discount.discount_value);
}

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public'), { extensions:['html'] }));

// ── PUBLIC: leads ──────────────────────────────────────────────────────────
app.post('/api/leads', async (req,res) => {
  try {
    const { name, phone, location, language } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 200)
      return res.status(400).json({ error:'Invalid name' });
    const cleanPhone = String(phone||'').replace(/[^0-9]/g,'');
    if (cleanPhone.length < 10 || cleanPhone.length > 13)
      return res.status(400).json({ error:'Invalid phone' });
    const lang = ['en','hi'].includes(language) ? language : 'en';
    const { rows:[r] } = await pool.query(
      'INSERT INTO customers (name,phone,location,language) VALUES ($1,$2,$3,$4) RETURNING id',
      [name.trim().slice(0,200), cleanPhone, (location||'').slice(0,200)||null, lang]
    );
    res.json({ ok:true, id:r.id });
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

// ── PUBLIC: photos ─────────────────────────────────────────────────────────
app.get('/api/photos/:productId', async (req,res) => {
  const pid = req.params.productId;
  if (!VALID_MEDIA_PRODUCTS.includes(pid)) return res.status(400).json({ error:'Invalid product' });
  try {
    const { rows } = await pool.query(
      'SELECT id,filename,mimetype,media_type,sort_order,uploaded_at FROM product_photos WHERE product_id=$1 ORDER BY media_type DESC,sort_order,id',
      [pid]
    );
    res.json({ photos:rows });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.get('/api/photo/:id', async (req,res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).send('Invalid id');
  try {
    const { rows } = await pool.query('SELECT mimetype,data FROM product_photos WHERE id=$1',[id]);
    if (!rows.length) return res.status(404).send('Not found');
    const buf = Buffer.from(rows[0].data,'base64');
    res.setHeader('Content-Type', rows[0].mimetype||'image/jpeg');
    res.setHeader('Cache-Control','public,max-age=86400');
    res.send(buf);
  } catch(e) { res.status(500).send('Server error'); }
});

// ── PUBLIC: product catalog ────────────────────────────────────────────────
app.get('/api/products', async (req,res) => {
  try {
    const { rows: prods } = await pool.query(
      `SELECT * FROM catalog_products WHERE status='visible' ORDER BY display_rank,id`
    );
    const result = [];
    for (const p of prods) {
      const { rows: variants  } = await pool.query(`SELECT * FROM product_variants  WHERE product_id=$1 ORDER BY sort_order,id`,[p.id]);
      const { rows: tags      } = await pool.query(`SELECT * FROM product_tags       WHERE product_id=$1 ORDER BY sort_order,id`,[p.id]);
      const { rows: discounts } = await pool.query(
        `SELECT * FROM product_discounts WHERE product_id=$1 AND is_active=true ORDER BY id LIMIT 1`,[p.id]
      );
      const activeDiscount = discounts[0] || null;
      const variantsWithSale = variants.map(v => {
        const disc = activeDiscount && (!activeDiscount.variant_id || activeDiscount.variant_id === v.id)
          ? activeDiscount : null;
        const salePrice = disc ? computeSalePrice(parseFloat(v.price), disc) : null;
        return { ...v, sale_price: salePrice, discount: disc };
      });
      result.push({ ...p, variants: variantsWithSale, tags, active_discount: activeDiscount });
    }
    res.json({ products: result });
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

// ── PUBLIC: packages ────────────────────────────────────────────────────────
app.get('/api/packages', async (req,res) => {
  try {
    const { rows: pkgs } = await pool.query(
      `SELECT * FROM product_packages WHERE status='visible' ORDER BY display_rank,id`
    );
    const result = [];
    for (const pkg of pkgs) {
      const { rows: items } = await pool.query(
        `SELECT pi.*, cp.name_en, cp.name_hi, pv.label as variant_label
         FROM package_items pi
         JOIN catalog_products cp ON cp.id=pi.product_id
         LEFT JOIN product_variants pv ON pv.id=pi.variant_id
         WHERE pi.package_id=$1 ORDER BY pi.sort_order,pi.id`,
        [pkg.id]
      );
      const savings = pkg.mrp ? (parseFloat(pkg.mrp) - parseFloat(pkg.price)).toFixed(0) : null;
      const pct     = pkg.mrp ? Math.round((1 - pkg.price/pkg.mrp)*100) : null;
      result.push({ ...pkg, items, savings, discount_pct: pct });
    }
    res.json({ packages: result });
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

// ── Admin auth ───────────────────────────────────────────────────────────────
function requireAdmin(req,res,next){
  const token = req.cookies.glp_admin;
  if (!token) return res.status(401).json({ error:'unauthorized' });
  try { req.admin = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.clearCookie('glp_admin'); res.status(401).json({ error:'unauthorized' }); }
}
function issueAdminCookie(res, admin) {
  const token = jwt.sign({ id:admin.id, username:admin.username }, JWT_SECRET, { expiresIn:'7d' });
  res.cookie('glp_admin', token, { httpOnly:true, sameSite:'lax', secure:IS_PROD, maxAge:7*24*60*60*1000 });
}
app.post('/admin/api/login', async (req,res) => {
  try {
    const { username, password } = req.body||{};
    if (!username||!password) return res.status(400).json({ error:'Missing credentials' });
    const { rows } = await pool.query('SELECT * FROM admins WHERE username=$1',[username]);
    if (!rows.length || !await bcrypt.compare(password, rows[0].password_hash))
      return res.status(401).json({ error:'Invalid credentials' });
    issueAdminCookie(res, rows[0]);
    res.json({ ok:true, username:rows[0].username });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});
app.post('/admin/api/logout', (req,res) => { res.clearCookie('glp_admin'); res.json({ok:true}); });
app.get('/admin/api/me', requireAdmin, (req,res) => res.json({username:req.admin.username,id:req.admin.id}));

// ── Admin: leads ─────────────────────────────────────────────────────────────
app.get('/admin/api/leads', requireAdmin, async (req,res) => {
  try {
    const limit=Math.min(parseInt(req.query.limit)||100,500), offset=parseInt(req.query.offset)||0;
    const { rows } = await pool.query(
      'SELECT id,name,phone,location,language,source,created_at FROM customers ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit,offset]
    );
    const total = await pool.query('SELECT COUNT(*)::int AS count FROM customers');
    const today = await pool.query("SELECT COUNT(*)::int AS count FROM customers WHERE created_at>=CURRENT_DATE");
    res.json({ leads:rows, total:total.rows[0].count, today:today.rows[0].count });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});
app.get('/admin/api/leads.csv', requireAdmin, async (req,res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM customers ORDER BY created_at DESC');
    const esc = v => { const s=String(v??''); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:''+s; };
    let csv='ID,Name,Phone,Location,Language,Source,Created At\n';
    for (const r of rows) csv+=[r.id,esc(r.name),esc(r.phone),esc(r.location),esc(r.language),esc(r.source),esc(r.created_at?.toISOString())].join(',')+'\n';
    res.setHeader('Content-Type','text/csv;charset=utf-8');
    res.setHeader('Content-Disposition',`attachment;filename="glp-leads-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});
app.delete('/admin/api/leads/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id); if(isNaN(id)) return res.status(400).json({error:'Invalid id'});
  try { await pool.query('DELETE FROM customers WHERE id=$1',[id]); res.json({ok:true}); }
  catch(e) { res.status(500).json({error:'Server error'}); }
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
      const u=newUsername.trim();if(u.length<3||u.length>100)return res.status(400).json({error:'Username 3-100 chars'});
      const ex=await pool.query('SELECT id FROM admins WHERE username=$1 AND id!=$2',[u,req.admin.id]);
      if(ex.rows.length)return res.status(409).json({error:'Username taken'});
      updates.push(`username=$${idx++}`);params.push(u);newUname=u;
    }
    if(newPassword){if(newPassword.length<4)return res.status(400).json({error:'Min 4 chars'});
      updates.push(`password_hash=$${idx++}`);params.push(await bcrypt.hash(newPassword,10));}
    if(!updates.length) return res.status(400).json({error:'Nothing to update'});
    updates.push(`updated_at=NOW()`);params.push(req.admin.id);
    await pool.query(`UPDATE admins SET ${updates.join(',')} WHERE id=$${idx}`,params);
    issueAdminCookie(res,{id:req.admin.id,username:newUname});
    res.json({ok:true,username:newUname});
  } catch(e) { res.status(500).json({error:'Server error'}); }
});

// ── Admin: photos ─────────────────────────────────────────────────────────────
app.post('/admin/api/photos/:productId', requireAdmin, async (req,res) => {
  const pid=req.params.productId;
  if(!VALID_MEDIA_PRODUCTS.includes(pid)) return res.status(400).json({error:'Invalid product'});
  const { photos } = req.body||{};
  if(!Array.isArray(photos)||!photos.length) return res.status(400).json({error:'Provide photos array'});
  try {
    const { rows:[ex] } = await pool.query(
      "SELECT COUNT(*)::int AS imgs, SUM(CASE WHEN media_type='video' THEN 1 ELSE 0 END)::int AS vids FROM product_photos WHERE product_id=$1",[pid]
    );
    const currentImgs=ex.imgs-(ex.vids||0), currentVids=ex.vids||0;
    const inserted=[],errors=[];
    for (const item of photos) {
      const {filename='media',mimetype='image/jpeg',data,media_type='image'}=item;
      if(typeof data!=='string'||!data){errors.push(`${filename}: no data`);continue;}
      const base64=data.replace(/^data:[^;]+;base64,/,'');
      const approxBytes=Math.ceil(base64.length*.75);
      const isVideo=ALLOWED_VIDEO_TYPES.includes(mimetype)||media_type==='video';
      if(isVideo){
        if(currentVids>=MAX_VIDEOS_PER_PRODUCT){errors.push(`${filename}: video limit reached`);continue;}
        if(approxBytes>MAX_VIDEO_BYTES){errors.push(`${filename}: exceeds 15MB`);continue;}
        if(!ALLOWED_VIDEO_TYPES.includes(mimetype)){errors.push(`${filename}: unsupported video type`);continue;}
      } else {
        if(currentImgs>=MAX_IMAGES_PER_PRODUCT){errors.push(`${filename}: image limit reached`);continue;}
        if(approxBytes>MAX_IMAGE_BYTES){errors.push(`${filename}: exceeds 4MB`);continue;}
        if(!ALLOWED_IMAGE_TYPES.includes(mimetype)){errors.push(`${filename}: unsupported image type`);continue;}
      }
      const {rows:[mx]}=await pool.query("SELECT COALESCE(MAX(sort_order),-1) AS mx FROM product_photos WHERE product_id=$1 AND media_type=$2",[pid,isVideo?'video':'image']);
      const {rows:[r]}=await pool.query(
        'INSERT INTO product_photos (product_id,filename,mimetype,media_type,data,sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,filename,mimetype,media_type,sort_order',
        [pid,String(filename).slice(0,255),mimetype,isVideo?'video':'image',base64,mx.mx+1]
      );
      inserted.push(r);
    }
    res.json({ok:true,inserted,errors});
  } catch(e) { console.error(e); res.status(500).json({error:'Server error'}); }
});
app.delete('/admin/api/photos/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try{await pool.query('DELETE FROM product_photos WHERE id=$1',[id]);res.json({ok:true});}
  catch(e){res.status(500).json({error:'Server error'});}
});
app.patch('/admin/api/photos/reorder', requireAdmin, async (req,res) => {
  const{productId,order}=req.body||{};
  if(!VALID_MEDIA_PRODUCTS.includes(productId)||!Array.isArray(order))return res.status(400).json({error:'Invalid payload'});
  try{for(let i=0;i<order.length;i++)await pool.query('UPDATE product_photos SET sort_order=$1 WHERE id=$2 AND product_id=$3',[i,order[i],productId]);res.json({ok:true});}
  catch(e){res.status(500).json({error:'Server error'});}
});

// ── Admin: catalog CRUD ──────────────────────────────────────────────────────
app.get('/admin/api/catalog', requireAdmin, async (req,res) => {
  try {
    const { rows: prods } = await pool.query('SELECT * FROM catalog_products ORDER BY display_rank,id');
    const result=[];
    for(const p of prods) result.push(await getFullProduct(p.id));
    res.json({products:result});
  } catch(e) { res.status(500).json({error:'Server error'}); }
});

app.post('/admin/api/catalog', requireAdmin, async (req,res) => {
  try {
    const {sku,name_en,name_hi='',description_en='',description_hi='',status='visible',is_featured=false,featured_label='',display_rank=0}=req.body||{};
    if(!sku||!name_en) return res.status(400).json({error:'sku and name_en required'});
    const { rows:[p] } = await pool.query(
      `INSERT INTO catalog_products (sku,name_en,name_hi,description_en,description_hi,status,is_featured,featured_label,display_rank) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [sku.trim().toLowerCase().replace(/\s+/g,'-'),name_en,name_hi,description_en,description_hi,status,is_featured,featured_label,display_rank]
    );
    res.json({ok:true, product: await getFullProduct(p.id)});
  } catch(e) {
    if(e.code==='23505') return res.status(409).json({error:`SKU already exists`});
    console.error(e); res.status(500).json({error:'Server error'});
  }
});

app.put('/admin/api/catalog/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try {
    const {name_en,name_hi,description_en,description_hi,status,is_featured,featured_label,display_rank}=req.body||{};
    await pool.query(
      `UPDATE catalog_products SET name_en=$1,name_hi=$2,description_en=$3,description_hi=$4,status=$5,is_featured=$6,featured_label=$7,display_rank=$8,updated_at=NOW() WHERE id=$9`,
      [name_en,name_hi||'',description_en||'',description_hi||'',status||'visible',!!is_featured,featured_label||'',display_rank||0,id]
    );
    res.json({ok:true, product: await getFullProduct(id)});
  } catch(e) { res.status(500).json({error:'Server error'}); }
});

app.delete('/admin/api/catalog/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try{await pool.query('DELETE FROM catalog_products WHERE id=$1',[id]);res.json({ok:true});}
  catch(e){res.status(500).json({error:'Server error'});}
});

app.patch('/admin/api/catalog/ranks', requireAdmin, async (req,res) => {
  const{ranks}=req.body||{};
  if(!Array.isArray(ranks))return res.status(400).json({error:'ranks array required'});
  try{
    for(const{id,rank,is_featured,featured_label,status}of ranks){
      await pool.query(
        `UPDATE catalog_products SET display_rank=$1,is_featured=$2,featured_label=$3,status=$4,updated_at=NOW() WHERE id=$5`,
        [rank,!!is_featured,featured_label||'',status||'visible',id]
      );
    }
    res.json({ok:true});
  } catch(e){res.status(500).json({error:'Server error'});}
});

// ── Admin: variants ──────────────────────────────────────────────────────────
app.post('/admin/api/catalog/:pid/variants', requireAdmin, async (req,res) => {
  const pid=parseInt(req.params.pid);if(isNaN(pid))return res.status(400).json({error:'Invalid product id'});
  try {
    const{label,price,mrp,stock_status='in_stock',is_default=false,sort_order=0}=req.body||{};
    if(!label||price==null)return res.status(400).json({error:'label and price required'});
    const{rows:[v]}=await pool.query(
      `INSERT INTO product_variants (product_id,label,price,mrp,stock_status,is_default,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [pid,label,price,mrp||null,stock_status,!!is_default,sort_order]
    );
    res.json({ok:true,variant:v});
  } catch(e){res.status(500).json({error:'Server error'});}
});
app.put('/admin/api/variants/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try {
    const{label,price,mrp,stock_status,is_default,sort_order}=req.body||{};
    const{rows:[v]}=await pool.query(
      `UPDATE product_variants SET label=$1,price=$2,mrp=$3,stock_status=$4,is_default=$5,sort_order=$6 WHERE id=$7 RETURNING *`,
      [label,price,mrp||null,stock_status||'in_stock',!!is_default,sort_order||0,id]
    );
    res.json({ok:true,variant:v});
  } catch(e){res.status(500).json({error:'Server error'});}
});
app.delete('/admin/api/variants/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try{await pool.query('DELETE FROM product_variants WHERE id=$1',[id]);res.json({ok:true});}
  catch(e){res.status(500).json({error:'Server error'});}
});

// ── Admin: tags ──────────────────────────────────────────────────────────────
app.post('/admin/api/catalog/:pid/tags', requireAdmin, async (req,res) => {
  const pid=parseInt(req.params.pid);if(isNaN(pid))return res.status(400).json({error:'Invalid id'});
  const{tags}=req.body||{};if(!Array.isArray(tags))return res.status(400).json({error:'tags array required'});
  try {
    await pool.query('DELETE FROM product_tags WHERE product_id=$1',[pid]);
    for(let i=0;i<tags.length;i++){
      const t=tags[i];
      await pool.query('INSERT INTO product_tags (product_id,tag_en,tag_hi,sort_order) VALUES ($1,$2,$3,$4)',
        [pid,String(t.tag_en||t).slice(0,100),String(t.tag_hi||'').slice(0,100),i]);
    }
    const{rows}=await pool.query('SELECT * FROM product_tags WHERE product_id=$1 ORDER BY sort_order',[pid]);
    res.json({ok:true,tags:rows});
  } catch(e){res.status(500).json({error:'Server error'});}
});
app.delete('/admin/api/tags/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try{await pool.query('DELETE FROM product_tags WHERE id=$1',[id]);res.json({ok:true});}
  catch(e){res.status(500).json({error:'Server error'});}
});

// ── Admin: discounts ──────────────────────────────────────────────────────────
app.post('/admin/api/catalog/:pid/discounts', requireAdmin, async (req,res) => {
  const pid=parseInt(req.params.pid);if(isNaN(pid))return res.status(400).json({error:'Invalid id'});
  try {
    const{variant_id=null,label='',discount_type='percentage',discount_value,is_active=true,valid_from=null,valid_to=null}=req.body||{};
    if(discount_value==null||isNaN(discount_value))return res.status(400).json({error:'discount_value required'});
    const{rows:[d]}=await pool.query(
      `INSERT INTO product_discounts (product_id,variant_id,label,discount_type,discount_value,is_active,valid_from,valid_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [pid,variant_id||null,label,discount_type,discount_value,!!is_active,valid_from||null,valid_to||null]
    );
    res.json({ok:true,discount:d});
  } catch(e){res.status(500).json({error:'Server error'});}
});
app.put('/admin/api/discounts/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try {
    const{label,discount_type,discount_value,is_active,valid_from,valid_to,variant_id}=req.body||{};
    const{rows:[d]}=await pool.query(
      `UPDATE product_discounts SET label=$1,discount_type=$2,discount_value=$3,is_active=$4,valid_from=$5,valid_to=$6,variant_id=$7 WHERE id=$8 RETURNING *`,
      [label||'',discount_type||'percentage',discount_value,!!is_active,valid_from||null,valid_to||null,variant_id||null,id]
    );
    res.json({ok:true,discount:d});
  } catch(e){res.status(500).json({error:'Server error'});}
});
app.delete('/admin/api/discounts/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try{await pool.query('DELETE FROM product_discounts WHERE id=$1',[id]);res.json({ok:true});}
  catch(e){res.status(500).json({error:'Server error'});}
});

// ── Admin: packages ───────────────────────────────────────────────────────────
app.get('/admin/api/packages', requireAdmin, async (req,res) => {
  try {
    const{rows:pkgs}=await pool.query('SELECT * FROM product_packages ORDER BY display_rank,id');
    const result=[];
    for(const pkg of pkgs){
      const{rows:items}=await pool.query(
        `SELECT pi.*,cp.name_en,cp.sku,pv.label as variant_label FROM package_items pi
         JOIN catalog_products cp ON cp.id=pi.product_id
         LEFT JOIN product_variants pv ON pv.id=pi.variant_id
         WHERE pi.package_id=$1 ORDER BY pi.sort_order,pi.id`,[pkg.id]
      );
      result.push({...pkg,items});
    }
    res.json({packages:result});
  } catch(e){res.status(500).json({error:'Server error'});}
});
app.post('/admin/api/packages', requireAdmin, async (req,res) => {
  try {
    const{name_en,name_hi='',description_en='',description_hi='',mrp=null,price,status='visible',display_rank=0,highlight=''}=req.body||{};
    if(!name_en||price==null)return res.status(400).json({error:'name_en and price required'});
    const{rows:[p]}=await pool.query(
      `INSERT INTO product_packages (name_en,name_hi,description_en,description_hi,mrp,price,status,display_rank,highlight) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name_en,name_hi,description_en,description_hi,mrp||null,price,status,display_rank,highlight]
    );
    res.json({ok:true,package:p});
  } catch(e){res.status(500).json({error:'Server error'});}
});
app.put('/admin/api/packages/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try {
    const{name_en,name_hi,description_en,description_hi,mrp,price,status,display_rank,highlight}=req.body||{};
    const{rows:[p]}=await pool.query(
      `UPDATE product_packages SET name_en=$1,name_hi=$2,description_en=$3,description_hi=$4,mrp=$5,price=$6,status=$7,display_rank=$8,highlight=$9,updated_at=NOW() WHERE id=$10 RETURNING *`,
      [name_en,name_hi||'',description_en||'',description_hi||'',mrp||null,price,status||'visible',display_rank||0,highlight||'',id]
    );
    res.json({ok:true,package:p});
  } catch(e){res.status(500).json({error:'Server error'});}
});
app.delete('/admin/api/packages/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try{await pool.query('DELETE FROM product_packages WHERE id=$1',[id]);res.json({ok:true});}
  catch(e){res.status(500).json({error:'Server error'});}
});
app.post('/admin/api/packages/:id/items', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try {
    const{product_id,variant_id=null,quantity=1,sort_order=0}=req.body||{};
    if(!product_id)return res.status(400).json({error:'product_id required'});
    const{rows:[item]}=await pool.query(
      `INSERT INTO package_items (package_id,product_id,variant_id,quantity,sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id,product_id,variant_id||null,quantity,sort_order]
    );
    res.json({ok:true,item});
  } catch(e){res.status(500).json({error:'Server error'});}
});
app.delete('/admin/api/package-items/:id', requireAdmin, async (req,res) => {
  const id=parseInt(req.params.id);if(isNaN(id))return res.status(400).json({error:'Invalid id'});
  try{await pool.query('DELETE FROM package_items WHERE id=$1',[id]);res.json({ok:true});}
  catch(e){res.status(500).json({error:'Server error'});}
});

// ── Admin: CSV export ─────────────────────────────────────────────────────────
app.get('/admin/api/catalog.csv', requireAdmin, async (req,res) => {
  try {
    const{rows:prods}=await pool.query('SELECT * FROM catalog_products ORDER BY display_rank,id');
    const esc=v=>{const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:''+s;};
    const hdr='sku,name_en,name_hi,description_en,description_hi,status,is_featured,featured_label,display_rank,variant_label,variant_price,variant_mrp,variant_stock_status,variant_is_default,tags_en,tags_hi,discount_type,discount_value,discount_label,discount_active\n';
    let csv=hdr;
    for(const p of prods){
      const{rows:variants}=await pool.query('SELECT * FROM product_variants WHERE product_id=$1 ORDER BY sort_order',[p.id]);
      const{rows:tags}=await pool.query('SELECT * FROM product_tags WHERE product_id=$1 ORDER BY sort_order',[p.id]);
      const{rows:discounts}=await pool.query('SELECT * FROM product_discounts WHERE product_id=$1 AND is_active=true LIMIT 1',[p.id]);
      const tagsEn=tags.map(t=>t.tag_en).join('|');
      const tagsHi=tags.map(t=>t.tag_hi).join('|');
      const d=discounts[0]||null;
      const rows=variants.length?variants:[{label:'',price:'',mrp:'',stock_status:'in_stock',is_default:true}];
      for(const v of rows){
        csv+=[esc(p.sku),esc(p.name_en),esc(p.name_hi),esc(p.description_en),esc(p.description_hi),esc(p.status),esc(p.is_featured),esc(p.featured_label),esc(p.display_rank),esc(v.label),esc(v.price),esc(v.mrp),esc(v.stock_status),esc(v.is_default),esc(tagsEn),esc(tagsHi),esc(d?.discount_type||''),esc(d?.discount_value||''),esc(d?.label||''),esc(d?d.is_active:'')].join(',')+'\n';
      }
    }
    res.setHeader('Content-Type','text/csv;charset=utf-8');
    res.setHeader('Content-Disposition',`attachment;filename="glp-catalog-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch(e){console.error(e);res.status(500).json({error:'Server error'});}
});

// ── Admin: CSV import ─────────────────────────────────────────────────────────
app.post('/admin/api/catalog/import', requireAdmin, async (req,res) => {
  try {
    const{csv}=req.body||{};
    if(typeof csv!=='string'||!csv.trim())return res.status(400).json({error:'csv string required'});
    const lines=csv.trim().split('\n').map(l=>l.trim()).filter(Boolean);
    if(lines.length<2)return res.status(400).json({error:'CSV must have header + at least one data row'});
    // Parse header
    const header=parseCSVRow(lines[0]);
    const idx={};header.forEach((h,i)=>idx[h.trim()]=i);
    const required=['sku','name_en'];
    for(const r of required)if(idx[r]===undefined)return res.status(400).json({error:`Missing column: ${r}`});
    // Group rows by sku
    const bysku={};
    for(const line of lines.slice(1)){
      const cols=parseCSVRow(line);
      const sku=(cols[idx.sku]||'').trim().toLowerCase();
      if(!sku)continue;
      if(!bysku[sku])bysku[sku]=[];
      bysku[sku].push(cols);
    }
    let created=0,updated=0;
    for(const[sku,rows]of Object.entries(bysku)){
      const r0=rows[0];
      const name_en=(r0[idx.name_en]||'').trim();if(!name_en)continue;
      const name_hi=r0[idx.name_hi]||'';
      const desc_en=r0[idx.description_en]||'';
      const desc_hi=r0[idx.description_hi]||'';
      const status=['visible','hidden','disabled'].includes(r0[idx.status])?r0[idx.status]:'visible';
      const is_featured=r0[idx.is_featured]==='true'||r0[idx.is_featured]==='1';
      const featured_label=r0[idx.featured_label]||'';
      const display_rank=parseInt(r0[idx.display_rank])||0;
      const{rows:ex}=await pool.query('SELECT id FROM catalog_products WHERE sku=$1',[sku]);
      let pid;
      if(ex.length){
        pid=ex[0].id;
        await pool.query(`UPDATE catalog_products SET name_en=$1,name_hi=$2,description_en=$3,description_hi=$4,status=$5,is_featured=$6,featured_label=$7,display_rank=$8,updated_at=NOW() WHERE id=$9`,
          [name_en,name_hi,desc_en,desc_hi,status,is_featured,featured_label,display_rank,pid]);
        updated++;
      } else {
        const{rows:[p]}=await pool.query(`INSERT INTO catalog_products (sku,name_en,name_hi,description_en,description_hi,status,is_featured,featured_label,display_rank) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [sku,name_en,name_hi,desc_en,desc_hi,status,is_featured,featured_label,display_rank]);
        pid=p.id; created++;
      }
      // Variants
      const varRows=rows.filter(r=>(r[idx.variant_label]||'').trim());
      if(varRows.length){
        await pool.query('DELETE FROM product_variants WHERE product_id=$1',[pid]);
        for(let i=0;i<varRows.length;i++){
          const vr=varRows[i];
          const vPrice=parseFloat(vr[idx.variant_price]);
          if(isNaN(vPrice))continue;
          const vMrp=parseFloat(vr[idx.variant_mrp])||null;
          const vStock=vr[idx.variant_stock_status]||'in_stock';
          const vDef=vr[idx.variant_is_default]==='true'||i===0;
          await pool.query(`INSERT INTO product_variants (product_id,label,price,mrp,stock_status,is_default,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [pid,(vr[idx.variant_label]||'').trim(),vPrice,vMrp,vStock,vDef,i]);
        }
      }
      // Tags
      const tagsEn=(r0[idx.tags_en]||'').split('|').map(t=>t.trim()).filter(Boolean);
      const tagsHi=(r0[idx.tags_hi]||'').split('|').map(t=>t.trim()).filter(Boolean);
      if(tagsEn.length){
        await pool.query('DELETE FROM product_tags WHERE product_id=$1',[pid]);
        for(let i=0;i<tagsEn.length;i++){
          await pool.query('INSERT INTO product_tags (product_id,tag_en,tag_hi,sort_order) VALUES ($1,$2,$3,$4)',
            [pid,tagsEn[i],tagsHi[i]||'',i]);
        }
      }
      // Discount
      const dType=r0[idx.discount_type]||'';
      const dVal=parseFloat(r0[idx.discount_value]);
      if(dType&&!isNaN(dVal)&&dVal>0){
        const dLabel=r0[idx.discount_label]||`${dVal}${dType==='percentage'?'% OFF':'₹ OFF'}`;
        const dActive=(r0[idx.discount_active]||'true')!=='false';
        const{rows:exD}=await pool.query('SELECT id FROM product_discounts WHERE product_id=$1 AND variant_id IS NULL LIMIT 1',[pid]);
        if(exD.length){
          await pool.query('UPDATE product_discounts SET discount_type=$1,discount_value=$2,label=$3,is_active=$4 WHERE id=$5',
            [dType,dVal,dLabel,dActive,exD[0].id]);
        } else {
          await pool.query('INSERT INTO product_discounts (product_id,discount_type,discount_value,label,is_active) VALUES ($1,$2,$3,$4,$5)',
            [pid,dType,dVal,dLabel,dActive]);
        }
      }
    }
    res.json({ok:true,created,updated,total:created+updated});
  } catch(e){console.error(e);res.status(500).json({error:'Server error: '+e.message});}
});

function parseCSVRow(line){
  const cols=[];let cur='',inQ=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}
    else if(c===','&&!inQ){cols.push(cur);cur='';}
    else cur+=c;
  }
  cols.push(cur);
  return cols.map(c=>c.trim());
}

// ── Static ────────────────────────────────────────────────────────────────────
app.get('/admin',(_req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/healthz',(_req,res)=>res.json({ok:true,ts:Date.now()}));

// ── Boot ──────────────────────────────────────────────────────────────────────
initDb()
  .then(()=>app.listen(PORT,()=>console.log(`[GLP] http://localhost:${PORT}`)))
  .catch(err=>{console.error('[GLP] DB init failed:',err);process.exit(1);});
