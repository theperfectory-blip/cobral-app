import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLECTIONS,
  stableStringify,
  hashDoc,
  stripSyncFields,
  toRemoteData,
  toTombstone,
  fromRemoteDoc,
  coerceId,
  arrayToMap,
  mapToArray,
  emptyShadow,
  buildShadowFromSnapshot,
  updateShadowForCollection,
  updateShadowSettings,
  diff,
  isDiffEmpty,
  mergeFirstSync,
  stockMapFromProducts,
  attachBaseStock,
  OPTIONAL_PRODUCT_KEYS,
  stockDelta,
  optionalKeysToDelete,
  planProductWrite,
  ownEchoHasStockDrift,
} from './sync-core.js';

function emptySnapshot() {
  return { sales: [], products: [], debts: [], debtHistory: [], settings: null };
}

// ---------------------------------------------------------------------------
// stableStringify / hashDoc
// ---------------------------------------------------------------------------

test('stableStringify is independent of key order', () => {
  const a = { id: 1, name: 'Coca', price: 1000 };
  const b = { price: 1000, id: 1, name: 'Coca' };
  assert.equal(stableStringify(a), stableStringify(b));
});

test('stableStringify differentiates nested content', () => {
  const a = { items: [{ id: 1, qty: 2 }] };
  const b = { items: [{ id: 1, qty: 3 }] };
  assert.notEqual(stableStringify(a), stableStringify(b));
});

test('hashDoc is stable for equal content regardless of key order', () => {
  const a = { id: 1, name: 'Coca', items: [{ id: 9, qty: 2 }] };
  const b = { items: [{ qty: 2, id: 9 }], name: 'Coca', id: 1 };
  assert.equal(hashDoc(a), hashDoc(b));
});

test('hashDoc changes when content changes', () => {
  const a = { id: 1, stock: 10 };
  const b = { id: 1, stock: 9 };
  assert.notEqual(hashDoc(a), hashDoc(b));
});

test('hashDoc ignores sync-only fields', () => {
  const a = { id: 1, name: 'Coca' };
  const b = { id: 1, name: 'Coca', _updatedAt: 'x', _deleted: false, _device: 'dev1' };
  assert.equal(hashDoc(a), hashDoc(b));
});

// ---------------------------------------------------------------------------
// mapping helpers
// ---------------------------------------------------------------------------

test('toRemoteData strips existing sync fields and stamps _deleted/_device', () => {
  const local = { id: 5, name: 'X', _updatedAt: 'stale', _deleted: true, _device: 'old' };
  const out = toRemoteData(local, 'dev-A');
  assert.deepEqual(out, { id: 5, name: 'X', _deleted: false, _device: 'dev-A' });
});

test('toTombstone shape', () => {
  const out = toTombstone('123', 'dev-A');
  assert.deepEqual(out, { id: 123, _deleted: true, _device: 'dev-A' });
});

test('fromRemoteDoc / toRemoteData round trip preserves app content', () => {
  const local = { id: 42, name: 'Pan', qty: 3 };
  const remote = toRemoteData(local, 'dev-A');
  const back = fromRemoteDoc(remote);
  assert.deepEqual(back, local);
});

test('coerceId turns numeric-looking strings into numbers, leaves others alone', () => {
  assert.equal(coerceId('1700000000000'), 1700000000000);
  assert.equal(coerceId('settings'), 'settings');
});

test('arrayToMap / mapToArray round trip', () => {
  const arr = [{ id: 1, a: 1 }, { id: 2, a: 2 }];
  const map = arrayToMap(arr);
  assert.deepEqual(map, { 1: { id: 1, a: 1 }, 2: { id: 2, a: 2 } });
  const back = mapToArray(map).sort((x, y) => x.id - y.id);
  assert.deepEqual(back, arr);
});

// ---------------------------------------------------------------------------
// diff()
// ---------------------------------------------------------------------------

test('diff flags a brand new doc as an upsert', () => {
  const shadow = emptyShadow();
  const snap = emptySnapshot();
  snap.sales = [{ id: 1, total: 1000 }];
  const d = diff(shadow, snap);
  assert.equal(d.sales.upserts.length, 1);
  assert.equal(d.sales.upserts[0].id, 1);
  assert.equal(d.sales.deletes.length, 0);
});

test('diff flags a changed doc as an upsert, ignores unchanged docs', () => {
  const snap1 = emptySnapshot();
  snap1.products = [{ id: 1, stock: 10 }, { id: 2, stock: 5 }];
  const shadow = buildShadowFromSnapshot(snap1);

  const snap2 = emptySnapshot();
  snap2.products = [{ id: 1, stock: 9 }, { id: 2, stock: 5 }]; // only id 1 changed
  const d = diff(shadow, snap2);
  assert.equal(d.products.upserts.length, 1);
  assert.equal(d.products.upserts[0].id, 1);
  assert.equal(d.products.deletes.length, 0);
});

test('diff flags a removed doc as a delete', () => {
  const snap1 = emptySnapshot();
  snap1.debts = [{ id: 1, remaining: 500 }, { id: 2, remaining: 200 }];
  const shadow = buildShadowFromSnapshot(snap1);

  const snap2 = emptySnapshot();
  snap2.debts = [{ id: 1, remaining: 500 }]; // id 2 removed (paid off / deleted)
  const d = diff(shadow, snap2);
  assert.equal(d.debts.upserts.length, 0);
  assert.deepEqual(d.debts.deletes, [2]);
});

test('diff against a matching shadow is empty', () => {
  const snap = emptySnapshot();
  snap.sales = [{ id: 1, total: 1000 }];
  snap.settings = { userName: 'Jimbo' };
  const shadow = buildShadowFromSnapshot(snap);
  const d = diff(shadow, snap);
  assert.ok(isDiffEmpty(d));
});

test('diff flags settings changes independently of collections', () => {
  const snap1 = emptySnapshot();
  snap1.settings = { userName: 'Jimbo', debitFee: 1.3029 };
  const shadow = buildShadowFromSnapshot(snap1);

  const snap2 = { ...snap1, settings: { userName: 'Jimbo', debitFee: 1.5 } };
  const d = diff(shadow, snap2);
  assert.deepEqual(d.settings.upsert, snap2.settings);
  assert.ok(!isDiffEmpty(d));
});

// ---------------------------------------------------------------------------
// shadow update helpers
// ---------------------------------------------------------------------------

test('updateShadowForCollection applies upserts and deletes without mutating input', () => {
  const shadow = buildShadowFromSnapshot({ ...emptySnapshot(), sales: [{ id: 1, total: 100 }] });
  const frozenCopy = JSON.parse(JSON.stringify(shadow));
  const next = updateShadowForCollection(shadow, 'sales', [{ id: 2, total: 200 }], [1]);
  assert.deepEqual(shadow, frozenCopy, 'input shadow must not be mutated');
  assert.ok(!('1' in next.sales));
  assert.ok('2' in next.sales);
});

test('updateShadowSettings sets and clears the settings hash', () => {
  const shadow = emptyShadow();
  const withSettings = updateShadowSettings(shadow, { userName: 'Jimbo' });
  assert.equal(withSettings.settings, hashDoc({ userName: 'Jimbo' }));
  const cleared = updateShadowSettings(withSettings, null);
  assert.equal(cleared.settings, null);
});

test('a full round trip (build shadow -> apply real diff) reaches a stable fixpoint', () => {
  let shadow = emptyShadow();
  const snap = emptySnapshot();
  snap.products = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  const d = diff(shadow, snap);
  for (const col of COLLECTIONS) {
    shadow = updateShadowForCollection(shadow, col, d[col].upserts, d[col].deletes);
  }
  shadow = updateShadowSettings(shadow, d.settings.upsert);
  const d2 = diff(shadow, snap);
  assert.ok(isDiffEmpty(d2));
});

// ---------------------------------------------------------------------------
// mergeFirstSync()
// ---------------------------------------------------------------------------

test('mergeFirstSync: cloud empty uploads everything unchanged', () => {
  const local = emptySnapshot();
  local.sales = [{ id: 1, total: 100 }, { id: 2, total: 200 }];
  local.settings = { userName: 'Jimbo' };
  const remote = emptySnapshot();

  const { merged, upload } = mergeFirstSync(local, remote);
  assert.deepEqual(merged.sales.sort((a, b) => a.id - b.id), local.sales);
  assert.deepEqual(upload.sales.sort((a, b) => a.id - b.id), local.sales);
  assert.deepEqual(merged.settings, local.settings);
  assert.deepEqual(upload.settings, local.settings);
});

test('mergeFirstSync: both non-empty unions by id, remote wins on conflicts, local-only gets uploaded', () => {
  const local = emptySnapshot();
  local.products = [
    { id: 1, name: 'Local version', stock: 5 }, // conflicting id -> remote should win
    { id: 3, name: 'Local only', stock: 1 }, // local-only -> must be uploaded
  ];
  const remote = emptySnapshot();
  remote.products = [
    { id: 1, name: 'Remote version', stock: 10 },
    { id: 2, name: 'Remote only', stock: 7 }, // remote-only -> present in merged, not uploaded
  ];

  const { merged, upload } = mergeFirstSync(local, remote);
  const byId = arrayToMap(merged.products);
  assert.equal(byId['1'].name, 'Remote version', 'remote should win on conflicting id');
  assert.equal(byId['2'].name, 'Remote only', 'remote-only doc must survive the merge');
  assert.equal(byId['3'].name, 'Local only', 'local-only doc must survive the merge');

  assert.equal(upload.products.length, 1);
  assert.equal(upload.products[0].id, 3, 'only the local-only doc should be queued for upload');
});

test('mergeFirstSync: remote settings win when present, nothing uploaded', () => {
  const local = { ...emptySnapshot(), settings: { userName: 'Local Name' } };
  const remote = { ...emptySnapshot(), settings: { userName: 'Remote Name' } };
  const { merged, upload } = mergeFirstSync(local, remote);
  assert.equal(merged.settings.userName, 'Remote Name');
  assert.equal(upload.settings, null);
});

test('mergeFirstSync: neither side has settings', () => {
  const local = emptySnapshot();
  const remote = emptySnapshot();
  const { merged, upload } = mergeFirstSync(local, remote);
  assert.equal(merged.settings, null);
  assert.equal(upload.settings, null);
});

test('mergeFirstSync leaves collections independent (debts vs sales do not cross-contaminate)', () => {
  const local = emptySnapshot();
  local.sales = [{ id: 1, total: 10 }];
  const remote = emptySnapshot();
  remote.debts = [{ id: 9, remaining: 50 }];
  const { merged, upload } = mergeFirstSync(local, remote);
  assert.equal(merged.sales.length, 1);
  assert.equal(upload.sales.length, 1);
  assert.equal(merged.debts.length, 1);
  assert.equal(upload.debts.length, 0, 'remote-only debt must not be re-uploaded');
});

// ---------------------------------------------------------------------------
// B4: shadowStock / _baseStock (three-way merge of products[].stock)
// ---------------------------------------------------------------------------

test('stockMapFromProducts keys by String(id), ignores products without a numeric stock', () => {
  const map = stockMapFromProducts([
    { id: 1, stock: 10 },
    { id: 2, stock: 0 },
    { id: 3 }, // no stock field
    { id: 4, stock: 'lots' }, // non-numeric, ignored
  ]);
  assert.deepEqual(map, { 1: 10, 2: 0 });
});

test('stockMapFromProducts of an empty/undefined list is an empty map', () => {
  assert.deepEqual(stockMapFromProducts([]), {});
  assert.deepEqual(stockMapFromProducts(undefined), {});
});

test('emptyShadow has an empty stock map', () => {
  assert.deepEqual(emptyShadow().stock, {});
});

test('buildShadowFromSnapshot seeds shadow.stock from the snapshot products', () => {
  const snap = emptySnapshot();
  snap.products = [{ id: 1, stock: 10 }, { id: 2, stock: 5 }];
  const shadow = buildShadowFromSnapshot(snap);
  assert.deepEqual(shadow.stock, { 1: 10, 2: 5 });
});

test('attachBaseStock attaches the known shadow value as _baseStock, leaves unknown ids alone', () => {
  const shadowStock = { 1: 10, 2: 7 };
  const upserts = [{ id: 1, stock: 8, name: 'A' }, { id: 3, stock: 4, name: 'C' }];
  const out = attachBaseStock(shadowStock, upserts);
  assert.equal(out[0]._baseStock, 10);
  assert.equal(out[0].stock, 8);
  assert.ok(!('_baseStock' in out[1]), 'unknown base (new product) must not get a _baseStock field');
  // Pure: must not mutate the input docs.
  assert.ok(!('_baseStock' in upserts[0]));
});

test('attachBaseStock of an empty/undefined upsert list is an empty array', () => {
  assert.deepEqual(attachBaseStock({ 1: 5 }, []), []);
  assert.deepEqual(attachBaseStock({ 1: 5 }, undefined), []);
});

test('updateShadowForCollection refreshes shadow.stock for products (upserts and deletes)', () => {
  let shadow = buildShadowFromSnapshot({ ...emptySnapshot(), products: [{ id: 1, stock: 10 }, { id: 2, stock: 5 }] });
  shadow = updateShadowForCollection(shadow, 'products', [{ id: 1, stock: 8 }, { id: 3, stock: 20 }], [2]);
  assert.deepEqual(shadow.stock, { 1: 8, 3: 20 });
});

test('updateShadowForCollection leaves shadow.stock untouched for non-product collections', () => {
  let shadow = buildShadowFromSnapshot({ ...emptySnapshot(), products: [{ id: 1, stock: 10 }] });
  shadow = updateShadowForCollection(shadow, 'sales', [{ id: 99, total: 1 }], []);
  assert.deepEqual(shadow.stock, { 1: 10 });
});

test('B4 scenario: concurrent decrements on two devices converge via the merge formula base+remoteDelta+localDelta', () => {
  // Both devices start from the same known cloud stock (base = 10).
  const base = 10;
  const shadowStockA = { 42: base };
  // Device A decrements by 2 locally (open sale), device B decrements by 1 and pushes first.
  const localStockA = base - 2; // A's in-progress local stock
  const remoteUpsertFromB = { id: 42, stock: base - 1 }; // what B pushed
  const [withBase] = attachBaseStock(shadowStockA, [remoteUpsertFromB]);
  assert.equal(withBase._baseStock, base);
  // The app applies the same formula index.html's applyRemoteChange uses:
  const merged = withBase.stock + (localStockA - withBase._baseStock);
  assert.equal(merged, base - 3, 'both decrements must be reflected: base - a - b');
});

test('B4 scenario: remote update with no local change yields exactly the remote stock (no double counting)', () => {
  const base = 10;
  const shadowStock = { 42: base };
  const remoteUpsert = { id: 42, stock: base - 1 };
  const [withBase] = attachBaseStock(shadowStock, [remoteUpsert]);
  const localStock = base; // no local change at all
  const merged = withBase.stock + (localStock - withBase._baseStock);
  assert.equal(merged, base - 1, 'no local delta means the merge must equal the remote value exactly');
});

// ---------------------------------------------------------------------------
// F10: stock as server-side deltas
// ---------------------------------------------------------------------------

test('F10 stockDelta: local - shadow when both are numbers (including 0 and negatives)', () => {
  assert.equal(stockDelta({ 1: 10 }, { id: 1, stock: 8 }), -2);
  assert.equal(stockDelta({ 1: 10 }, { id: 1, stock: 10 }), 0);
  assert.equal(stockDelta({ 1: -1 }, { id: 1, stock: -2 }), -1);
  assert.equal(stockDelta({ 1: 0 }, { id: 1, stock: 5 }), 5);
});

test('F10 stockDelta: null when the base or the local stock is unknown / not a finite number', () => {
  assert.equal(stockDelta({}, { id: 1, stock: 8 }), null);
  assert.equal(stockDelta(undefined, { id: 1, stock: 8 }), null);
  assert.equal(stockDelta({ 1: 10 }, { id: 1 }), null);
  assert.equal(stockDelta({ 1: 10 }, { id: 1, stock: '8' }), null);
  assert.equal(stockDelta({ 1: NaN }, { id: 1, stock: 8 }), null);
  assert.equal(stockDelta({ 1: 10 }, { id: 1, stock: Infinity }), null);
  assert.equal(stockDelta({ 1: 10 }, null), null);
});

test('F10 optionalKeysToDelete: lists known optional keys that are absent locally', () => {
  assert.deepEqual(optionalKeysToDelete({ id: 1, name: 'x', offers: [], gramStep: 250 }).sort(), ['imageUrl', 'locationPrices', 'packSize']);
  assert.deepEqual(optionalKeysToDelete({ id: 1, locationPrices: { A: 1 }, offers: [], gramStep: 1, imageUrl: '', packSize: 12 }), []);
  assert.deepEqual(optionalKeysToDelete({ id: 1 }).sort(), [...OPTIONAL_PRODUCT_KEYS].sort());
  assert.ok(OPTIONAL_PRODUCT_KEYS.includes('locationPrices') && OPTIONAL_PRODUCT_KEYS.includes('offers'));
  // photos: imageUrl is optional too — '' (photo deleted on purpose) is a real value and must NOT be deleted remotely
  assert.ok(OPTIONAL_PRODUCT_KEYS.includes('imageUrl'));
  assert.ok(!optionalKeysToDelete({ id: 1, imageUrl: '' }).includes('imageUrl'));
  assert.ok(optionalKeysToDelete({ id: 1 }).includes('imageUrl'));
});

test('F10 planProductWrite: known base -> delta mode; unknown base or absolute flag -> absolute mode', () => {
  const doc = { id: 7, stock: 7, offers: [], gramStep: 250 };
  assert.deepEqual(planProductWrite({ 7: 10 }, doc), { mode: 'delta', delta: -3, deleteKeys: ['locationPrices', 'imageUrl', 'packSize'] });
  assert.deepEqual(planProductWrite({ 7: 7 }, doc), { mode: 'delta', delta: 0, deleteKeys: ['locationPrices', 'imageUrl', 'packSize'] });
  assert.deepEqual(planProductWrite({}, doc), { mode: 'absolute' });
  assert.deepEqual(planProductWrite({ 7: 10 }, doc, { absolute: true }), { mode: 'absolute' });
  assert.deepEqual(planProductWrite({ 7: 10 }, { id: 7, name: 'no stock' }), { mode: 'absolute' });
});

test('F10 ownEchoHasStockDrift: only when base and remote stock are numbers and differ', () => {
  assert.equal(ownEchoHasStockDrift({ 1: 8 }, 1, 7), true);
  assert.equal(ownEchoHasStockDrift({ 1: 8 }, '1', 7), true);
  assert.equal(ownEchoHasStockDrift({ 1: 8 }, 1, 8), false);
  assert.equal(ownEchoHasStockDrift({}, 1, 8), false);
  assert.equal(ownEchoHasStockDrift({ 1: 8 }, 1, undefined), false);
});

test('F10 scenario: A -2 and B -1 as increments converge to base-3 regardless of which lands last', () => {
  const base = 10;
  const a = planProductWrite({ 1: base }, { id: 1, stock: base - 2 });
  const b = planProductWrite({ 1: base }, { id: 1, stock: base - 1 });
  assert.equal(base + b.delta + a.delta, 7);
  assert.equal(base + a.delta + b.delta, 7);
});

test('F10 scenario: own echo with the merged server stock is merged back via _baseStock (A sees 7, local 8, base 8)', () => {
  const shadowStock = { 1: 8 }; // A dispatched -2 and set shadow to its local 8
  assert.equal(ownEchoHasStockDrift(shadowStock, 1, 7), true);
  const [withBase] = attachBaseStock(shadowStock, [{ id: 1, stock: 7 }]);
  assert.equal(withBase._baseStock, 8);
  assert.equal(withBase.stock + (8 - withBase._baseStock), 7);
});
