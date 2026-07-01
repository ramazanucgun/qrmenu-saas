// ═══════════════════════════════════════════════════════════════
// allergenService.js için birim testleri
// Node'un yerleşik test runner'ı kullanılır (node:test) — ek bağımlılık
// eklemeden, projenin mevcut "sade Node.js" felsefesine uygun kalır.
// Çalıştırma: node --test tests/
// ═══════════════════════════════════════════════════════════════
const test = require('node:test');
const assert = require('node:assert/strict');
const allergenService = require('../lib/allergenService');

// Gerçek Postgres pool'una ihtiyaç duymadan test edebilmek için basit bir sahte (mock) pool.
// `calls` dizisi hangi sorguların hangi parametrelerle çağrıldığını kaydeder,
// böylece hem dönüş değerini hem de SQL çağrı davranışını doğrulayabiliriz.
function createMockPool(queryImpl) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return queryImpl(sql, params);
    }
  };
}

test('getAllAllergens — sort_order sırasına göre listeyi döner ve cache kullanır', async () => {
  allergenService.invalidateAllergenCache();
  const rows = [
    { id: '1', key: 'gluten', name_tr: 'Gluten', name_en: 'Gluten', icon: '🌾', sort_order: 1 },
    { id: '2', key: 'sut', name_tr: 'Süt', name_en: 'Milk', icon: '🥛', sort_order: 7 },
  ];
  const pool = createMockPool(() => ({ rows }));

  const first = await allergenService.getAllAllergens(pool);
  assert.equal(first.length, 2);
  assert.equal(first[0].key, 'gluten');

  // İkinci çağrı cache'ten dönmeli — pool.query TEKRAR çağrılmamalı
  const second = await allergenService.getAllAllergens(pool);
  assert.equal(second, first); // aynı referans = cache'ten geldi
  assert.equal(pool.calls.length, 1, 'ikinci çağrıda DB sorgusu tekrar atılmamalı (cache çalışmıyor)');
});

test('getAllergensForProducts — boş ürün listesinde DB sorgusu atmaz', async () => {
  const pool = createMockPool(() => { throw new Error('sorgu atılmamalıydı'); });
  const result = await allergenService.getAllergensForProducts(pool, []);
  assert.deepEqual(result, {});
});

test('getAllergensForProducts — tek sorguda birden fazla ürünü gruplar (N+1 önleme)', async () => {
  const rows = [
    { product_id: 'p1', id: 'a1', key: 'gluten', name_tr: 'Gluten', name_en: 'Gluten', icon: '🌾', sort_order: 1 },
    { product_id: 'p1', id: 'a2', key: 'sut', name_tr: 'Süt', name_en: 'Milk', icon: '🥛', sort_order: 7 },
    { product_id: 'p2', id: 'a1', key: 'gluten', name_tr: 'Gluten', name_en: 'Gluten', icon: '🌾', sort_order: 1 },
  ];
  const pool = createMockPool(() => ({ rows }));

  const map = await allergenService.getAllergensForProducts(pool, ['p1', 'p2', 'p3']);

  assert.equal(pool.calls.length, 1, 'birden fazla ürün için TEK sorgu atılmalı');
  assert.equal(map.p1.length, 2);
  assert.equal(map.p2.length, 1);
  assert.equal(map.p3, undefined, 'alerjeni olmayan ürün map içinde anahtar olarak bulunmamalı');
});

test('setProductAllergens — önce siler, sonra sadece key dizisi doluysa ekler', async () => {
  const pool = createMockPool(() => ({ rows: [] }));

  await allergenService.setProductAllergens(pool, 'p1', ['gluten', 'sut']);
  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /DELETE FROM product_allergens/);
  assert.deepEqual(pool.calls[0].params, ['p1']);
  assert.match(pool.calls[1].sql, /INSERT INTO product_allergens/);
  assert.deepEqual(pool.calls[1].params, ['p1', ['gluten', 'sut']]);
});

test('setProductAllergens — boş dizi verilirse sadece DELETE çalışır, INSERT atlanır', async () => {
  const pool = createMockPool(() => ({ rows: [] }));
  await allergenService.setProductAllergens(pool, 'p1', []);
  assert.equal(pool.calls.length, 1, 'boş alerjen listesinde gereksiz INSERT sorgusu atılmamalı');
  assert.match(pool.calls[0].sql, /DELETE/);
});

test('normalizeProductNutrition — null/undefined alanları tutarlı tiplere çevirir', () => {
  const raw = { id: 'p1', name: 'Test', calories: '420', preparation_time: null, is_vegan: 1, is_halal: 0 };
  const normalized = allergenService.normalizeProductNutrition(raw);
  assert.equal(normalized.calories, 420);
  assert.equal(typeof normalized.calories, 'number');
  assert.equal(normalized.preparation_time, null);
  assert.equal(normalized.is_vegan, true);
  assert.equal(normalized.is_halal, false);
  assert.equal(normalized.ingredients, null, 'undefined ingredients null olarak normalize edilmeli');
});

test('attachAllergensToProducts — her ürüne kendi alerjen listesini ekler, eşleşmeyene boş dizi verir', async () => {
  const rows = [
    { product_id: 'p1', id: 'a1', key: 'gluten', name_tr: 'Gluten', name_en: 'Gluten', icon: '🌾', sort_order: 1 },
  ];
  const pool = createMockPool(() => ({ rows }));
  const products = [
    { id: 'p1', name: 'Ekmek', calories: 200 },
    { id: 'p2', name: 'Su', calories: null },
  ];

  const result = await allergenService.attachAllergensToProducts(pool, products);

  assert.equal(result[0].allergens.length, 1);
  assert.equal(result[0].allergens[0].key, 'gluten');
  assert.deepEqual(result[1].allergens, [], 'alerjeni olmayan ürün boş dizi almalı, undefined değil');
});

test('attachAllergensToProducts — boş ürün listesinde DB sorgusu atmaz', async () => {
  const pool = createMockPool(() => { throw new Error('sorgu atılmamalıydı'); });
  const result = await allergenService.attachAllergensToProducts(pool, []);
  assert.deepEqual(result, []);
});
