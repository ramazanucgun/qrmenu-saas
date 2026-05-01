/**
 * Mevcut base64 resimleri sıkıştırır
 * Render'da çalıştırmak için:
 *   node migrate-images.js
 * 
 * Veya package.json'a ekleyip:
 *   npm run migrate-images
 */

require('dotenv').config();
const { Pool } = require('pg');

let sharp;
try {
  sharp = require('sharp');
  console.log('✅ sharp yüklü');
} catch(e) {
  console.error('❌ sharp yüklü değil. npm install sharp yapın.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function resizeBase64(dataUrl, width, height, quality = 72) {
  if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl;
  const base64Data = dataUrl.split(',')[1];
  if (!base64Data) return dataUrl;
  const buffer = Buffer.from(base64Data, 'base64');
  const resized = await sharp(buffer)
    .resize(width, height, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
  const newDataUrl = `data:image/webp;base64,${resized.toString('base64')}`;
  const oldKB = Math.round(buffer.length / 1024);
  const newKB = Math.round(resized.length / 1024);
  return { url: newDataUrl, oldKB, newKB };
}

async function migrate() {
  console.log('\n🔄 Resim migration başladı...\n');
  let totalSaved = 0;
  let processed = 0;
  let skipped = 0;

  // ── ÜRÜN GÖRSELLERİ ──
  console.log('📦 Ürün görselleri işleniyor...');
  const products = await pool.query(
    'SELECT id, name, image_url FROM products WHERE image_url IS NOT NULL AND image_url LIKE \'data:%\''
  );
  console.log(`   ${products.rows.length} ürün bulundu`);

  for (const p of products.rows) {
    try {
      const oldKB = Math.round(p.image_url.length * 0.75 / 1024);
      // 100KB'dan küçükse zaten optimize, atla
      if (oldKB < 100) { skipped++; continue; }

      const result = await resizeBase64(p.image_url, 600, 600, 72);
      if (typeof result === 'string') { skipped++; continue; }

      await pool.query('UPDATE products SET image_url=$1 WHERE id=$2', [result.url, p.id]);
      const saved = result.oldKB - result.newKB;
      totalSaved += saved;
      processed++;
      console.log(`   ✅ ${p.name.slice(0,30)}: ${result.oldKB}KB → ${result.newKB}KB (${saved}KB kazanıldı)`);
    } catch(e) {
      console.log(`   ⚠️  ${p.name}: ${e.message}`);
    }
  }

  // ── RESTORAN LOGOLARI ──
  console.log('\n🏪 Restoran logoları işleniyor...');
  const restaurants = await pool.query(
    'SELECT id, name, logo_url FROM restaurants WHERE logo_url IS NOT NULL AND logo_url LIKE \'data:%\''
  );
  console.log(`   ${restaurants.rows.length} restoran bulundu`);

  for (const r of restaurants.rows) {
    try {
      const oldKB = Math.round(r.logo_url.length * 0.75 / 1024);
      if (oldKB < 20) { skipped++; continue; }

      const result = await resizeBase64(r.logo_url, 200, 200, 80);
      if (typeof result === 'string') { skipped++; continue; }

      await pool.query('UPDATE restaurants SET logo_url=$1 WHERE id=$2', [result.url, r.id]);
      const saved = result.oldKB - result.newKB;
      totalSaved += saved;
      processed++;
      console.log(`   ✅ ${r.name}: ${result.oldKB}KB → ${result.newKB}KB (${saved}KB kazanıldı)`);
    } catch(e) {
      console.log(`   ⚠️  ${r.name}: ${e.message}`);
    }
  }

  // ── KAMPANYA GÖRSELLERİ ──
  console.log('\n📢 Kampanya görselleri işleniyor...');
  const campaigns = await pool.query(
    'SELECT id, title, image_url FROM campaigns WHERE image_url IS NOT NULL AND image_url LIKE \'data:%\''
  );
  console.log(`   ${campaigns.rows.length} kampanya bulundu`);

  for (const c of campaigns.rows) {
    try {
      const oldKB = Math.round(c.image_url.length * 0.75 / 1024);
      if (oldKB < 100) { skipped++; continue; }

      const result = await resizeBase64(c.image_url, 800, 500, 75);
      if (typeof result === 'string') { skipped++; continue; }

      await pool.query('UPDATE campaigns SET image_url=$1 WHERE id=$2', [result.url, c.id]);
      const saved = result.oldKB - result.newKB;
      totalSaved += saved;
      processed++;
      console.log(`   ✅ ${c.title}: ${result.oldKB}KB → ${result.newKB}KB (${saved}KB kazanıldı)`);
    } catch(e) {
      console.log(`   ⚠️  ${c.title}: ${e.message}`);
    }
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Migration tamamlandı!
   İşlenen:  ${processed} resim
   Atlanan:  ${skipped} resim (zaten küçük)
   Toplam kazanç: ~${Math.round(totalSaved / 1024)}MB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);

  await pool.end();
}

migrate().catch(err => {
  console.error('Migration hatası:', err);
  process.exit(1);
});
