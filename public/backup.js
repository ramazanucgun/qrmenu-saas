const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

async function backup() {
  console.log('🔄 Yedekleme başlıyor...');
  try {
    const tables = ['users', 'restaurants', 'subscriptions', 'categories', 'products', 'feedbacks', 'waiter_calls', 'campaigns', 'working_hours'];
    const backupData = {};
    for (const table of tables) {
      try {
        const result = await pool.query(`SELECT * FROM ${table}`);
        backupData[table] = result.rows;
        console.log(`✓ ${table}: ${result.rows.length} kayıt`);
      } catch(e) {
        console.log(`✗ ${table}: ${e.message}`);
        backupData[table] = [];
      }
    }
    const now = new Date();
    const fileName = `backups/${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}.json`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileName,
      Body: JSON.stringify(backupData, null, 2),
      ContentType: 'application/json',
    }));
    console.log(`✅ Yedek kaydedildi: ${fileName}`);
    await pool.end();
  } catch(err) {
    console.error('❌ Yedekleme hatası:', err.message);
    await pool.end();
    process.exit(1);
  }
}

backup();