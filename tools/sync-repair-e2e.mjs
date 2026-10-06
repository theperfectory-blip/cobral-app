// E9 regression (Firebase emulators must be running: bash tools/emulators.sh):
//   A) verify(): the server lost docs the shadow believes are uploaded → verify() finds them and push() re-sends them.
//   B) unacked ledger: writes queued while offline are lost with the client ("app killed" with a lost queue) → the next
//      client on the same device (same localStorage) re-sends them on sign-in.
// Usage: node tools/sync-repair-e2e.mjs
import assert from 'node:assert/strict';

// A real-looking localStorage shared by every client of this process (= one device), so the shadow and the ledger survive
// a "restart" (a new client instance with a fresh, empty Firestore memory cache).
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
const { createClient } = await import('../cloud-src/cobral-cloud.js');

const HOST = '127.0.0.1';
const BASE = `http://${HOST}:8080/v1/projects/cobral-app/databases/(default)/documents`;
const OWNER = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const CONFIG = { apiKey: 'emulator-fake-api-key', authDomain: 'cobral-app.firebaseapp.com', projectId: 'cobral-app', appId: '1:60325446787:web:292ff3035908f69c2f07b6' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, label, timeout = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return; await sleep(500); }
  throw new Error('timeout: ' + label);
}
function snapshot(n) {
  const sales = [];
  for (let i = 1; i <= n; i++) sales.push({ id: 1700000000000 + i, numVenta: i, date: new Date(1767312000000 + i * 60000).toISOString(), items: [{ productId: 1, name: 'Bolsa', price: 1000, costPrice: 400, qty: 1, unit: 'u' }], subtotal: 1000, fee: 0, finalAmount: 1000, totalCost: 400, margin: 600, marginPct: 60, paymentMethod: 'efectivo', location: 'Mann', isAbono: false });
  return { sales, products: [], debts: [], debtHistory: [], settings: { categories: ['Todos'], locations: {}, userName: 'Prueba', debitFee: 1.3029, creditFee: 2.499 } };
}
async function serverIds(uid, col = 'sales') {
  const ids = []; let tok = '';
  do {
    const r = await (await fetch(`${BASE}/users/${uid}/${col}?pageSize=1000&mask.fieldPaths=id${tok ? '&pageToken=' + tok : ''}`, { headers: OWNER })).json();
    ids.push(...(r.documents || []).map((d) => d.name)); tok = r.nextPageToken || '';
  } while (tok);
  return ids;
}
async function deleteDocs(names) {
  for (let i = 0; i < names.length; i += 400) {
    const r = await fetch(`${BASE}:batchWrite`, { method: 'POST', headers: OWNER, body: JSON.stringify({ writes: names.slice(i, i + 400).map((n) => ({ delete: n })) }) });
    assert.ok(r.ok, 'batchWrite delete failed: ' + r.status);
  }
}
let appSeq = 0;
function newClient() {
  const c = createClient();
  let user = null;
  c.init({ config: CONFIG, emulatorHost: HOST, appName: 'repair-' + (++appSeq), onUser: (u) => { user = u; }, onRemote: () => {}, onStatus: () => {} });
  return { c, user: () => user };
}
let passed = 0;
const ok = (msg) => { passed++; console.log('PASS ' + msg); };

// ---------- A) verify + push repairs a server that lost docs ----------
{
  const { c, user } = newClient();
  const email = `repair-a-${Date.now()}@cobral.test`;
  assert.equal((await c.signUp(email, 'prueba123')).ok, true);
  await waitUntil(() => user(), 'A signed in');
  const snap = snapshot(1000);
  await c.firstSync(snap);
  await waitUntil(() => c.status() === 'synced', 'A first upload acked');
  const uid = user().uid;
  let ids = await serverIds(uid);
  assert.equal(ids.length, 1000); ok('A: first sync uploaded 1000 sales');
  await deleteDocs(ids.slice(450));
  await fetch(`${BASE}/users/${uid}/meta/settings`, { method: 'DELETE', headers: OWNER });
  assert.equal((await serverIds(uid)).length, 450); ok('A: server now has 450 (simulated loss), client still says ' + c.status());
  const v = await c.verify();
  assert.equal(v.ok, true); assert.equal(v.missing, 551); ok('A: verify() found 550 sales + settings missing');
  c.push(snap);
  await sleep(2000);
  await waitUntil(() => c.status() === 'synced', 'A re-upload acked');
  assert.equal((await serverIds(uid)).length, 1000);
  const st = await (await fetch(`${BASE}/users/${uid}/meta/settings`, { headers: OWNER })).json();
  assert.equal(st.fields.userName.stringValue, 'Prueba'); ok('A: push() re-sent everything: 1000 sales + settings on the server');
  const v2 = await c.verify();
  assert.equal(v2.missing, 0); ok('A: second verify() finds nothing missing');
}

// ---------- B) unacked ledger survives a "restart" with a lost write queue ----------
{
  const first = newClient();
  const email = `repair-b-${Date.now()}@cobral.test`;
  assert.equal((await first.c.signUp(email, 'prueba123')).ok, true);
  await waitUntil(() => first.user(), 'B signed in');
  const uid = first.user().uid;
  const empty = { ...snapshot(0), settings: null };
  await first.c.firstSync(empty);
  await first.c._network(false);
  const snap = snapshot(600);
  first.c.push(snap);
  await sleep(2500); // push() debounce
  const ledger = JSON.parse(localStorage.getItem('cobralCloudUnacked:' + uid) || '{}');
  assert.equal(Object.keys(ledger).length, 601); ok('B: 600 sales + settings pushed offline → all in the unacked ledger');
  assert.notEqual(first.c.status(), 'synced'); ok('B: status is not "synced" while unacked (' + first.c.status() + ')');
  // "App killed": this client (and its in-memory write queue) is abandoned without ever reaching the server.
  assert.equal((await serverIds(uid)).length, 0); ok('B: nothing reached the server');
  const second = newClient();
  assert.equal((await second.c.signIn(email, 'prueba123')).ok, true);
  await waitUntil(() => second.user(), 'B second client signed in');
  assert.equal(second.c._debugStats().recoveredUnacked, 601); ok('B: new launch recovered 601 unacked writes from the ledger');
  second.c.push(snap);
  await sleep(2000);
  await waitUntil(() => second.c.status() === 'synced', 'B re-upload acked');
  assert.equal((await serverIds(uid)).length, 600);
  assert.equal(Object.keys(JSON.parse(localStorage.getItem('cobralCloudUnacked:' + uid) || '{}')).length, 0);
  ok('B: re-sent on the next launch: 600 sales on the server, ledger empty');
}
console.log(`\n${passed} checks passed`);
process.exit(0);
