// ═══════════════════════════════════════════════════════════════
// ALLERGEN SERVICE — Ürün içeriği / alerjen / besin bilgisi katmanı
// ═══════════════════════════════════════════════════════════════
// Bu dosya "Service Layer" görevi görür: server.js içindeki route'lar
// doğrudan SQL yazmak yerine bu fonksiyonları çağırır. Böylece:
//  - Alerjen mantığı tek yerde toplanır (DRY)
//  - N+1 query problemi engellenir (batch/eager loading)
//  - İleride vitamin/mineral/AI-tahmin gibi özellikler tek dosyada büyür
// ═══════════════════════════════════════════════════════════════

/**
 * 14 resmi alerjeni sort_order'a göre döner.
 * Çok sık çağrıldığı için (menü sayfası her ziyarette) 5 dakikalık basit cache kullanır.
 */
let _allergenCache = null;
let _allergenCacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getAllAllergens(pool) {
  const now = Date.now();
  if (_allergenCache && (now - _allergenCacheAt) < CACHE_TTL_MS) return _allergenCache;
  const result = await pool.query('SELECT id, key, name_tr, name_en, icon, sort_order FROM allergens ORDER BY sort_order ASC');
  _allergenCache = result.rows;
  _allergenCacheAt = now;
  return _allergenCache;
}

function invalidateAllergenCache() {
  _allergenCache = null;
}

/**
 * Birden fazla ürünün alerjenlerini TEK sorguda çeker (N+1 önleme / eager loading).
 * Dönüş: { [productId]: [{id,key,name_tr,name_en,icon}, ...] }
 */
async function getAllergensForProducts(pool, productIds) {
  if (!productIds || !productIds.length) return {};
  const result = await pool.query(
    `SELECT pa.product_id, a.id, a.key, a.name_tr, a.name_en, a.icon, a.sort_order
     FROM product_allergens pa
     JOIN allergens a ON a.id = pa.allergen_id
     WHERE pa.product_id = ANY($1::uuid[])
     ORDER BY a.sort_order ASC`,
    [productIds]
  );
  const map = {};
  for (const row of result.rows) {
    if (!map[row.product_id]) map[row.product_id] = [];
    map[row.product_id].push({
      id: row.id, key: row.key, name_tr: row.name_tr, name_en: row.name_en, icon: row.icon
    });
  }
  return map;
}

/**
 * Tek ürünün alerjenlerini çeker.
 */
async function getAllergensForProduct(pool, productId) {
  const map = await getAllergensForProducts(pool, [productId]);
  return map[productId] || [];
}

/**
 * Bir ürünün alerjen listesini TAMAMEN değiştirir (replace-all pattern).
 * allergenKeys: ['gluten','sut', ...] gibi key dizisi (frontend checkbox value'ları)
 * Transaction kullanmaz çünkü tek pool.query çağrıları küçük restoran ölçeğinde yeterli;
 * gerekirse pool.connect() ile client bazlı transaction'a yükseltilebilir.
 */
async function setProductAllergens(pool, productId, allergenKeys) {
  await pool.query('DELETE FROM product_allergens WHERE product_id=$1', [productId]);
  if (!Array.isArray(allergenKeys) || !allergenKeys.length) return;
  // Geçersiz key'leri sessizce yok say — kötü niyetli/hatalı input DB hatası fırlatmasın
  await pool.query(
    `INSERT INTO product_allergens (product_id, allergen_id)
     SELECT $1, a.id FROM allergens a WHERE a.key = ANY($2::text[])
     ON CONFLICT DO NOTHING`,
    [productId, allergenKeys]
  );
}

/**
 * Ürün nesnesine yeni alanları normalize eder (eski kayıtlarda null olabilir).
 * API çıktısında tutarlı tip garantisi verir (backward compatibility).
 */
function normalizeProductNutrition(product) {
  return {
    ...product,
    ingredients: product.ingredients || null,
    calories: product.calories !== null && product.calories !== undefined ? Number(product.calories) : null,
    portion: product.portion || null,
    nutrition_note: product.nutrition_note || null,
    preparation_time: product.preparation_time !== null && product.preparation_time !== undefined ? Number(product.preparation_time) : null,
    is_vegan: !!product.is_vegan,
    is_vegetarian: !!product.is_vegetarian,
    is_gluten_free: !!product.is_gluten_free,
    is_halal: !!product.is_halal,
    contains_alcohol: !!product.contains_alcohol,
  };
}

/**
 * Bir ürün listesine (menü veya admin panel) toplu şekilde alerjen bilgisi ekler.
 * Tek DB round-trip ile N+1'i önler.
 */
async function attachAllergensToProducts(pool, products) {
  if (!products.length) return products;
  const ids = products.map(p => p.id);
  const allergenMap = await getAllergensForProducts(pool, ids);
  return products.map(p => ({
    ...normalizeProductNutrition(p),
    allergens: allergenMap[p.id] || []
  }));
}

module.exports = {
  getAllAllergens,
  invalidateAllergenCache,
  getAllergensForProducts,
  getAllergensForProduct,
  setProductAllergens,
  normalizeProductNutrition,
  attachAllergensToProducts,
};
