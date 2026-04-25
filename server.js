const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const http = require('http');
require('dotenv').config();
// R2 Storage client
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

// Multer — geçici bellek
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Sadece JPG, PNG, WebP'));
  }
});

const app = express();
const server = http.createServer(app);

// WebSocket — garson çağrı sistemi
const wss = new WebSocket.Server({ server });
const restaurantSockets = {};

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.replace('/?', ''));
  const restaurantId = params.get('restaurantId');
  if (restaurantId) {
    restaurantSockets[restaurantId] = ws;
    ws.on('close', () => delete restaurantSockets[restaurantId]);
  }
});

function notifyRestaurant(restaurantId, data) {
  const ws = restaurantSockets[restaurantId];
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Veritabanı bağlantısı
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// JWT doğrulama
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Geçersiz token' });
  }
}

// ═══════════════════════════════
// VERİTABANI TABLOLARINI OLUŞTUR
// ═══════════════════════════════
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'owner',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS restaurants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      slug VARCHAR(100) UNIQUE NOT NULL,
      name VARCHAR(200) NOT NULL,
      logo_url VARCHAR(500),
      brand_color VARCHAR(7) DEFAULT '#e8c547',
      font_family VARCHAR(50) DEFAULT 'DM Sans',
      wifi_name VARCHAR(100),
      wifi_password VARCHAR(100),
      instagram_url VARCHAR(200),
      facebook_url VARCHAR(200),
      is_published BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      plan VARCHAR(20) DEFAULT 'trial',
      status VARCHAR(20) DEFAULT 'active',
      trial_ends_at TIMESTAMP DEFAULT NOW() + INTERVAL '14 days',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
      name VARCHAR(150) NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_visible BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
      restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL,
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      image_url VARCHAR(500),
      emoji VARCHAR(10) DEFAULT '🍽️',
      is_visible BOOLEAN DEFAULT true,
      sort_order INTEGER DEFAULT 0,
      variants JSONB DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS feedbacks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
      type VARCHAR(20) DEFAULT 'suggestion',
      message TEXT NOT NULL,
      rating INTEGER DEFAULT 5,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS waiter_calls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
      table_no VARCHAR(20),
      status VARCHAR(20) DEFAULT 'pending',
      called_at TIMESTAMP DEFAULT NOW()
    );
CREATE TABLE IF NOT EXISTS working_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL,
  opens_at VARCHAR(5),
  closes_at VARCHAR(5),
  is_closed BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS working_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL,
  opens_at VARCHAR(5) DEFAULT '09:00',
  closes_at VARCHAR(5) DEFAULT '22:00',
  is_closed BOOLEAN DEFAULT false,
  UNIQUE(restaurant_id, day_of_week)
);

    CREATE TABLE IF NOT EXISTS campaigns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      emoji VARCHAR(10) DEFAULT '🎉',
      is_active BOOLEAN DEFAULT true,
      starts_at TIMESTAMP DEFAULT NOW(),
      ends_at TIMESTAMP DEFAULT NOW() + INTERVAL '30 days'
    );
  `);
  console.log('✅ Veritabanı tabloları hazır');
}

// ═══════════════════════════════
// AUTH — KAYIT & GİRİŞ
// ═══════════════════════════════

// Kayıt ol
app.post('/api/auth/register', async (req, res) => {
  const { email, password, restaurantName } = req.body;
  if (!email || !password || !restaurantName) {
    return res.status(400).json({ error: 'Tüm alanlar zorunlu' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const userResult = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hash]
    );
    const user = userResult.rows[0];

    // Slug oluştur
    const slug = restaurantName
      .toLowerCase()
      .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
      .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
      .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
      + '-' + Math.random().toString(36).substr(2, 4);

    // Restoran oluştur
    const restResult = await pool.query(
      'INSERT INTO restaurants (user_id, slug, name) VALUES ($1, $2, $3) RETURNING *',
      [user.id, slug, restaurantName]
    );

    // Trial abonelik oluştur
    await pool.query(
      'INSERT INTO subscriptions (user_id) VALUES ($1)',
      [user.id]
    );

    const token = jwt.sign(
      { userId: user.id, restaurantId: restResult.rows[0].id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Hoşgeldin emaili gönder
    try {
      await resend.emails.send({
        from: 'CafeMenu <noreply@cafemenu.com.tr>',
        to: email,
        subject: 'CafeMenu\'ya Hoş Geldiniz! 🎉',
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff">
            <div style="text-align:center;margin-bottom:28px">
              <div style="font-size:2rem;font-weight:700;color:#111">◈ CafeMenu</div>
              <div style="font-size:13px;color:#888;margin-top:4px">Dijital Menü Platformu</div>
            </div>
            <h2 style="color:#111;margin-bottom:12px">Hoş Geldiniz! 👋</h2>
            <p style="color:#444;line-height:1.6;margin-bottom:16px">
              <strong>${restaurantName}</strong> için dijital menünüz oluşturuldu. 
              14 günlük ücretsiz trial süreniz başladı.
            </p>
            <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin-bottom:20px">
              <div style="font-size:13px;color:#666;margin-bottom:6px">Menü linkiniz:</div>
              <div style="font-family:monospace;font-size:14px;color:#e8a020;font-weight:600">
                https://app.cafemenu.com.tr/menu/${restResult.rows[0].slug}
              </div>
            </div>
            <p style="color:#444;line-height:1.6;margin-bottom:24px">
              Hemen giriş yapıp menünüzü oluşturmaya başlayabilirsiniz.
            </p>
            <div style="text-align:center">
              <a href="https://app.cafemenu.com.tr" style="background:#e8c547;color:#111;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Dashboard'a Git →</a>
            </div>
            <div style="border-top:1px solid #eee;margin-top:28px;padding-top:16px;text-align:center;font-size:12px;color:#aaa">
              CafeMenu · cafemenu.com.tr
            </div>
          </div>
        `
      });
    } catch(emailErr) {
      console.log('Hoşgeldin emaili gönderilemedi:', emailErr.message);
    }

    res.json({ token, restaurant: restResult.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Bu email zaten kayıtlı' });
    res.status(500).json({ error: 'Sunucu hatası: ' + err.message });
  }
});

// Giriş yap
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query(
      `SELECT u.*, r.id as restaurant_id FROM users u
       LEFT JOIN restaurants r ON r.user_id = u.id
       WHERE u.email = $1`,
      [email]
    );
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Email veya şifre hatalı' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Email veya şifre hatalı' });

    const token = jwt.sign(
      { userId: user.id, restaurantId: user.restaurant_id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, restaurantId: user.restaurant_id });
  } catch {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════
// RESTORAN
// ═══════════════════════════════

app.get('/api/restaurant/me', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM restaurants WHERE id = $1',
    [req.user.restaurantId]
  );
  res.json(result.rows[0]);
});

app.put('/api/restaurant/me', authMiddleware, async (req, res) => {
  const { name, brand_color, font_family, wifi_name, wifi_password, instagram_url, facebook_url } = req.body;
  const result = await pool.query(
    `UPDATE restaurants SET name=$1, brand_color=$2, font_family=$3,
     wifi_name=$4, wifi_password=$5, instagram_url=$6, facebook_url=$7
     WHERE id=$8 RETURNING *`,
    [name, brand_color, font_family, wifi_name, wifi_password, instagram_url, facebook_url, req.user.restaurantId]
  );
  res.json(result.rows[0]);
});

// QR kod üret
app.get('/api/restaurant/me/qr', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT slug FROM restaurants WHERE id=$1', [req.user.restaurantId]);
  const slug = result.rows[0].slug;
  const url = `${process.env.APP_URL}/menu/${slug}`;
  const qr = await QRCode.toDataURL(url, { width: 400, margin: 2 });
  res.json({ qr, url });
});

// ═══════════════════════════════
// KATEGORİLER
// ═══════════════════════════════

app.get('/api/categories', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM categories WHERE restaurant_id=$1 ORDER BY sort_order ASC',
    [req.user.restaurantId]
  );
  res.json(result.rows);
});

app.post('/api/categories', authMiddleware, async (req, res) => {
  const { name } = req.body;
  const countResult = await pool.query(
    'SELECT COUNT(*) FROM categories WHERE restaurant_id=$1',
    [req.user.restaurantId]
  );
  const result = await pool.query(
    'INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1,$2,$3) RETURNING *',
    [req.user.restaurantId, name, parseInt(countResult.rows[0].count)]
  );
  res.json(result.rows[0]);
});

app.put('/api/categories/:id', authMiddleware, async (req, res) => {
  const { name, is_visible } = req.body;
  const result = await pool.query(
    'UPDATE categories SET name=$1, is_visible=$2 WHERE id=$3 AND restaurant_id=$4 RETURNING *',
    [name, is_visible, req.params.id, req.user.restaurantId]
  );
  res.json(result.rows[0]);
});

app.delete('/api/categories/:id', authMiddleware, async (req, res) => {
  await pool.query(
    'DELETE FROM categories WHERE id=$1 AND restaurant_id=$2',
    [req.params.id, req.user.restaurantId]
  );
  res.json({ success: true });
});

app.patch('/api/categories/reorder', authMiddleware, async (req, res) => {
  const { ids } = req.body;
  for (let i = 0; i < ids.length; i++) {
    await pool.query(
      'UPDATE categories SET sort_order=$1 WHERE id=$2 AND restaurant_id=$3',
      [i, ids[i], req.user.restaurantId]
    );
  }
  res.json({ success: true });
});

// ═══════════════════════════════
// ÜRÜNLER
// ═══════════════════════════════

app.get('/api/products', authMiddleware, async (req, res) => {
  const { categoryId } = req.query;
  let query = 'SELECT * FROM products WHERE restaurant_id=$1';
  const params = [req.user.restaurantId];
  if (categoryId) { query += ' AND category_id=$2'; params.push(categoryId); }
  query += ' ORDER BY sort_order ASC';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

app.post('/api/products', authMiddleware, async (req, res) => {
  const { category_id, name, description, price, emoji, variants } = req.body;
  const result = await pool.query(
    `INSERT INTO products (category_id, restaurant_id, name, description, price, emoji, variants)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [category_id, req.user.restaurantId, name, description, price, emoji || '🍽️', JSON.stringify(variants || [])]
  );
  res.json(result.rows[0]);
});

app.put('/api/products/:id', authMiddleware, async (req, res) => {
  const { name, description, price, emoji, is_visible, category_id, image_url } = req.body;
  
  // Mevcut ürünü al
  const existing = await pool.query(
    'SELECT * FROM products WHERE id=$1 AND restaurant_id=$2',
    [req.params.id, req.user.restaurantId]
  );
  if (!existing.rows[0]) return res.status(404).json({ error: 'Ürün bulunamadı' });
  
  const current = existing.rows[0];
  
  const result = await pool.query(
    `UPDATE products SET 
      name=$1, 
      description=$2, 
      price=$3, 
      emoji=$4,
      is_visible=$5, 
      category_id=$6,
      image_url=$7
     WHERE id=$8 AND restaurant_id=$9 RETURNING *`,
    [
      name || current.name,
      description !== undefined ? description : current.description,
      price || current.price,
      emoji || current.emoji,
      is_visible !== undefined ? is_visible : current.is_visible,
      category_id || current.category_id,
      image_url !== undefined ? image_url : current.image_url,
      req.params.id,
      req.user.restaurantId
    ]
  );
  res.json(result.rows[0]);
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  await pool.query(
    'DELETE FROM products WHERE id=$1 AND restaurant_id=$2',
    [req.params.id, req.user.restaurantId]
  );
  res.json({ success: true });
});

app.patch('/api/products/:id/toggle', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'UPDATE products SET is_visible = NOT is_visible WHERE id=$1 AND restaurant_id=$2 RETURNING *',
    [req.params.id, req.user.restaurantId]
  );
  res.json(result.rows[0]);
});

app.patch('/api/products/bulk-price', authMiddleware, async (req, res) => {
  const { category_id, percent } = req.body;
  let query = 'UPDATE products SET price = ROUND(price * $1, 2) WHERE restaurant_id=$2';
  const params = [1 + percent / 100, req.user.restaurantId];
  if (category_id) { query += ' AND category_id=$3'; params.push(category_id); }
  await pool.query(query, params);
  res.json({ success: true });
});

// ═══════════════════════════════
// PUBLIC MENÜ (müşteri görünümü)
// ═══════════════════════════════

app.get('/api/menu/:slug', async (req, res) => {
  try {
    const restResult = await pool.query(
      'SELECT * FROM restaurants WHERE slug=$1 AND is_published=true',
      [req.params.slug]
    );
    if (!restResult.rows[0]) return res.status(404).json({ error: 'Menü bulunamadı' });
    const restaurant = restResult.rows[0];

    const catResult = await pool.query(
      'SELECT * FROM categories WHERE restaurant_id=$1 AND is_visible=true ORDER BY sort_order',
      [restaurant.id]
    );

    const prodResult = await pool.query(
      'SELECT * FROM products WHERE restaurant_id=$1 AND is_visible=true ORDER BY sort_order',
      [restaurant.id]
    );
const hoursResult = await pool.query(
  'SELECT * FROM working_hours WHERE restaurant_id=$1 ORDER BY day_of_week',
  [restaurant.id]
);


    const campResult = await pool.query(
      `SELECT * FROM campaigns WHERE restaurant_id=$1 AND is_active=true
       AND starts_at <= NOW() AND ends_at >= NOW() LIMIT 1`,
      [restaurant.id]
    );

    const categories = catResult.rows.map(cat => ({
      ...cat,
      products: prodResult.rows.filter(p => p.category_id === cat.id)
    }));

    // Bugün açık mı hesapla
const todayIndex = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
const todayHours = hoursResult.rows.find(h => h.day_of_week === todayIndex);
const now = new Date();
const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
const isOpen = todayHours && !todayHours.is_closed && currentTime >= todayHours.opens_at && currentTime <= todayHours.closes_at;

res.json({
  restaurant: { ...restaurant, password_hash: undefined },
  categories,
  campaign: campResult.rows[0] || null,
  working_hours: hoursResult.rows,
  today_hours: todayHours || null,
  is_open: isOpen
});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════
// FEEDBACK
// ═══════════════════════════════

app.post('/api/feedback', async (req, res) => {
  const { restaurant_id, type, message, rating } = req.body;
  const result = await pool.query(
    'INSERT INTO feedbacks (restaurant_id, type, message, rating) VALUES ($1,$2,$3,$4) RETURNING *',
    [restaurant_id, type, message, rating]
  );
  res.json(result.rows[0]);
});

app.get('/api/feedback', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM feedbacks WHERE restaurant_id=$1 ORDER BY created_at DESC',
    [req.user.restaurantId]
  );
  res.json(result.rows);
});

// ═══════════════════════════════
// GARSON ÇAĞRI SİSTEMİ
// ═══════════════════════════════

app.post('/api/waiter-call', async (req, res) => {
  const { restaurant_id, table_no } = req.body;
  const result = await pool.query(
    'INSERT INTO waiter_calls (restaurant_id, table_no) VALUES ($1,$2) RETURNING *',
    [restaurant_id, table_no || 'Belirsiz']
  );
  notifyRestaurant(restaurant_id, {
    type: 'waiter_call',
    data: result.rows[0]
  });
  res.json(result.rows[0]);
});

app.get('/api/waiter-calls', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM waiter_calls WHERE restaurant_id=$1 ORDER BY called_at DESC LIMIT 50',
    [req.user.restaurantId]
  );
  res.json(result.rows);
});

app.patch('/api/waiter-calls/:id/ack', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'UPDATE waiter_calls SET status=$1 WHERE id=$2 AND restaurant_id=$3 RETURNING *',
    ['acknowledged', req.params.id, req.user.restaurantId]
  );
  res.json(result.rows[0]);
});

// ═══════════════════════════════
// KAMPANYALAR
// ═══════════════════════════════

app.get('/api/campaigns', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM campaigns WHERE restaurant_id=$1 ORDER BY starts_at DESC',
    [req.user.restaurantId]
  );
  res.json(result.rows);
});

app.post('/api/campaigns', authMiddleware, async (req, res) => {
  const { title, description, emoji } = req.body;
  const result = await pool.query(
    'INSERT INTO campaigns (restaurant_id, title, description, emoji) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.user.restaurantId, title, description, emoji || '🎉']
  );
  res.json(result.rows[0]);
});

app.patch('/api/campaigns/:id/toggle', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'UPDATE campaigns SET is_active = NOT is_active WHERE id=$1 AND restaurant_id=$2 RETURNING *',
    [req.params.id, req.user.restaurantId]
  );
  res.json(result.rows[0]);
});

app.delete('/api/campaigns/:id', authMiddleware, async (req, res) => {
  await pool.query(
    'DELETE FROM campaigns WHERE id=$1 AND restaurant_id=$2',
    [req.params.id, req.user.restaurantId]
  );
  res.json({ success: true });
});
// ═══════════════════════════════
// ÇALIŞMA SAATLERİ
// ═══════════════════════════════

app.get('/api/working-hours', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM working_hours WHERE restaurant_id=$1 ORDER BY day_of_week',
    [req.user.restaurantId]
  );
  // Eğer hiç kayıt yoksa varsayılan oluştur
  if (!result.rows.length) {
    const days = ['Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi','Pazar'];
    for (let i = 0; i < 7; i++) {
      await pool.query(
        'INSERT INTO working_hours (restaurant_id, day_of_week, opens_at, closes_at, is_closed) VALUES ($1,$2,$3,$4,$5)',
        [req.user.restaurantId, i, '09:00', '22:00', false]
      );
    }
    const newResult = await pool.query(
      'SELECT * FROM working_hours WHERE restaurant_id=$1 ORDER BY day_of_week',
      [req.user.restaurantId]
    );
    return res.json(newResult.rows);
  }
  res.json(result.rows);
});



// ═══════════════════════════════
// ÇALIŞMA SAATLERİ
// ═══════════════════════════════

app.get('/api/working-hours', authMiddleware, async (req, res) => {
  try {
    let result = await pool.query(
      'SELECT * FROM working_hours WHERE restaurant_id=$1 ORDER BY day_of_week',
      [req.user.restaurantId]
    );
    if (!result.rows.length) {
      for (let i = 0; i < 7; i++) {
        await pool.query(
          'INSERT INTO working_hours (restaurant_id, day_of_week, opens_at, closes_at, is_closed) VALUES ($1,$2,$3,$4,$5)',
          [req.user.restaurantId, i, '09:00', '22:00', false]
        );
      }
      result = await pool.query(
        'SELECT * FROM working_hours WHERE restaurant_id=$1 ORDER BY day_of_week',
        [req.user.restaurantId]
      );
    }
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/working-hours', authMiddleware, async (req, res) => {
  try {
    const { hours } = req.body;
    for (const h of hours) {
      await pool.query(
        `UPDATE working_hours SET opens_at=$1, closes_at=$2, is_closed=$3
         WHERE restaurant_id=$4 AND day_of_week=$5`,
        [h.opens_at, h.closes_at, h.is_closed, req.user.restaurantId, h.day_of_week]
      );
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════
// ABONELIK
// ═══════════════════════════════

app.get('/api/subscription', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM subscriptions WHERE user_id=$1',
    [req.user.userId]
  );
  res.json(result.rows[0]);
});
// ═══════════════════════════════
// ŞİFRE SIFIRLAMA
// ═══════════════════════════════
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const resetTokens = {}; // Geçici token store

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!result.rows[0]) return res.json({ success: true }); // Güvenlik için her zaman success dön

    const token = uuidv4();
    const expires = Date.now() + 3600000; // 1 saat
    resetTokens[token] = { email, expires };

    const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}`;

    await resend.emails.send({
      from: 'QRMenu <noreply@ucgun.com.tr>',
      to: email,
      subject: 'Şifre Sıfırlama — QRMenu',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h2 style="color:#111;margin-bottom:8px">Şifrenizi sıfırlayın</h2>
          <p style="color:#666;margin-bottom:24px">Aşağıdaki butona tıklayarak şifrenizi sıfırlayabilirsiniz. Bu link 1 saat geçerlidir.</p>
          <a href="${resetUrl}" style="background:#e8c547;color:#111;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Şifremi Sıfırla</a>
          <p style="color:#999;font-size:12px;margin-top:24px">Bu emaili siz talep etmediyseniz görmezden gelebilirsiniz.</p>
        </div>
      `
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Email hatası:', err);
    res.status(500).json({ error: 'Email gönderilemedi: ' + err.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  const record = resetTokens[token];
  if (!record || record.expires < Date.now()) {
    return res.status(400).json({ error: 'Link geçersiz veya süresi dolmuş' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE email=$2', [hash, record.email]);
    delete resetTokens[token];
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ═══════════════════════════════
// ADMİN PANEL
// ═══════════════════════════════

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin yetkisi gerekli' });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Geçersiz token' });
  }
}

// Admin girişi
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1 AND role=$2', [email, 'admin']);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Admin bulunamadı' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Şifre hatalı' });
    const token = jwt.sign({ userId: user.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Tüm kullanıcılar
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  const result = await pool.query(`
    SELECT u.id, u.email, u.role, u.created_at,
           r.name as restaurant_name, r.slug,
           s.plan, s.status, s.trial_ends_at
    FROM users u
    LEFT JOIN restaurants r ON r.user_id = u.id
    LEFT JOIN subscriptions s ON s.user_id = u.id
    ORDER BY u.created_at DESC
  `);
  res.json(result.rows);
});

// Kullanıcı sil
app.delete('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// Abonelik güncelle
app.put('/api/admin/subscription/:userId', adminMiddleware, async (req, res) => {
  const { plan, status } = req.body;
  await pool.query(
    'UPDATE subscriptions SET plan=$1, status=$2 WHERE user_id=$3',
    [plan, status, req.params.userId]
  );
  res.json({ success: true });
});

// Platform istatistikleri
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  const [users, restaurants, products, feedbacks, subs] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM users WHERE role=$1', ['owner']),
    pool.query('SELECT COUNT(*) FROM restaurants'),
    pool.query('SELECT COUNT(*) FROM products'),
    pool.query('SELECT COUNT(*) FROM feedbacks'),
    pool.query('SELECT plan, COUNT(*) FROM subscriptions GROUP BY plan'),
  ]);
  res.json({
    totalUsers: parseInt(users.rows[0].count),
    totalRestaurants: parseInt(restaurants.rows[0].count),
    totalProducts: parseInt(products.rows[0].count),
    totalFeedbacks: parseInt(feedbacks.rows[0].count),
    planDistribution: subs.rows,
  });
});

// Admin oluştur (sadece bir kez çalıştırılır)
app.post('/api/admin/create', async (req, res) => {
  const { email, password, secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Yetkisiz' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id, email',
      [email, hash, 'admin']
    );
    res.json({ success: true, user: result.rows[0] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
// ═══════════════════════════════
// SUNUCUYU BAŞLAT
// ═══════════════════════════════
// ═══════════════════════════════
// FOTOĞRAF YÜKLEME
// ═══════════════════════════════

app.post('/api/upload/product-image', authMiddleware, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya seçilmedi' });
  try {
    console.log('Upload başladı:', req.file?.originalname, process.env.R2_BUCKET, process.env.R2_ENDPOINT);
    console.log('R2 Ayarları:', {
      endpoint: process.env.R2_ENDPOINT,
      bucket: process.env.R2_BUCKET,
      accessKey: process.env.R2_ACCESS_KEY ? 'VAR' : 'YOK',
      secretKey: process.env.R2_SECRET_KEY ? 'VAR' : 'YOK'
    });
    const ext = req.file.mimetype === 'image/png' ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const fileName = `restaurants/${req.user.restaurantId}/products/${Date.now()}.${ext}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));
    const imageUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;
    res.json({ imageUrl });
  } catch (err) {
    console.error('R2 Yükleme Hatası:', err);
    res.status(500).json({ error: 'Yükleme hatası: ' + err.message });
  }
});

app.post('/api/upload/logo', authMiddleware, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya seçilmedi' });
  try {
    const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
    const fileName = `restaurants/${req.user.restaurantId}/logo.${ext}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));
    const logoUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;
    await pool.query('UPDATE restaurants SET logo_url=$1 WHERE id=$2', [logoUrl, req.user.restaurantId]);
    res.json({ logoUrl });
  } catch (err) {
    res.status(500).json({ error: 'Yükleme hatası: ' + err.message });
  }
});
// ═══════════════════════════════
// OTOMATİK YEDEKLEME — Her gün saat 03:00'da
// ═══════════════════════════════
function scheduleBackup() {
  const now = new Date();
  const next = new Date();
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntilNext = next - now;
  setTimeout(async () => {
    await runBackup();
    setInterval(runBackup, 24 * 60 * 60 * 1000);
  }, msUntilNext);
  console.log(`📅 Sonraki yedek: ${next.toLocaleString('tr-TR')}`);
}

async function runBackup() {
  console.log('🔄 Otomatik yedekleme başlıyor...');
  try {
    const tables = ['users','restaurants','subscriptions','categories','products','feedbacks','waiter_calls','campaigns','working_hours'];
    const backupData = {};
    for (const table of tables) {
      try {
        const result = await pool.query(`SELECT * FROM ${table}`);
        backupData[table] = result.rows;
      } catch(e) { backupData[table] = []; }
    }
    const now = new Date();
    const fileName = `backups/${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}.json`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileName,
      Body: JSON.stringify(backupData, null, 2),
      ContentType: 'application/json',
    }));
    console.log(`✅ Yedek kaydedildi: ${fileName}`);
  } catch(err) {
    console.error('❌ Yedekleme hatası:', err.message);
  }
}
const PORT = process.env.PORT || 3000;
// Müşteri menüsü sayfası — /menu/:slug
app.get('/admin', (req, res) => {
  res.sendFile('admin.html', { root: 'public' });
});
app.get('/reset-password', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});
app.get('/menu/:slug', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// Tüm diğer rotalar — index.html'e yönlendir
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});
server.listen(PORT, async () => {
  console.log(`🚀 QRMenu API çalışıyor: port ${PORT}`);
  await initDB();
  scheduleBackup();
});