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
