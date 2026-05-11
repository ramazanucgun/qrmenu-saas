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
const { Resend } = require('resend');
let rateLimit;
try { rateLimit = require('express-rate-limit'); } catch(e) { console.warn('⚠️  express-rate-limit yüklü değil, rate limiting devre dışı'); }
let Iyzipay;
try { Iyzipay = require('iyzipay'); } catch(e) { console.warn('iyzipay yüklü değil'); }

function getIyzipay() {
  if (!Iyzipay) throw new Error('iyzipay paketi yüklü değil');
  const apiKey    = (process.env.IYZICO_API_KEY    || '').trim();
  const secretKey = (process.env.IYZICO_SECRET_KEY || '').trim();
  const isProd    = (process.env.IYZICO_ENV || '').trim().toLowerCase() === 'prod';
  if (!apiKey || !secretKey) throw new Error('IYZICO_API_KEY veya IYZICO_SECRET_KEY tanımlanmamış');
  console.log(`💳 iyzipay ortam: ${isProd ? 'PROD (live)' : 'SANDBOX'}, apiKey: ${apiKey.slice(0,8)}...`);
  return new Iyzipay({
    apiKey,
    secretKey,
    uri: isProd ? 'https://api.iyzipay.com' : 'https://sandbox-api.iyzipay.com'
  });
}
let sharp;
try { sharp = require('sharp'); } catch(e) { sharp = null; console.warn('sharp yüklü değil, resimler sıkıştırılmadan kaydedilecek'); }
let compression;
try { compression = require('compression'); } catch(e) { compression = null; }
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
require('dotenv').config();

const resend = new Resend(process.env.RESEND_API_KEY);
// Resim sıkıştırma helper
async function resizeImage(buffer, mimeType, options = {}) {
  if (!sharp) {
    // sharp yok — orijinal base64 döndür
    return { buffer, mimeType };
  }
  const {
    width = 800,
    height = 800,
    quality = 72,
  } = options;
  const resized = await sharp(buffer)
    .resize(width, height, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
  return { buffer: resized, mimeType: 'image/webp' };
}

// R2 Storage client
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  forcePathStyle: false, // Cloudflare R2 virtual-hosted style kullanır
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

// Multer — resim yükleme
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Sadece JPG, PNG, WebP'));
  }
});

// Multer — Excel yükleme
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream'
    ];
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (allowed.includes(file.mimetype) || ext === 'xlsx' || ext === 'xls') {
      cb(null, true);
    } else {
      cb(new Error('Sadece Excel dosyası (.xlsx, .xls)'));
    }
  }
});

const app = express();
const server = http.createServer(app);

// WebSocket — garson çağrı sistemi
const wss = new WebSocket.Server({ server });
// restaurantId → Set<WebSocket>  (birden fazla sekme/cihaz desteklenir)
const restaurantSockets = {};

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.replace('/?', '').replace('?', ''));
  const restaurantId = params.get('restaurantId');
  if (!restaurantId) { ws.close(); return; }

  if (!restaurantSockets[restaurantId]) restaurantSockets[restaurantId] = new Set();
  restaurantSockets[restaurantId].add(ws);

  // Ping/pong — Render 55sn'de idle bağlantıyı keser, 30sn'de ping at
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', () => {
    if (restaurantSockets[restaurantId]) {
      restaurantSockets[restaurantId].delete(ws);
      if (restaurantSockets[restaurantId].size === 0) {
        delete restaurantSockets[restaurantId];
      }
    }
  });

  ws.on('error', () => ws.terminate());
});

// Her 30 saniyede ping gönder — bağlantıyı canlı tut
const wsPingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(wsPingInterval));

function notifyRestaurant(restaurantId, data) {
  const sockets = restaurantSockets[restaurantId];
  if (!sockets || sockets.size === 0) return;
  const json = JSON.stringify(data);
  sockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  });
}

// Veritabanı bağlantısı
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
});

// ═══════════════════════════════
// CORS — sadece izin verilen originler
// ═══════════════════════════════
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.APP_URL || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Sunucu-sunucu (curl, Postman, mobil) istekleri: origin yok
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: izin verilmeyen origin — ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400, // preflight 24 saat cache
}));

if (compression) app.use(compression());

// Google OAuth popup'ının çalışması için COOP/COEP header'larını ayarla
app.use((req, res, next) => {
  // Sadece HTML sayfaları için — API ve statik dosyalara dokunma
  const isHtml = !req.path.startsWith('/api/') && !req.path.includes('.');
  if (isHtml) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// JWT doğrulama
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    req.isImpersonated = !!decoded.impersonatedBy;
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
      is_verified BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS restaurants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      slug VARCHAR(100) UNIQUE NOT NULL,
      name VARCHAR(200) NOT NULL,
      logo_url TEXT,
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
      starts_at TIMESTAMP,
      ends_at TIMESTAMP,
      payment_method VARCHAR(30),
      payment_note TEXT,
      iyzico_subscription_id VARCHAR(100),
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
      note TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      called_at TIMESTAMP DEFAULT NOW()
    );
CREATE TABLE IF NOT EXISTS email_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(100) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS menu_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  viewed_at TIMESTAMP DEFAULT NOW(),
  device VARCHAR(20) DEFAULT 'unknown',
  country VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS subscription_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  sent_at TIMESTAMP DEFAULT NOW(),
  days_remaining INTEGER
);

CREATE TABLE IF NOT EXISTS system_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  message TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  token VARCHAR(100) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
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

  // Mevcut tablolara eksik kolonları ekle
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_number VARCHAR(20)`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_office VARCHAR(100)`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_address TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS city VARCHAR(100)`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kvkk_accepted BOOLEAN DEFAULT false`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted BOOLEAN DEFAULT false`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_accepted BOOLEAN DEFAULT false`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kvkk_accepted_at TIMESTAMP`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255)`).catch(()=>{});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS image_url TEXT`);
  await pool.query(`ALTER TABLE products ALTER COLUMN image_url TYPE TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE restaurants ALTER COLUMN logo_url TYPE TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS waiter_enabled BOOLEAN DEFAULT true`).catch(()=>{});
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS google_maps_url TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS starts_at TIMESTAMP`).catch(()=>{});
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ends_at TIMESTAMP`).catch(()=>{});
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30)`).catch(()=>{});
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_note TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS iyzico_subscription_id VARCHAR(100)`).catch(()=>{});
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS theme VARCHAR(50) DEFAULT 'classic'`).catch(()=>{});
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS card_style VARCHAR(20) DEFAULT 'list'`).catch(()=>{});
  await pool.query(`ALTER TABLE campaigns ALTER COLUMN image_url TYPE TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS translations JSONB DEFAULT '{}'`).catch(()=>{});
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS translations JSONB DEFAULT '{}'`).catch(()=>{});
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS supported_languages TEXT[] DEFAULT ARRAY['tr']`).catch(()=>{});
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS tagline VARCHAR(255)`).catch(()=>{});
  await pool.query(`ALTER TABLE waiter_calls ADD COLUMN IF NOT EXISTS note TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS link_type VARCHAR(20) DEFAULT 'none'`).catch(()=>{}); // none | product | category | url
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS link_product_id UUID`).catch(()=>{});
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS link_category_id UUID`).catch(()=>{});
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS link_url TEXT`).catch(()=>{});

  // ═══════════════════════════════
  // VERİTABANI İNDEKSLERİ
  // CREATE INDEX IF NOT EXISTS — mevcut indexleri bozmaz, güvenle çalışır
  // ═══════════════════════════════
  const indexes = [
    // restaurants.slug — menü görüntüleme ve QR yönlendirme her sorguda bunu kullanır
    `CREATE INDEX IF NOT EXISTS idx_restaurants_slug ON restaurants(slug)`,
    // restaurants.user_id — kullanıcının restoranını çekmek için
    `CREATE INDEX IF NOT EXISTS idx_restaurants_user_id ON restaurants(user_id)`,
    // products.restaurant_id — menü sayfası tüm ürünleri bu kolondan çeker
    `CREATE INDEX IF NOT EXISTS idx_products_restaurant_id ON products(restaurant_id)`,
    // products.category_id — kategori bazlı ürün listeleme
    `CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id)`,
    // categories.restaurant_id — menü sayfası tüm kategorileri buradan çeker
    `CREATE INDEX IF NOT EXISTS idx_categories_restaurant_id ON categories(restaurant_id)`,
    // subscriptions.user_id — abonelik kontrolü her auth'da çalışır
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)`,
    // subscriptions.iyzico_subscription_id — callback'te tekrar ödeme kontrolü
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_iyzico_id ON subscriptions(iyzico_subscription_id)`,
    // menu_views — analytics sorgularının hepsi (restaurant_id + viewed_at) filtreler
    // Bileşik index tek kolonlu iki indexten çok daha hızlı
    `CREATE INDEX IF NOT EXISTS idx_menu_views_restaurant_viewed ON menu_views(restaurant_id, viewed_at DESC)`,
    // waiter_calls.restaurant_id — garson çağrı listesi
    `CREATE INDEX IF NOT EXISTS idx_waiter_calls_restaurant_id ON waiter_calls(restaurant_id)`,
    // feedbacks.restaurant_id — geri bildirim listesi
    `CREATE INDEX IF NOT EXISTS idx_feedbacks_restaurant_id ON feedbacks(restaurant_id)`,
    // campaigns.restaurant_id — aktif kampanya sorgusu
    `CREATE INDEX IF NOT EXISTS idx_campaigns_restaurant_id ON campaigns(restaurant_id)`,
    // users.email — login, register, şifre sıfırlama her sorguda bunu kullanır
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    // system_notifications.user_id — bildirim listesi
    `CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON system_notifications(user_id)`,
    // subscriptions.ends_at — aktif, bitiş tarihi olan aboneliklerde günlük cron sorgusu
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_ends_at ON subscriptions(ends_at) WHERE status = 'active' AND ends_at IS NOT NULL`,
  ];

  for (const sql of indexes) {
    await pool.query(sql).catch(err =>
      console.warn('Index oluşturulamadı (önemsiz):', err.message)
    );
  }

  console.log('✅ Veritabanı tabloları ve indexler hazır');
}

// ═══════════════════════════════
// RATE LIMITING
// ═══════════════════════════════
function makeLimit(options) {
  if (!rateLimit) return (req, res, next) => next(); // paket yoksa geç
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,  // RateLimit-* headerları döndür
    legacyHeaders: false,
    keyGenerator: (req) => {
      // Proxy arkasındaysa gerçek IP'yi al
      return (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    },
    handler: (req, res) => {
      res.status(429).json({ error: options.message || 'Çok fazla istek. Lütfen bekleyin.' });
    },
  });
}

// Giriş & kayıt: 15 dakikada 10 deneme
const authLimiter = makeLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Çok fazla giriş denemesi. 15 dakika sonra tekrar deneyin.',
});

// Şifre sıfırlama: 1 saatte 5 istek
const passwordLimiter = makeLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Çok fazla şifre sıfırlama isteği. 1 saat sonra tekrar deneyin.',
});

// Genel API: 1 dakikada 100 istek (DDoS önlemi)
const generalLimiter = makeLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: 'Çok fazla istek gönderdiniz. Lütfen bekleyin.',
});

app.use('/api/', generalLimiter);

// ═══════════════════════════════
// AUTH — KAYIT & GİRİŞ
// ═══════════════════════════════

// Kayıt ol
app.post('/api/auth/google', authLimiter, async (req, res) => {
  const { credential, restaurantName } = req.body;
  if (!credential) return res.status(400).json({ error: 'Google token zorunlu' });
  try {
    // Google token doğrula
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    // Kullanıcı var mı kontrol et
    let userResult = await pool.query(
      'SELECT u.*, r.id as restaurant_id FROM users u LEFT JOIN restaurants r ON r.user_id = u.id WHERE u.email=$1',
      [email]
    );

    let user = userResult.rows[0];
    let restaurantId;

    if (user) {
      // Mevcut kullanıcı — google_id güncelle
      await pool.query(
        'UPDATE users SET google_id=$1, avatar_url=$2, is_verified=true WHERE id=$3',
        [googleId, picture, user.id]
      );
      restaurantId = user.restaurant_id;
    } else {
      // Yeni kullanıcı — kayıt ol
      if (!restaurantName) {
        return res.status(200).json({ needsRestaurantName: true, email, googleId, picture });
      }
      const { firstName: gFirstName='', lastName: gLastName='', phone: gPhone='',
              menuSlug: gMenuSlug='', kvkkAccepted: gKvkk=false,
              termsAccepted: gTerms=false, marketingAccepted: gMarketing=false } = req.body;

      if (!gKvkk || !gTerms) {
        return res.status(400).json({ needsRestaurantName: true, needsConsent: true, email, googleId, picture, needsInfo: true });
      }

      const now = new Date();
      const newUser = await pool.query(
        `INSERT INTO users (email, password_hash, google_id, avatar_url, is_verified,
          first_name, last_name, phone, kvkk_accepted, terms_accepted, marketing_accepted,
          kvkk_accepted_at, terms_accepted_at)
         VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [email, '', googleId, picture,
         gFirstName.trim()||null, gLastName.trim()||null, gPhone||null,
         !!gKvkk, !!gTerms, !!gMarketing, now, now]
      );
      user = newUser.rows[0];

      function toSlugG(str) {
        return str.toLowerCase()
          .replace(/ğ/g,'g').replace(/ü/g,'u').replace(/ş/g,'s')
          .replace(/ı/g,'i').replace(/ö/g,'o').replace(/ç/g,'c')
          .replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
      }
      const desiredSlugG = gMenuSlug ? toSlugG(gMenuSlug) : '';
      const baseSlug = toSlugG(restaurantName);
      let slug = desiredSlugG || baseSlug;
      if (slug.length < 3) slug = baseSlug;
      const existing = await pool.query('SELECT id FROM restaurants WHERE slug=$1', [slug]);
      if (existing.rows.length) {
        if (desiredSlugG) return res.status(400).json({ error: 'Bu menü linki zaten kullanımda' });
        slug = baseSlug + '-' + Math.random().toString(36).substr(2,4);
      }

      const restResult = await pool.query(
        'INSERT INTO restaurants (user_id, slug, name) VALUES ($1,$2,$3) RETURNING id, slug',
        [user.id, slug, restaurantName]
      );
      restaurantId = restResult.rows[0].id;
      await pool.query('INSERT INTO subscriptions (user_id) VALUES ($1)', [user.id]);

      // Hoşgeldin emaili (Google kayıt)
      try {
        await resend.emails.send({
          from: 'CafeMenu <noreply@cafemenu.com.tr>',
          to: email,
          subject: "CafeMenu'ya Hoş Geldiniz! 🎉",
          html: `
            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff">
              <div style="text-align:center;margin-bottom:28px">
                <img src="https://app.cafemenu.com.tr/icons/cafemenu-logo.png" alt="CafeMenu" style="height:56px;object-fit:contain">
              </div>
              <h2 style="color:#111;margin-bottom:12px">Hoş Geldiniz! 👋</h2>
              <p style="color:#444;line-height:1.6;margin-bottom:16px">
                <strong>${restaurantName}</strong> için dijital menünüz oluşturuldu.
                14 günlük ücretsiz trial süreniz başladı.
              </p>
              <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin-bottom:20px">
                <div style="font-size:13px;color:#666;margin-bottom:6px">Menü linkiniz:</div>
                <div style="font-family:monospace;font-size:14px;color:#e8a020;font-weight:600">
                  https://app.cafemenu.com.tr/${restResult.rows[0].slug}
                </div>
              </div>
              <div style="text-align:center">
                <a href="https://app.cafemenu.com.tr" style="background:#e8c547;color:#111;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Dashboard'a Git →</a>
              </div>
              <div style="border-top:1px solid #eee;margin-top:28px;padding-top:16px;text-align:center;font-size:12px;color:#aaa">
                CafeMenu · cafemenu.com.tr
              </div>
            </div>`
        });
      } catch(emailErr) {
        console.error('❌ Google kayıt emaili gönderilemedi:', emailErr?.message || emailErr);
      }
    }

    const token = jwt.sign(
      { userId: user.id, restaurantId },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, restaurantId });
  } catch (err) {
    console.error('Google auth hatası:', err.message);
    res.status(500).json({ error: 'Google girişi başarısız: ' + err.message });
  }
});

// Google access_token ile giriş (GSI yüklenemediğinde fallback)
app.post('/api/auth/google-token', authLimiter, async (req, res) => {
  const { accessToken, email, name, picture, googleId, restaurantName } = req.body;
  if (!accessToken || !email) return res.status(400).json({ error: 'Eksik bilgi' });
  try {
    // Access token'ı Google ile doğrula
    const verify = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!verify.ok) return res.status(401).json({ error: 'Geçersiz Google token' });
    const gUser = await verify.json();
    if (gUser.email !== email) return res.status(401).json({ error: 'Email uyuşmuyor' });

    let userResult = await pool.query(
      'SELECT u.*, r.id as restaurant_id FROM users u LEFT JOIN restaurants r ON r.user_id = u.id WHERE u.email=$1',
      [email]
    );
    let user = userResult.rows[0];
    let restaurantId;

    if (user) {
      await pool.query('UPDATE users SET google_id=$1, avatar_url=$2, is_verified=true WHERE id=$3', [googleId, picture, user.id]);
      restaurantId = user.restaurant_id;
    } else {
      const { firstName: tFirstName='', lastName: tLastName='', phone: tPhone='',
              menuSlug: tMenuSlug='', kvkkAccepted: tKvkk=false,
              termsAccepted: tTerms=false, marketingAccepted: tMarketing=false } = req.body;

      if (!restaurantName) return res.status(200).json({ needsRestaurantName: true, needsInfo: true });
      if (!tKvkk || !tTerms) {
        return res.status(400).json({ needsRestaurantName: true, needsConsent: true, needsInfo: true });
      }

      const nowT = new Date();
      const newUser = await pool.query(
        `INSERT INTO users (email, password_hash, google_id, avatar_url, is_verified,
          first_name, last_name, phone, kvkk_accepted, terms_accepted, marketing_accepted,
          kvkk_accepted_at, terms_accepted_at)
         VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [email, '', googleId||gUser.sub, picture||gUser.picture,
         tFirstName.trim()||null, tLastName.trim()||null, tPhone||null,
         !!tKvkk, !!tTerms, !!tMarketing, nowT, nowT]
      );
      user = newUser.rows[0];
      function toSlugT(str) {
        return str.toLowerCase()
          .replace(/[ğ]/g,'g').replace(/[ü]/g,'u').replace(/[ş]/g,'s')
          .replace(/[ı]/g,'i').replace(/[ö]/g,'o').replace(/[ç]/g,'c')
          .replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
      }
      const desiredSlugT = tMenuSlug ? toSlugT(tMenuSlug) : '';
      const baseSlug2 = toSlugT(restaurantName);
      let slug = desiredSlugT || baseSlug2;
      if (slug.length < 3) slug = baseSlug2;
      const existingSlug2 = await pool.query('SELECT id FROM restaurants WHERE slug=$1', [slug]);
      if (existingSlug2.rows.length) {
        if (desiredSlugT) return res.status(400).json({ error: 'Bu menü linki zaten kullanımda' });
        slug = baseSlug2 + '-' + Math.random().toString(36).substr(2,4);
      }
      const rest = await pool.query('INSERT INTO restaurants (user_id, slug, name) VALUES ($1,$2,$3) RETURNING id, slug', [user.id, slug, restaurantName]);
      restaurantId = rest.rows[0].id;
      await pool.query('INSERT INTO subscriptions (user_id) VALUES ($1)', [user.id]);

      // Hoşgeldin emaili (Google token kayıt)
      try {
        await resend.emails.send({
          from: 'CafeMenu <noreply@cafemenu.com.tr>',
          to: email,
          subject: "CafeMenu'ya Hoş Geldiniz! 🎉",
          html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff">
            <div style="text-align:center;margin-bottom:28px">
              <img src="https://app.cafemenu.com.tr/icons/cafemenu-logo.png" alt="CafeMenu" style="height:56px;object-fit:contain">
            </div>
            <h2 style="color:#111;margin-bottom:12px">Hoş Geldiniz! 👋</h2>
            <p style="color:#444;line-height:1.6;margin-bottom:16px"><strong>${restaurantName}</strong> için dijital menünüz oluşturuldu. 14 günlük ücretsiz trial süreniz başladı.</p>
            <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin-bottom:20px">
              <div style="font-size:13px;color:#666;margin-bottom:6px">Menü linkiniz:</div>
              <div style="font-family:monospace;font-size:14px;color:#e8a020;font-weight:600">https://app.cafemenu.com.tr/${rest.rows[0].slug}</div>
            </div>
            <div style="text-align:center">
              <a href="https://app.cafemenu.com.tr" style="background:#e8c547;color:#111;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Dashboard'a Git →</a>
            </div>
            <div style="border-top:1px solid #eee;margin-top:28px;padding-top:16px;text-align:center;font-size:12px;color:#aaa">CafeMenu · cafemenu.com.tr</div>
          </div>`
        });
      } catch(emailErr) {
        console.error('❌ Google token kayıt emaili gönderilemedi:', emailErr?.message || emailErr);
      }
    }
    const token = jwt.sign({ userId: user.id, restaurantId }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, restaurantId });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/google-client-id', (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || '' });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, restaurantName, firstName, lastName, phone, menuSlug,
          kvkkAccepted, termsAccepted, marketingAccepted } = req.body;

  if (!email || !password || !restaurantName || !firstName || !lastName || !phone) {
    return res.status(400).json({ error: 'Ad, soyad, telefon, restoran adı ve email zorunludur' });
  }
  if (!kvkkAccepted || !termsAccepted) {
    return res.status(400).json({ error: 'Kullanım şartları ve KVKK metnini onaylamanız zorunludur' });
  }
  // Telefon format kontrolü
  const phoneClean = phone.replace(/\s/g,'');
  const phoneRegex = /^(\+90|0)?5\d{9}$/;
  if (!phoneRegex.test(phoneClean)) {
    return res.status(400).json({ error: 'Geçerli bir Türkiye cep telefonu numarası girin (05XX XXX XX XX)' });
  }
  // Email format kontrolü
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Geçerli bir email adresi girin' });
  }
  // Şifre uzunluğu kontrolü
  if (password.length < 8) {
    return res.status(400).json({ error: 'Şifre en az 8 karakter olmalı' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const now = new Date();
    const userResult = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, phone,
        kvkk_accepted, terms_accepted, marketing_accepted, kvkk_accepted_at, terms_accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, email`,
      [email, hash, firstName.trim(), lastName.trim(), phoneClean,
       !!kvkkAccepted, !!termsAccepted, !!marketingAccepted, now, now]
    );
    const user = userResult.rows[0];

    // Slug oluştur — önce kullanıcının istediği slug'ı dene
    function toSlug(str) {
      return str.toLowerCase()
        .replace(/ğ/g,'g').replace(/ü/g,'u').replace(/ş/g,'s')
        .replace(/ı/g,'i').replace(/ö/g,'o').replace(/ç/g,'c')
        .replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
    }
    const desiredSlug = menuSlug ? toSlug(menuSlug) : '';
    const baseSlug3 = toSlug(restaurantName);
    let slug = desiredSlug || baseSlug3;
    if (!slug) slug = baseSlug3;
    // Slug minimum 3 karakter olmalı
    if (slug.length < 3) slug = baseSlug3;
    const existingSlug3 = await pool.query('SELECT id FROM restaurants WHERE slug=$1', [slug]);
    if (existingSlug3.rows.length) {
      if (desiredSlug && existingSlug3.rows.length) {
        return res.status(400).json({ error: 'Bu menü linki zaten kullanımda, farklı bir link deneyin' });
      }
      slug = baseSlug3 + '-' + Math.random().toString(36).substr(2,4);
    }

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
// Email doğrulama tokeni oluştur
const verifyToken = uuidv4();
const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 saat
await pool.query(
  'INSERT INTO email_verifications (user_id, token, expires_at) VALUES ($1,$2,$3)',
  [user.id, verifyToken, verifyExpires]
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
              <img src="https://app.cafemenu.com.tr/icons/cafemenu-logo.png" alt="CafeMenu" style="height:56px;object-fit:contain">
            </div>
            <h2 style="color:#111;margin-bottom:12px">Hoş Geldiniz! 👋</h2>
            <p style="color:#444;line-height:1.6;margin-bottom:16px">
              <strong>${restaurantName}</strong> için dijital menünüz oluşturuldu. 
              14 günlük ücretsiz trial süreniz başladı.
            </p>
            <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin-bottom:20px">
              <div style="font-size:13px;color:#666;margin-bottom:6px">Menü linkiniz:</div>
              <div style="font-family:monospace;font-size:14px;color:#e8a020;font-weight:600">
                https://app.cafemenu.com.tr/${restResult.rows[0].slug}
              </div>
            </div>
            <p style="color:#444;line-height:1.6;margin-bottom:24px">
              Hemen giriş yapıp menünüzü oluşturmaya başlayabilirsiniz.
            </p>
            <div style="background:#fff8e1;border:1px solid #e8c547;border-radius:10px;padding:16px;margin-bottom:20px;text-align:center">
              <div style="font-size:13px;color:#666;margin-bottom:10px">Email adresinizi doğrulamak için aşağıdaki butona tıklayın:</div>
              <a href="${process.env.APP_URL}/verify-email?token=${verifyToken}" style="background:#e8c547;color:#111;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">✅ Email Adresimi Doğrula</a>
              <div style="font-size:11px;color:#aaa;margin-top:8px">Bu link 24 saat geçerlidir</div>
            </div>
            <div style="text-align:center">
              <a href="https://app.cafemenu.com.tr" style="background:#f5f5f5;color:#111;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Dashboard'a Git →</a>
            </div>
            <div style="border-top:1px solid #eee;margin-top:28px;padding-top:16px;text-align:center;font-size:12px;color:#aaa">
              CafeMenu · cafemenu.com.tr
            </div>
          </div>
        `
      });
    } catch(emailErr) {
      console.error('❌ Hoşgeldin emaili gönderilemedi:', emailErr?.message || emailErr);
    }

    res.json({
      success: true,
      message: 'Kayıt başarılı! Email adresinizi doğrulayın.',
      email: email,
      slug: restResult.rows[0].slug
    });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Bu email zaten kayıtlı' });
    res.status(500).json({ error: 'Sunucu hatası: ' + err.message });
  }
});

// Giriş yap
app.post('/api/auth/login', authLimiter, async (req, res) => {
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

    if (!user.is_verified) {
      return res.status(400).json({ error: 'EMAIL_NOT_VERIFIED' });
    }

    const token = jwt.sign(
      { userId: user.id, restaurantId: user.restaurant_id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, restaurantId: user.restaurant_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════
// RESTORAN
// ═══════════════════════════════

// Kullanıcı profil bilgilerini getir
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, phone, tax_number, tax_office,
              billing_address, city, kvkk_accepted, terms_accepted, marketing_accepted,
              kvkk_accepted_at, terms_accepted_at, created_at
       FROM users WHERE id=$1`,
      [req.user.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(result.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Kullanıcı profil bilgilerini güncelle
app.put('/api/user/profile', authMiddleware, async (req, res) => {
  const { firstName, lastName, phone, taxNumber, taxOffice, billingAddress, city, marketingAccepted } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users SET
        first_name = COALESCE($1, first_name),
        last_name  = COALESCE($2, last_name),
        phone      = COALESCE($3, phone),
        tax_number = COALESCE($4, tax_number),
        tax_office = COALESCE($5, tax_office),
        billing_address = COALESCE($6, billing_address),
        city       = COALESCE($7, city),
        marketing_accepted = COALESCE($8, marketing_accepted)
       WHERE id=$9 RETURNING id, email, first_name, last_name, phone, tax_number, tax_office, billing_address, city, marketing_accepted`,
      [firstName||null, lastName||null, phone||null, taxNumber||null,
       taxOffice||null, billingAddress||null, city||null,
       marketingAccepted !== undefined ? marketingAccepted : null,
       req.user.userId]
    );
    res.json(result.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/restaurant/me', authMiddleware, async (req, res) => {
  try {
    if (!req.user.restaurantId) return res.status(404).json({ error: 'Restoran bulunamadı' });
    const result = await pool.query(
      `SELECT id, slug, name, logo_url, brand_color, font_family,
              theme, card_style, wifi_name, wifi_password,
              instagram_url, facebook_url, google_maps_url,
              is_published, waiter_enabled,
              COALESCE(tagline, '') as tagline,
              COALESCE(supported_languages, ARRAY['tr']) as supported_languages,
              created_at
       FROM restaurants WHERE id = $1`,
      [req.user.restaurantId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Restoran bulunamadı' });
    res.json(result.rows[0]);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/restaurant/me', authMiddleware, async (req, res) => {
  const { name, brand_color, font_family, theme, card_style, wifi_name, wifi_password, instagram_url, facebook_url, google_maps_url, waiter_enabled, is_published, tagline, supported_languages } = req.body;
  try {
    const result = await pool.query(
      `UPDATE restaurants SET name=$1, brand_color=$2, font_family=$3,
       wifi_name=$4, wifi_password=$5, instagram_url=$6, facebook_url=$7,
       waiter_enabled=COALESCE($8, waiter_enabled),
       is_published=COALESCE($9, is_published),
       theme=COALESCE($10, theme),
       card_style=COALESCE($11, card_style),
       google_maps_url=COALESCE($12, google_maps_url),
       tagline=COALESCE($13, tagline),
       supported_languages=COALESCE($15::text[], supported_languages)
       WHERE id=$14 RETURNING *`,
      [name, brand_color, font_family, wifi_name, wifi_password, instagram_url, facebook_url,
       waiter_enabled !== undefined ? waiter_enabled : null,
       is_published !== undefined ? is_published : null,
       theme || null,
       card_style || null,
       google_maps_url || null,
       tagline !== undefined ? tagline : null,
       req.user.restaurantId,
       supported_languages ? supported_languages : null]
    );
    res.json(result.rows[0]);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// QR kod üret
app.get('/api/restaurant/me/qr', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT slug FROM restaurants WHERE id=$1', [req.user.restaurantId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Restoran bulunamadı' });
    const slug = result.rows[0].slug;
    const url = `${process.env.APP_URL}/${slug}`;
    const qr = await QRCode.toDataURL(url, { width: 400, margin: 2 });
    res.json({ qr, url });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════
// KATEGORİLER
// ═══════════════════════════════

app.get('/api/categories', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT *, COALESCE(translations,\'{}\') as translations FROM categories WHERE restaurant_id=$1 ORDER BY sort_order ASC',
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
  const { name, is_visible, translations } = req.body;
  const result = await pool.query(
    `UPDATE categories SET name=$1, is_visible=$2, translations=COALESCE($3::jsonb,translations) WHERE id=$4 AND restaurant_id=$5 RETURNING *`,
    [name, is_visible, translations ? JSON.stringify(translations) : null, req.params.id, req.user.restaurantId]
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
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids dizisi zorunlu' });
  }
  try {
    await pool.query(
      `UPDATE categories SET sort_order = t.ord
       FROM (SELECT unnest($1::uuid[]) AS id, generate_series(0, $2) AS ord) AS t
       WHERE categories.id = t.id AND categories.restaurant_id = $3`,
      [ids, ids.length - 1, req.user.restaurantId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ürün sıralama
app.patch('/api/products/reorder', authMiddleware, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids dizisi zorunlu' });
  }
  try {
    await pool.query(
      `UPDATE products SET sort_order = t.ord
       FROM (SELECT unnest($1::uuid[]) AS id, generate_series(0, $2) AS ord) AS t
       WHERE products.id = t.id AND products.restaurant_id = $3`,
      [ids, ids.length - 1, req.user.restaurantId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════
// ÜRÜNLER
// ═══════════════════════════════

app.get('/api/products', authMiddleware, async (req, res) => {
  const { categoryId } = req.query;
  let query = 'SELECT *, COALESCE(translations,\'{}\') as translations FROM products WHERE restaurant_id=$1';
  const params = [req.user.restaurantId];
  if (categoryId) { query += ' AND category_id=$2'; params.push(categoryId); }
  query += ' ORDER BY sort_order ASC';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

app.post('/api/products', authMiddleware, async (req, res) => {
  const { category_id, name, description, price, emoji, variants, translations } = req.body;
  const result = await pool.query(
    `INSERT INTO products (category_id, restaurant_id, name, description, price, emoji, variants, translations)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [category_id, req.user.restaurantId, name, description, price, emoji || '🍽️',
     JSON.stringify(variants || []), translations ? JSON.stringify(translations) : '{}']
  );
  res.json(result.rows[0]);
});

app.put('/api/products/:id', authMiddleware, async (req, res) => {
  const { name, description, price, emoji, is_visible, category_id, image_url, translations } = req.body;
  
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
      image_url=$7,
      translations=COALESCE($10::jsonb,translations)
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
      req.user.restaurantId,
      translations ? JSON.stringify(translations) : null
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

// Excel ile fiyat güncelleme
app.post('/api/products/price-update-excel', authMiddleware, uploadExcel.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya seçilmedi' });
  try {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (!rows.length) return res.status(400).json({ error: 'Excel dosyası boş' });

    // Beklenen kolonlar: id veya name + price
    let updated = 0;
    let errors = [];

    for (const row of rows) {
      const price = parseFloat(row['Fiyat'] || row['price'] || row['Price'] || row['fiyat']);
      const name = (row['Ürün Adı'] || row['name'] || row['Name'] || row['urun_adi'] || '').toString().trim();
      const id = (row['ID'] || row['id'] || '').toString().trim();

      if (isNaN(price) || price < 0) {
        errors.push(`Geçersiz fiyat: ${name || id}`);
        continue;
      }

      let result;
      if (id && id.length === 36) {
        // UUID ile güncelle
        result = await pool.query(
          'UPDATE products SET price=$1 WHERE id=$2 AND restaurant_id=$3',
          [price, id, req.user.restaurantId]
        );
      } else if (name) {
        // İsim ile güncelle (büyük/küçük harf duyarsız)
        result = await pool.query(
          'UPDATE products SET price=$1 WHERE LOWER(name)=LOWER($2) AND restaurant_id=$3',
          [price, name, req.user.restaurantId]
        );
      } else {
        errors.push(`Satır atlandı: ID veya Ürün Adı gerekli`);
        continue;
      }

      if (result.rowCount > 0) updated++;
      else errors.push(`Bulunamadı: ${name || id}`);
    }

    res.json({
      success: true,
      updated,
      total: rows.length,
      errors: errors.slice(0, 10)
    });
  } catch(err) {
    res.status(500).json({ error: 'Excel okunamadı: ' + err.message });
  }
});

// Excel şablonu indir
app.get('/api/products/price-template', (req, res, next) => {
  // Query param token desteği — window.open ile header gönderilemiyor
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  next();
}, authMiddleware, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const result = await pool.query(
      'SELECT id, name, price FROM products WHERE restaurant_id=$1 AND is_visible=true ORDER BY sort_order',
      [req.user.restaurantId]
    );
    const data = result.rows.map(p => ({
      'ID': p.id,
      'Ürün Adı': p.name,
      'Fiyat': parseFloat(p.price)
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    // Kolon genişlikleri
    ws['!cols'] = [{ wch: 38 }, { wch: 30 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Fiyatlar');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="fiyat-guncelleme.xlsx"');
    res.send(buffer);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
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
      `SELECT id, slug, name,
              CASE WHEN logo_url IS NOT NULL AND logo_url LIKE 'data:%'
                   THEN '/api/img/logo/' || id
                   ELSE logo_url END as logo_url,
              brand_color, font_family, theme, card_style, google_maps_url,
              wifi_name, wifi_password, instagram_url, facebook_url,
              is_published, waiter_enabled, user_id,
              COALESCE(tagline, '') as tagline,
              COALESCE(supported_languages, ARRAY['tr']) as supported_languages,
              created_at
       FROM restaurants WHERE slug=$1 AND is_published=true`,
      [req.params.slug]
    );
    if (!restResult.rows[0]) return res.status(404).json({ error: 'Menü bulunamadı' });
    const restaurant = restResult.rows[0];

    // Abonelik kontrolü — süresi dolmuşsa menüyü dondur (panele giriş açık kalır)
    const subCheck = await pool.query(
      `SELECT plan, status, trial_ends_at, ends_at FROM subscriptions WHERE user_id=$1`,
      [restaurant.user_id]
    ).catch(() => ({ rows: [] }));
    const sub = subCheck.rows[0];
    if (sub) {
      const expiry = sub.ends_at || sub.trial_ends_at;
      const isExpired = expiry && new Date(expiry) < new Date();
      const isCancelled = sub.status === 'cancelled';
      if (isExpired || isCancelled) {
        return res.json({
          restaurant: { ...restaurant, is_published: false },
          subscription_expired: true,
          subscription_plan: sub.plan,
          subscription_expiry: expiry,
          categories: [],
          products: [],
          hours: [],
          campaign: null
        });
      }
    }

    const catResult = await pool.query(
      'SELECT *, COALESCE(translations,\'{}\') as translations FROM categories WHERE restaurant_id=$1 AND is_visible=true ORDER BY sort_order',
      [restaurant.id]
    );

    // Görselsiz ürünleri hızlıca döndür — görseller ayrı endpoint'ten lazy yüklenir
    const prodResult = await pool.query(
      `SELECT id, category_id, restaurant_id, name, description, price, emoji,
              sort_order, is_visible
       FROM products WHERE restaurant_id=$1 AND is_visible=true ORDER BY sort_order`,
      [restaurant.id]
    );
const hoursResult = await pool.query(
  'SELECT * FROM working_hours WHERE restaurant_id=$1 ORDER BY day_of_week',
  [restaurant.id]
);


    const campResult = await pool.query(
      `SELECT id, title, description, emoji, is_active, starts_at, ends_at,
              link_type, link_product_id, link_category_id, link_url,
              CASE WHEN image_url IS NOT NULL AND image_url LIKE 'data:%'
                   THEN '/api/img/campaign/' || id
                   ELSE image_url END as image_url
       FROM campaigns WHERE restaurant_id=$1 AND is_active=true
       AND starts_at <= NOW() AND ends_at >= NOW() LIMIT 1`,
      [restaurant.id]
    );

    const categories = catResult.rows.map(cat => ({
      ...cat,
      products: prodResult.rows.filter(p => p.category_id === cat.id)
    }));

    // Bugün açık mı hesapla — Türkiye saatiyle (UTC+3)
const nowTR = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
const todayIndex = nowTR.getDay() === 0 ? 6 : nowTR.getDay() - 1;
const todayHours = hoursResult.rows.find(h => h.day_of_week === todayIndex);
const currentTime = `${String(nowTR.getHours()).padStart(2,'0')}:${String(nowTR.getMinutes()).padStart(2,'0')}`;
const isOpen = todayHours && !todayHours.is_closed && currentTime >= todayHours.opens_at && currentTime <= todayHours.closes_at;

res.json({
  restaurant,
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

// Ürün görselleri — ayrı endpoint, lazy yükleme için
app.get('/api/menu/:slug/images', async (req, res) => {
  try {
    const restResult = await pool.query(
      'SELECT id FROM restaurants WHERE slug=$1 AND is_published=true',
      [req.params.slug]
    );
    if (!restResult.rows[0]) return res.status(404).json({ error: 'Bulunamadı' });
    const result = await pool.query(
      "SELECT id FROM products WHERE restaurant_id=$1 AND is_visible=true AND image_url IS NOT NULL AND image_url != ''",
      [restResult.rows[0].id]
    );
    // base64 yerine URL döndür — tarayıcı cache'ler
    const rows = result.rows.map(p => ({
      id: p.id,
      image_url: '/api/img/product/' + p.id
    }));
    res.json(rows);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════
// FEEDBACK
// ═══════════════════════════════

// Menü ziyareti kaydet
app.post('/api/menu/:slug/view', async (req, res) => {
  try {
    const restResult = await pool.query('SELECT id FROM restaurants WHERE slug=$1', [req.params.slug]);
    if (!restResult.rows[0]) return res.status(404).json({ error: 'Restoran bulunamadı' });
    const restaurantId = restResult.rows[0].id;
    const ua = req.headers['user-agent'] || '';
    const device = /mobile|android|iphone|ipad/i.test(ua) ? 'mobile' : 'desktop';
    await pool.query(
      'INSERT INTO menu_views (restaurant_id, device) VALUES ($1, $2)',
      [restaurantId, device]
    );
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Analiz verileri
app.get('/api/analytics', authMiddleware, async (req, res) => {
  try {
    const rId = req.user.restaurantId;
    const { period = '30' } = req.query;
    const days = parseInt(period) || 30;

    // days integer olarak doğrulandı, direkt SQL'e gömülebilir
    const interval = days + " days";
    const [total, byDevice, byDay, today, thisWeek] = await Promise.all([
      pool.query(
        "SELECT COUNT(*) FROM menu_views WHERE restaurant_id=$1 AND viewed_at > NOW() - $2::interval",
        [rId, interval]
      ),
      pool.query(
        "SELECT device, COUNT(*) FROM menu_views WHERE restaurant_id=$1 AND viewed_at > NOW() - $2::interval GROUP BY device",
        [rId, interval]
      ),
      pool.query(
        "SELECT DATE(viewed_at) as date, COUNT(*) as count FROM menu_views WHERE restaurant_id=$1 AND viewed_at > NOW() - $2::interval GROUP BY DATE(viewed_at) ORDER BY date ASC",
        [rId, interval]
      ),
      pool.query(
        "SELECT COUNT(*) FROM menu_views WHERE restaurant_id=$1 AND DATE(viewed_at)=CURRENT_DATE",
        [rId]
      ),
      pool.query(
        "SELECT COUNT(*) FROM menu_views WHERE restaurant_id=$1 AND viewed_at > NOW() - INTERVAL '7 days'",
        [rId]
      ),
    ]);

    res.json({
      total: parseInt(total.rows[0].count),
      today: parseInt(today.rows[0].count),
      thisWeek: parseInt(thisWeek.rows[0].count),
      byDevice: byDevice.rows,
      byDay: byDay.rows,
      period: days,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/feedback', async (req, res) => {
  const { restaurant_id, type, message, rating } = req.body;
  if (!restaurant_id || !message) {
    return res.status(400).json({ error: 'restaurant_id ve message zorunlu' });
  }
  try {
    const restCheck = await pool.query(
      'SELECT id FROM restaurants WHERE id=$1 AND is_published=true',
      [restaurant_id]
    );
    if (!restCheck.rows[0]) return res.status(404).json({ error: 'Restoran bulunamadı' });

    const result = await pool.query(
      'INSERT INTO feedbacks (restaurant_id, type, message, rating) VALUES ($1,$2,$3,$4) RETURNING *',
      [restaurant_id, type || 'suggestion', message, rating || 5]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const { restaurant_id, table_no, note } = req.body;
  try {
    const restCheck = await pool.query('SELECT waiter_enabled FROM restaurants WHERE id=$1', [restaurant_id]);
    if (restCheck.rows[0] && restCheck.rows[0].waiter_enabled === false) {
      return res.status(403).json({ error: 'Garson çağrı sistemi şu an aktif değil' });
    }
    const result = await pool.query(
      'INSERT INTO waiter_calls (restaurant_id, table_no, note) VALUES ($1,$2,$3) RETURNING *',
      [restaurant_id, table_no || 'Belirsiz', note || null]
    );
    notifyRestaurant(restaurant_id, { type: 'waiter_call', data: result.rows[0] });
    res.json(result.rows[0]);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
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
  const { title, description, emoji, image_url } = req.body;
  const result = await pool.query(
    'INSERT INTO campaigns (restaurant_id, title, description, emoji, image_url) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.user.restaurantId, title, description, emoji || '🎉', image_url || null]
  );
  res.json(result.rows[0]);
});

app.patch('/api/campaigns/:id', authMiddleware, async (req, res) => {
  const { title, description, emoji, image_url, link_type, link_product_id, link_category_id, link_url } = req.body;
  try {
    const result = await pool.query(
      `UPDATE campaigns SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        emoji = COALESCE($3, emoji),
        image_url = COALESCE($4, image_url),
        link_type = COALESCE($5, link_type),
        link_product_id = COALESCE($6, link_product_id),
        link_category_id = COALESCE($7, link_category_id),
        link_url = COALESCE($8, link_url)
       WHERE id=$9 AND restaurant_id=$10 RETURNING *`,
      [title || null, description || null, emoji || null, image_url || null,
       link_type || null, link_product_id || null, link_category_id || null, link_url || null,
       req.params.id, req.user.restaurantId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Kampanya bulunamadı' });
    res.json(result.rows[0]);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
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
  try {
    const result = await pool.query(
      'SELECT * FROM subscriptions WHERE user_id=$1',
      [req.user.userId]
    );
    const sub = result.rows[0];
    if (!sub) return res.status(404).json({ error: 'Abonelik bulunamadı' });

    // Sona erme tarihi hesapla
    const now = new Date();
    let expiresAt = sub.ends_at || sub.trial_ends_at;
    let daysLeft = null;
    if (expiresAt) {
      daysLeft = Math.ceil((new Date(expiresAt) - now) / (1000 * 60 * 60 * 24));
    }

    // Süresi dolmuşsa status güncelle
    if (daysLeft !== null && daysLeft < 0 && sub.status === 'active') {
      await pool.query("UPDATE subscriptions SET status='expired' WHERE user_id=$1", [req.user.userId]);
      sub.status = 'expired';
    }

    res.json({ ...sub, days_left: daysLeft, expires_at: expiresAt });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Bildirimleri getir
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM system_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20",
      [req.user.userId]
    );
    res.json(result.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Bildirimi okundu işaretle
app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await pool.query("UPDATE system_notifications SET is_read=true WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.userId]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await pool.query("UPDATE system_notifications SET is_read=true WHERE user_id=$1", [req.user.userId]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
// ═══════════════════════════════
// ŞİFRE SIFIRLAMA
// ═══════════════════════════════

// Email doğrulama
app.get('/api/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect(`${process.env.APP_URL}/?error=no_token`);
  try {
    const result = await pool.query(
      'SELECT * FROM email_verifications WHERE token=$1',
      [token]
    );
    if (!result.rows[0]) {
      return res.redirect(`${process.env.APP_URL}/?error=invalid_token`);
    }
    if (new Date(result.rows[0].expires_at) < new Date()) {
      return res.redirect(`${process.env.APP_URL}/?error=expired_token`);
    }
    await pool.query('UPDATE users SET is_verified=true WHERE id=$1', [result.rows[0].user_id]);
    await pool.query('DELETE FROM email_verifications WHERE token=$1', [token]);
    res.redirect(`${process.env.APP_URL}/?verified=1`);
  } catch(err) {
    console.error('Verify email error:', err.message);
    res.redirect(`${process.env.APP_URL}/?error=server_error`);
  }
});
  

app.post('/api/auth/forgot-password', passwordLimiter, async (req, res) => {
  const { email } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!result.rows[0]) return res.json({ success: true }); // Güvenlik için her zaman success dön

    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 3600000); // 1 saat
    await pool.query(
      'DELETE FROM password_resets WHERE email=$1',
      [email]
    );
    await pool.query(
      'INSERT INTO password_resets (email, token, expires_at) VALUES ($1,$2,$3)',
      [email, token, expiresAt]
    );

    const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}`;

    await resend.emails.send({
      from: 'CafeMenu <noreply@cafemenu.com.tr>',
      to: email,
      subject: 'Şifre Sıfırlama — CafeMenu',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff">
          <div style="text-align:center;margin-bottom:28px">
            <img src="https://app.cafemenu.com.tr/icons/cafemenu-logo.png" alt="CafeMenu" style="height:56px;object-fit:contain">
          </div>
          <h2 style="color:#111;margin-bottom:8px">Şifrenizi sıfırlayın</h2>
          <p style="color:#666;margin-bottom:24px">Aşağıdaki butona tıklayarak şifrenizi sıfırlayabilirsiniz. Bu link 1 saat geçerlidir.</p>
          <div style="text-align:center;margin-bottom:24px">
            <a href="${resetUrl}" style="background:#e8c547;color:#111;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Şifremi Sıfırla</a>
          </div>
          <p style="color:#999;font-size:12px;margin-top:24px">Bu emaili siz talep etmediyseniz görmezden gelebilirsiniz.</p>
          <div style="border-top:1px solid #eee;margin-top:28px;padding-top:16px;text-align:center;font-size:12px;color:#aaa">
            CafeMenu · cafemenu.com.tr
          </div>
        </div>
      `
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Email hatası:', err);
    res.status(500).json({ error: 'Email gönderilemedi: ' + err.message });
  }
});

app.post('/api/auth/reset-password', passwordLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token ve password zorunlu' });
  try {
    const result = await pool.query(
      'SELECT * FROM password_resets WHERE token=$1',
      [token]
    );
    const record = result.rows[0];
    if (!record || new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Link geçersiz veya süresi dolmuş' });
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE email=$2', [hash, record.email]);
    await pool.query('DELETE FROM password_resets WHERE token=$1', [token]);
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
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.role, u.created_at,
             r.name as restaurant_name, r.slug,
             s.plan, s.status, s.trial_ends_at, s.starts_at, s.ends_at
      FROM users u
      LEFT JOIN restaurants r ON r.user_id = u.id
      LEFT JOIN subscriptions s ON s.user_id = u.id
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Kullanıcı sil
app.delete('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const userId = req.params.id;
    // Önce ilişkili verileri sil
    await pool.query('DELETE FROM email_verifications WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM subscriptions WHERE user_id=$1', [userId]);
    // Restoran ve bağlı verileri sil (CASCADE ile otomatik silinmeli ama garantiyelim)
    const restResult = await pool.query('SELECT id FROM restaurants WHERE user_id=$1', [userId]);
    if (restResult.rows[0]) {
      const restId = restResult.rows[0].id;
      await pool.query('DELETE FROM working_hours WHERE restaurant_id=$1', [restId]);
      await pool.query('DELETE FROM campaigns WHERE restaurant_id=$1', [restId]);
      await pool.query('DELETE FROM feedbacks WHERE restaurant_id=$1', [restId]);
      await pool.query('DELETE FROM waiter_calls WHERE restaurant_id=$1', [restId]);
      await pool.query('DELETE FROM products WHERE restaurant_id=$1', [restId]);
      await pool.query('DELETE FROM categories WHERE restaurant_id=$1', [restId]);
      await pool.query('DELETE FROM restaurants WHERE id=$1', [restId]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Abonelik güncelle
app.put('/api/admin/subscription/:userId', adminMiddleware, async (req, res) => {
  const { plan, status, starts_at, ends_at, payment_method, payment_note } = req.body;
  try {
    await pool.query(
      `UPDATE subscriptions SET
        plan=$1, status=$2,
        starts_at=COALESCE($3::timestamp, starts_at),
        ends_at=COALESCE($4::timestamp, ends_at),
        payment_method=COALESCE($5, payment_method),
        payment_note=COALESCE($6, payment_note)
       WHERE user_id=$7`,
      [plan, status,
       starts_at || null, ends_at || null,
       payment_method || null, payment_note || null,
       req.params.userId]
    );

    // Panelde bildirim oluştur
    const userResult = await pool.query('SELECT id FROM users WHERE id=$1', [req.params.userId]);
    if (userResult.rows[0]) {
      const planNames = { starter:'Starter', pro:'Pro', enterprise:'Enterprise', trial:'Trial' };
      const planName = planNames[plan] || plan;
      const endDate = ends_at ? new Date(ends_at).toLocaleDateString('tr-TR') : '-';
      await pool.query(
        "INSERT INTO system_notifications (user_id, title, message) VALUES ($1,$2,$3)",
        [req.params.userId,
         `Aboneliğiniz güncellendi — ${planName}`,
         `${planName} planı aktif edildi. Bitiş tarihi: ${endDate}. Ödeme: ${payment_method || 'belirtilmedi'}`]
      );
    }

    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Platform istatistikleri
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  try {
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
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin → kullanıcı adına geçici token üret (impersonate)
app.post('/api/admin/impersonate/:userId', adminMiddleware, async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    const userResult = await pool.query(
      `SELECT u.id, u.email, u.role, r.id as restaurant_id, r.name as restaurant_name, r.slug
       FROM users u
       LEFT JOIN restaurants r ON r.user_id = u.id
       WHERE u.id = $1`,
      [targetUserId]
    );
    const target = userResult.rows[0];
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    if (target.role === 'admin') return res.status(403).json({ error: 'Admin hesabına impersonate yapılamaz' });

    // Kısa süreli (2 saat) impersonate token — içinde impersonatedBy işareti var
    const impToken = jwt.sign(
      {
        userId: target.id,
        restaurantId: target.restaurant_id,
        role: target.role || 'owner',
        impersonatedBy: req.user.userId,  // hangi admin yaptığını sakla
        impersonatedAt: new Date().toISOString()
      },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    // Audit log
    console.log(`🔐 IMPERSONATE: Admin ${req.user.userId} → User ${target.id} (${target.email}) at ${new Date().toISOString()}`);
    await pool.query(
      `INSERT INTO system_notifications (user_id, title, message) VALUES ($1, $2, $3)`,
      [target.id,
       '🔐 Destek Erişimi',
       `CafeMenu destek ekibi hesabınıza ${new Date().toLocaleString('tr-TR')} tarihinde erişim sağladı.`]
    ).catch(() => {});

    res.json({
      token: impToken,
      user: { id: target.id, email: target.email, restaurant_name: target.restaurant_name, slug: target.slug }
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin oluştur (sadece development ortamında aktif)
app.post('/api/admin/create', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
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
// RESİM SERVİNG — Cache'li URL endpoint'leri
// ═══════════════════════════════

// Ürün resmi — tarayıcı cache'ler (1 gün)
app.get('/api/img/product/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT image_url FROM products WHERE id=$1',
      [req.params.id]
    );
    const row = result.rows[0];
    if (!row || !row.image_url) return res.status(404).send('');

    const dataUrl = row.image_url;
    if (!dataUrl.startsWith('data:')) return res.status(404).send('');

    const [header, base64] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/webp';
    const buffer = Buffer.from(base64, 'base64');

    res.set({
      'Content-Type': mimeType,
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=86400', // 1 gün cache
      'ETag': `"${req.params.id}"`,
    });

    // ETag ile 304 Not Modified desteği
    if (req.headers['if-none-match'] === `"${req.params.id}"`) {
      return res.status(304).end();
    }

    res.send(buffer);
  } catch(err) {
    res.status(500).send('');
  }
});

// Restoran logosu
app.get('/api/img/logo/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT logo_url FROM restaurants WHERE id=$1',
      [req.params.id]
    );
    const row = result.rows[0];
    if (!row || !row.logo_url) return res.status(404).send('');

    const dataUrl = row.logo_url;
    if (!dataUrl.startsWith('data:')) {
      return res.redirect(dataUrl); // harici URL ise redirect
    }

    const [header, base64] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/webp';
    const buffer = Buffer.from(base64, 'base64');

    res.set({
      'Content-Type': mimeType,
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=86400',
      'ETag': `"logo-${req.params.id}"`,
    });

    if (req.headers['if-none-match'] === `"logo-${req.params.id}"`) {
      return res.status(304).end();
    }

    res.send(buffer);
  } catch(err) {
    res.status(500).send('');
  }
});

// Kampanya resmi
app.get('/api/img/campaign/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT image_url FROM campaigns WHERE id=$1',
      [req.params.id]
    );
    const row = result.rows[0];
    if (!row || !row.image_url) return res.status(404).send('');

    const dataUrl = row.image_url;
    if (!dataUrl.startsWith('data:')) return res.redirect(dataUrl);

    const [header, base64] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/webp';
    const buffer = Buffer.from(base64, 'base64');

    res.set({
      'Content-Type': mimeType,
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=86400',
      'ETag': `"camp-${req.params.id}"`,
    });

    if (req.headers['if-none-match'] === `"camp-${req.params.id}"`) {
      return res.status(304).end();
    }

    res.send(buffer);
  } catch(err) {
    res.status(500).send('');
  }
});

// ═══════════════════════════════
// İYZİCO ÖDEME
// ═══════════════════════════════

// iyzico ödeme başlat
app.post('/api/payment/init', authMiddleware, async (req, res) => {
  const { plan } = req.body;
  if (!process.env.IYZICO_API_KEY) {
    return res.status(503).json({ error: 'İyzico henüz yapılandırılmadı' });
  }

  // KDV dahil fiyatlar (TRY) — KDV oranı %20
  // starter: 9360 TL (KDV hariç: 7800 TL), pro: 11995 TL (KDV hariç: 9996 TL)
  const pricesWithKdv  = { starter: 9360.00, pro: 11995.00, enterprise: 11995.00 };
  const pricesWithoutKdv = { starter: 7800.00, pro: 9996.00, enterprise: 9996.00 }; // KDV hariç (÷1.20)
  const prices = pricesWithKdv; // ödeme tutarı KDV dahil
  const price = prices[plan];
  if (!price) return res.status(400).json({ error: 'Geçersiz plan' });

  try {
    const iyzipay = getIyzipay();
    const userResult = await pool.query(
      `SELECT u.email,
              COALESCE(u.first_name,'') as first_name,
              COALESCE(u.last_name,'')  as last_name,
              COALESCE(u.phone,'')      as phone,
              COALESCE(u.tax_number,'') as tax_number,
              COALESCE(u.tax_office,'') as tax_office,
              COALESCE(u.billing_address,'') as billing_address,
              COALESCE(u.city,'')       as city,
              r.name as restaurant_name
       FROM users u
       LEFT JOIN restaurants r ON r.user_id = u.id
       WHERE u.id = $1`,
      [req.user.userId]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı, lütfen tekrar giriş yapın' });

    const {
      name = '', surname = '', gsm = '',
      tc = '', taxNumber = '', taxOffice = '', billingAddress = '', city = ''
    } = req.body;

    // Form'dan gelen bilgiler öncelikli, eksikler DB'den tamamlanır
    const firstName    = (name    || user.first_name  || user.restaurant_name?.split(' ')[0] || 'Musteri').trim();
    const lastName     = (surname || user.last_name   || user.restaurant_name?.split(' ').slice(1).join(' ') || 'CafeMenu').trim() || 'CafeMenu';
    const gsmRaw       = (gsm     || user.phone       || '05000000000').replace(/\s/g,'');
    const gsmFormatted = gsmRaw.startsWith('+') ? gsmRaw : '+90' + gsmRaw.replace(/^0/, '');
    // TC: iyzico için 11 hane zorunlu — boşsa dummy kullan (sandbox'ta geçerli)
    const identityNo   = (tc || '').replace(/\s/g,'').length === 11 ? tc.replace(/\s/g,'') : '11111111111';
    const buyerCity    = (city || user.city || 'Istanbul').trim() || 'Istanbul';
    const buyerAddress = (billingAddress || user.billing_address || 'Turkiye').trim() || 'Turkiye';

    console.log('💳 Ödeme başlatılıyor:', { userId: req.user.userId, plan, firstName, lastName, gsm: gsmFormatted, city: buyerCity });

    const convId = `sub_${req.user.userId}_${Date.now()}`;

    const priceKdvDahil    = pricesWithKdv[plan];      // toplam ödenen tutar (KDV dahil)
    const priceKdvHaric    = pricesWithoutKdv[plan];   // sepet kalemi tutarı (KDV hariç, iyzico kuralı)

    const request = {
      locale: 'tr',
      conversationId: convId,
      price: priceKdvHaric.toFixed(2),        // sepet kalemleri toplamı (KDV hariç)
      paidPrice: priceKdvDahil.toFixed(2),    // müşterinin ödediği tutar (KDV dahil)
      currency: 'TRY',
      basketId: `plan_${plan}_${req.user.userId}`,
      paymentGroup: 'PRODUCT',
      callbackUrl: `${process.env.APP_URL}/api/payment/callback`,
      enabledInstallments: [1, 2, 3, 6, 9, 12],
      buyer: {
        id: req.user.userId,
        name: firstName,
        surname: lastName,
        gsmNumber: gsmFormatted,
        email: user.email,
        identityNumber: identityNo,
        registrationAddress: buyerAddress,
        ip: (req.headers['x-forwarded-for'] || req.ip || '127.0.0.1').split(',')[0].trim(),
        city: buyerCity,
        country: 'Turkey',
      },
      shippingAddress: {
        contactName: `${firstName} ${lastName}`,
        city: buyerCity, country: 'Turkey', address: buyerAddress
      },
      billingAddress: {
        contactName: `${firstName} ${lastName}`,
        city: buyerCity, country: 'Turkey', address: buyerAddress
      },
      basketItems: [{
        id: `plan_${plan}`,
        name: `CafeMenu ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan (1 Yil)`,
        category1: 'Yazilim',
        itemType: 'VIRTUAL',
        price: priceKdvHaric.toFixed(2)  // iyzico: sepet kalemi KDV hariç olmalı
      }]
    };

    iyzipay.checkoutFormInitialize.create(request, (err, result) => {
      if (err) return res.status(500).json({ error: err.message || 'İyzico bağlantı hatası' });
      if (result.status !== 'success') {
        console.error('iyzico hata detayı:', JSON.stringify(result, null, 2));
        const msg = result.errorMessage || result.errorCode
          ? `${result.errorMessage || 'Ödeme başlatılamadı'} (Kod: ${result.errorCode || '-'})`
          : 'İyzico ödeme başlatılamadı';
        return res.status(500).json({ error: msg });
      }
      res.json({ checkoutFormContent: result.checkoutFormContent, token: result.token });
    });
  } catch(err) {
    console.error('iyzico init error:', err);
    res.status(500).json({ error: err.message });
  }
});

// iyzico ödeme callback
app.post('/api/payment/callback', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).send('Token eksik');

  // Geçerli plan listesi — dışarıdan gelecek değeri whitelist ile doğrula
  const VALID_PLANS = ['starter', 'pro', 'enterprise'];

  try {
    const iyzipay = getIyzipay();
    iyzipay.checkoutForm.retrieve({ locale: 'tr', token }, async (err, result) => {
      try {
        // 1. İyzico'nun kendi doğrulaması
        if (err || result.status !== 'success' || result.paymentStatus !== 'SUCCESS') {
          console.error('İyzico ödeme başarısız:', err || result);
          return res.redirect(`${process.env.APP_URL}/?payment=failed`);
        }

        // 2. conversationId formatını doğrula: "sub_<uuid>_<timestamp>"
        const convParts = result.conversationId?.split('_');
        if (!convParts || convParts.length < 3 || convParts[0] !== 'sub') {
          console.error('Geçersiz conversationId formatı:', result.conversationId);
          return res.redirect(`${process.env.APP_URL}/?payment=failed`);
        }
        const userId = convParts[1];

        // 3. Plan değerini whitelist ile doğrula
        const planRaw = result.basketId?.split('_')[1];
        if (!VALID_PLANS.includes(planRaw)) {
          console.error('Geçersiz plan değeri:', planRaw);
          return res.redirect(`${process.env.APP_URL}/?payment=failed`);
        }
        const plan = planRaw;

        // 4. userId'nin DB'de gerçekten var olduğunu doğrula
        const userCheck = await pool.query(
          'SELECT id FROM users WHERE id=$1',
          [userId]
        );
        if (!userCheck.rows[0]) {
          console.error('Callback: kullanıcı bulunamadı:', userId);
          return res.redirect(`${process.env.APP_URL}/?payment=failed`);
        }

        // 5. paymentId daha önce işlenmiş mi? (tekrar saldırı önlemi)
        const dupCheck = await pool.query(
          'SELECT id FROM subscriptions WHERE iyzico_subscription_id=$1',
          [result.paymentId]
        );
        if (dupCheck.rows[0]) {
          console.warn('Tekrar eden paymentId, işlem atlandı:', result.paymentId);
          return res.redirect(`${process.env.APP_URL}/?payment=success`);
        }

        // 6. Aboneliği güncelle
        const startsAt = new Date();
        const endsAt = new Date();
        endsAt.setFullYear(endsAt.getFullYear() + 1);

        await pool.query(
          `UPDATE subscriptions SET plan=$1, status='active',
           starts_at=$2, ends_at=$3,
           payment_method='iyzico',
           iyzico_subscription_id=$4
           WHERE user_id=$5`,
          [plan, startsAt, endsAt, result.paymentId, userId]
        );

        await pool.query(
          'INSERT INTO system_notifications (user_id, title, message) VALUES ($1,$2,$3)',
          [userId,
           '✅ Ödeme başarılı — Abonelik aktif!',
           `${plan} planınız aktif edildi. Bitiş tarihi: ${endsAt.toLocaleDateString('tr-TR')}`]
        );

        console.log(`✅ Ödeme işlendi: userId=${userId} plan=${plan} paymentId=${result.paymentId}`);
        res.redirect(`${process.env.APP_URL}/?payment=success`);

      } catch(innerErr) {
        console.error('Callback işleme hatası:', innerErr.message);
        res.redirect(`${process.env.APP_URL}/?payment=failed`);
      }
    });
  } catch(err) {
    console.error('İyzico callback başlatma hatası:', err.message);
    res.redirect(`${process.env.APP_URL}/?payment=failed`);
  }
});

// ═══════════════════════════════
// PDF MENÜ
// ═══════════════════════════════
const PDFDocument = require('pdfkit');
function turkishToAscii(str) {
  if (!str) return '';
  return str
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
    .replace(/ü/g, 'u').replace(/Ü/g, 'U')
    .replace(/ş/g, 's').replace(/Ş/g, 'S')
    .replace(/ı/g, 'i').replace(/İ/g, 'I')
    .replace(/ö/g, 'o').replace(/Ö/g, 'O')
    .replace(/ç/g, 'c').replace(/Ç/g, 'C');
}

app.get('/api/restaurant/me/pdf', authMiddleware, async (req, res) => {
  try {
    const restResult = await pool.query('SELECT * FROM restaurants WHERE id=$1', [req.user.restaurantId]);
    const restaurant = restResult.rows[0];
    const catResult = await pool.query(
      'SELECT *, COALESCE(translations,\'{}\') as translations FROM categories WHERE restaurant_id=$1 AND is_visible=true ORDER BY sort_order',
      [req.user.restaurantId]
    );
    const prodResult = await pool.query(
      'SELECT *, COALESCE(translations,\'{}\') as translations FROM products WHERE restaurant_id=$1 AND is_visible=true ORDER BY sort_order',
      [req.user.restaurantId]
    );

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${restaurant.slug}-menu.pdf"`);
    doc.pipe(res);

    // Başlık
    doc.fontSize(28).font('Helvetica-Bold').text(turkishToAscii(restaurant.name), { align: 'center' });
    doc.fontSize(12).font('Helvetica').fillColor('#888').text('Dijital Menu', { align: 'center' });
    doc.moveDown(1);

    // WiFi bilgisi
    if (restaurant.wifi_name) {
      doc.fontSize(10).fillColor('#555')
        .text(`WiFi: ${turkishToAscii(restaurant.wifi_name)}  |  Sifre: ${turkishToAscii(restaurant.wifi_password || '')}`, { align: 'center' });
      doc.moveDown(0.5);
    }

    // Çizgi
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#e0e0e0');
    doc.moveDown(1);

    // Kategoriler ve ürünler
    for (const cat of catResult.rows) {
      const products = prodResult.rows.filter(p => p.category_id === cat.id);
      if (!products.length) continue;

      // Kategori başlığı
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#111').text(turkishToAscii(cat.name));
      doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).stroke('#e8c547');
      doc.moveDown(0.8);

      // Ürünler
      for (const prod of products) {
        const yStart = doc.y;

        // Ürün adı ve fiyat
        doc.fontSize(13).font('Helvetica-Bold').fillColor('#111').text(turkishToAscii(prod.name), 50, yStart, { continued: true, width: 380 });
        doc.fontSize(13).font('Helvetica-Bold').fillColor('#c0a020').text(`${parseFloat(prod.price).toFixed(2)} TL`, { align: 'right' });

        // Açıklama
        if (prod.description) {
          doc.fontSize(10).font('Helvetica').fillColor('#666').text(turkishToAscii(prod.description), 50, doc.y, { width: 450 });
        }

        doc.moveDown(0.6);

        // Sayfa kontrolü
        if (doc.y > 750) {
          doc.addPage();
        }
      }
      doc.moveDown(0.5);
    }

    // Footer
    doc.fontSize(9).fillColor('#aaa').text(`CafeMenu · cafemenu.com.tr · ${new Date().toLocaleDateString('tr-TR')}`, { align: 'center' });

    doc.end();
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════
// EXCEL IMPORT
// ═══════════════════════════════
const XLSX = require('xlsx');

app.post('/api/products/import', authMiddleware, uploadExcel.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya seçilmedi' });
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (!rows.length) return res.status(400).json({ error: 'Excel dosyası boş' });

    let imported = 0;
    let errors = [];

    for (const row of rows) {
      try {
        // Kolon adlarını esnek oku
        const catName = row['Kategori'] || row['kategori'] || row['Category'] || 'Genel';
        const name = row['Ürün Adı'] || row['urun_adi'] || row['Name'] || row['name'] || '';
        const description = row['Açıklama'] || row['aciklama'] || row['Description'] || '';
        const price = parseFloat(row['Fiyat'] || row['fiyat'] || row['Price'] || 0);
        const emoji = row['Emoji'] || row['emoji'] || '🍽️';

        if (!name) continue;

        // Kategoriyi bul veya oluştur
        let catResult = await pool.query(
          'SELECT id FROM categories WHERE restaurant_id=$1 AND LOWER(name)=LOWER($2)',
          [req.user.restaurantId, catName]
        );

        let categoryId;
        if (catResult.rows.length) {
          categoryId = catResult.rows[0].id;
        } else {
          const newCat = await pool.query(
            'INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1,$2,(SELECT COUNT(*) FROM categories WHERE restaurant_id=$1)) RETURNING id',
            [req.user.restaurantId, catName]
          );
          categoryId = newCat.rows[0].id;
        }

        // Ürünü ekle
        await pool.query(
          'INSERT INTO products (category_id, restaurant_id, name, description, price, emoji) VALUES ($1,$2,$3,$4,$5,$6)',
          [categoryId, req.user.restaurantId, name, description, price, emoji]
        );
        imported++;
      } catch(e) {
        errors.push(`Satır hatası: ${e.message}`);
      }
    }

    res.json({
      success: true,
      imported,
      errors: errors.slice(0, 5),
      message: `${imported} ürün başarıyla içe aktarıldı`
    });
  } catch(err) {
    res.status(500).json({ error: 'Excel okuma hatası: ' + err.message });
  }
});

// Excel şablon indir
app.get('/api/products/import/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const data = [
    ['Kategori', 'Ürün Adı', 'Açıklama', 'Fiyat', 'Emoji'],
    ['Kahvaltı', 'Serpme Kahvaltı', '2 kişilik zengin kahvaltı', 320, '🍳'],
    ['Kahvaltı', 'Menemen', 'Domates ve biberli yumurta', 120, '🥚'],
    ['İçecekler', 'Türk Kahvesi', 'Geleneksel Türk kahvesi', 45, '☕'],
    ['İçecekler', 'Çay', 'Demlik çay', 20, '🍵'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 15 }, { wch: 25 }, { wch: 35 }, { wch: 10 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Menü');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="menu-sablonu.xlsx"');
  res.send(buffer);
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
    const { buffer, mimeType } = await resizeImage(req.file.buffer, req.file.mimetype, {
      width: 600, height: 600, quality: 72
    });
    const imageUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    res.json({ imageUrl });
  } catch (err) {
    res.status(500).json({ error: 'Yükleme hatası: ' + err.message });
  }
});

app.post('/api/upload/logo', authMiddleware, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya seçilmedi' });
  try {
    const { buffer, mimeType } = await resizeImage(req.file.buffer, req.file.mimetype, {
      width: 200, height: 200, quality: 80
    });
    const logoUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    await pool.query('UPDATE restaurants SET logo_url=$1 WHERE id=$2', [logoUrl, req.user.restaurantId]);
    res.json({ logoUrl });
  } catch (err) {
    res.status(500).json({ error: 'Yükleme hatası: ' + err.message });
  }
});
app.post('/api/upload/campaign-image', authMiddleware, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya seçilmedi' });
  try {
    const { buffer, mimeType } = await resizeImage(req.file.buffer, req.file.mimetype, {
      width: 800, height: 500, quality: 75
    });
    const imageUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    res.json({ imageUrl });
  } catch (err) {
    res.status(500).json({ error: 'Yükleme hatası: ' + err.message });
  }
});

// ═══════════════════════════════
// ABONELİK BİLDİRİM SİSTEMİ — Her gün saat 09:00'da
// ═══════════════════════════════
async function checkSubscriptionExpiry() {
  try {
    console.log('🔔 Abonelik kontrol başladı...');

    // 7, 3, 1 gün kalan ve son gün abonelikleri bul
    const result = await pool.query(`
      SELECT s.*, u.email, r.name as restaurant_name
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN restaurants r ON r.user_id = s.user_id
      WHERE s.status = 'active'
        AND s.ends_at IS NOT NULL
        AND s.ends_at > NOW()
        AND DATE(s.ends_at) IN (
          CURRENT_DATE + INTERVAL '7 days',
          CURRENT_DATE + INTERVAL '3 days',
          CURRENT_DATE + INTERVAL '1 day',
          CURRENT_DATE
        )
    `);

    for (const sub of result.rows) {
      const daysLeft = Math.ceil((new Date(sub.ends_at) - new Date()) / (1000 * 60 * 60 * 24));
      const notifKey = `expiry_${daysLeft}d_${sub.id}`;

      // Aynı gün için daha önce bildirim gönderildi mi?
      const alreadySent = await pool.query(
        "SELECT id FROM subscription_notifications WHERE user_id=$1 AND type=$2 AND DATE(sent_at)=CURRENT_DATE",
        [sub.user_id, notifKey]
      );
      if (alreadySent.rows.length) continue;

      const title = daysLeft <= 0
        ? '⚠️ Aboneliğiniz bugün sona eriyor!'
        : `⏰ Aboneliğiniz ${daysLeft} gün içinde sona eriyor`;

      const message = daysLeft <= 0
        ? `${sub.restaurant_name || 'Restoranınız'} için aboneliğiniz bugün sona eriyor. Hizmet kesintisi yaşamamak için yenileyin.`
        : `${sub.restaurant_name || 'Restoranınız'} için aboneliğiniz ${new Date(sub.ends_at).toLocaleDateString('tr-TR')} tarihinde sona erecek.`;

      // Panel bildirimi
      await pool.query(
        "INSERT INTO system_notifications (user_id, title, message) VALUES ($1,$2,$3)",
        [sub.user_id, title, message]
      );

      // Email bildirimi
      try {
        await resend.emails.send({
          from: 'CafeMenu <bildirim@cafemenu.com.tr>',
          to: sub.email,
          subject: title,
          html: `
            <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px">
              <img src="https://app.cafemenu.com.tr/icons/cafemenu-logo.png"
                   alt="CafeMenu" style="height:40px;margin-bottom:24px">
              <h2 style="color:#111">${title}</h2>
              <p style="color:#555;line-height:1.6">${message}</p>
              ${daysLeft > 0 ? `
              <p style="color:#555">Aboneliğinizi yenilemek için panele giriş yapın.</p>
              <a href="${process.env.APP_URL}" style="display:inline-block;background:#e8c547;color:#111;
                 padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:16px">
                Panele Git →
              </a>` : `
              <p style="color:#e84747;font-weight:600">Aboneliğiniz sona erdiğinde menünüz yayından kalkacaktır.</p>
              <a href="${process.env.APP_URL}" style="display:inline-block;background:#e84747;color:#fff;
                 padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:16px">
                Hemen Yenile →
              </a>`}
              <hr style="margin:32px 0;border:none;border-top:1px solid #eee">
              <p style="color:#999;font-size:12px">CafeMenu · cafemenu.com.tr</p>
            </div>
          `
        });
      } catch(emailErr) {
        console.error('Bildirim emaili gönderilemedi:', emailErr.message);
      }

      // Bildirim kaydı
      await pool.query(
        "INSERT INTO subscription_notifications (user_id, type, days_remaining) VALUES ($1,$2,$3)",
        [sub.user_id, notifKey, daysLeft]
      );

      console.log(`📧 Bildirim gönderildi: ${sub.email} (${daysLeft} gün kaldı)`);
    }

    // Süresi dolmuş abonelikleri expired yap
    await pool.query(`
      UPDATE subscriptions SET status='expired'
      WHERE status='active' AND ends_at IS NOT NULL AND ends_at < NOW()
    `);
    await pool.query(`
      UPDATE subscriptions SET status='expired'
      WHERE status='active' AND ends_at IS NULL AND trial_ends_at < NOW()
    `);

  } catch(err) {
    console.error('Abonelik kontrol hatası:', err.message);
  }
}

// ═══════════════════════════════
// OTOMATİK YEDEKLEME — Her gün saat 03:00'da
// ═══════════════════════════════
function scheduleSubscriptionCheck() {
  const now = new Date();
  // Sabah 09:00'a kaç ms kaldı?
  const next9am = new Date();
  next9am.setHours(9, 0, 0, 0);
  if (next9am <= now) next9am.setDate(next9am.getDate() + 1);
  const msUntil9am = next9am - now;

  setTimeout(() => {
    checkSubscriptionExpiry();
    setInterval(checkSubscriptionExpiry, 24 * 60 * 60 * 1000);
  }, msUntil9am);

  console.log(`⏰ Abonelik kontrolü ${next9am.toLocaleString('tr-TR')} saatinde başlayacak`);
}

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
    const fs = require('fs');
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const backupDir = './backups';
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    const filePath = `${backupDir}/${dateStr}.json`;
    fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2));
    console.log(`✅ Yedek kaydedildi: ${filePath}`);
  } catch(err) {
    console.error('❌ Yedekleme hatası:', err.message);
  }
}
const PORT = process.env.PORT || 3000;
// Müşteri menüsü sayfası — /menu/:slug
app.get('/admin', (req, res) => {
  res.sendFile('admin.html', { root: 'public' });
});

app.get('/verify-email', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

app.get('/reset-password', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});
app.get('/menu/:slug', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// Kısa URL — /:slug (restoran adından slug)
app.get('/:slug', (req, res, next) => {
  const reserved = ['admin','api','verify-email','reset-password','sw.js','manifest.json','icons','backup.js'];
  if (reserved.includes(req.params.slug)) return next();
  res.sendFile('index.html', { root: 'public' });
});

// Tüm diğer rotalar — index.html'e yönlendir
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});
async function startServer() {
  try {
    await initDB();
    server.listen(PORT, () => {
      console.log(`🚀 CafeMenu API çalışıyor: port ${PORT}`);
      scheduleBackup();
      scheduleSubscriptionCheck();
    });
  } catch (err) {
    console.error('❌ Sunucu başlatılamadı:', err.message);
    process.exit(1);
  }
}

startServer();