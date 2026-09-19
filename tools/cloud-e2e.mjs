// tools/cloud-e2e.mjs
//
// End-to-end test for cloud-src/cobral-cloud.js against the LOCAL Firebase emulators only.
// Run with:
//   export JAVA_HOME="/c/Users/Administrator/jdk-temurin-21/jdk-21.0.11+10"
//   export JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=C:/cobral-no-uds"
//   firebase emulators:exec --only auth,firestore --project cobral-app "node tools/cloud-e2e.mjs"
// (equivalently: `npm run e2e:cloud`, which needs those two env vars exported first.)
//
// Never touches the real cobral-app project: every FirebaseApp instance created here is pinned
// to the local emulators via emulatorHost, and every user is a throwaway created on the Auth
// emulator (which resets when the emulator process exits).

import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { initializeAuth, inMemoryPersistence, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { initializeFirestore, memoryLocalCache, connectFirestoreEmulator, doc, getDoc } from 'firebase/firestore';
import { createClient } from '../cloud-src/cobral-cloud.js';

const EMULATOR_HOST = '127.0.0.1';
const PUSH_DEBOUNCE_WAIT_MS = 1900; // must clear cobral-cloud.js's ~1.5s push() debounce

// Fake but well-shaped config: the emulators don't validate the API key or that the project is
// real, they only need a projectId that matches `--project cobral-app` on the command line.
const FIREBASE_CONFIG = {
  apiKey: 'emulator-fake-api-key',
  authDomain: 'cobral-app.firebaseapp.com',
  projectId: 'cobral-app',
  storageBucket: 'cobral-app.firebasestorage.app',
  messagingSenderId: '60325446787',
  appId: '1:60325446787:web:292ff3035908f69c2f07b6',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(fn, { timeout = 8000, interval = 150, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function uniqueEmail(tag) {
  return `e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@cobral.test`;
}

function sampleSnapshot(overrides = {}) {
  return {
    sales: [],
    products: [],
    debts: [],
    debtHistory: [],
    settings: { categories: ['General'], locations: {}, userName: 'Jimbo', debitFee: 1.3029, creditFee: 2.499, soundEnabled: true, darkMode: false },
    ...overrides,
  };
}

// Collects onRemote/onStatus/onUser events for a client so tests can wait for specific ones.
function makeRecorder() {
  const remoteEvents = [];
  const statusEvents = [];
  let user = null;
  return {
    remoteEvents,
    statusEvents,
    onRemote: (change) => remoteEvents.push(change),
    onStatus: (s) => statusEvents.push(s),
    onUser: (u) => { user = u; },
    get user() { return user; },
    findRemote(collectionName, predicate) {
      return remoteEvents.find((e) => e.collection === collectionName && predicate(e));
    },
  };
}

function newClient() {
  const rec = makeRecorder();
  const client = createClient();
  client.init({
    config: FIREBASE_CONFIG,
    emulatorHost: EMULATOR_HOST,
    onUser: rec.onUser,
    onRemote: rec.onRemote,
    onStatus: rec.onStatus,
  });
  return { client, rec };
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('PASS - ' + name);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log('FAIL - ' + name);
    console.log('       ' + (err && err.stack ? err.stack : err));
    throw err;
  }
}

async function main() {
  // ---------------------------------------------------------------------
  // Setup: two devices (clients A and B) sharing one throwaway account.
  // ---------------------------------------------------------------------
  const email = uniqueEmail('sync');
  const password = 'Cobral123!';

  const a = newClient();
  const b = newClient();

  await step('client A signs up a throwaway emulator user', async () => {
    const res = await a.client.signUp(email, password);
    assert.equal(res.ok, true, 'signUp should succeed: ' + JSON.stringify(res));
    await waitUntil(() => a.client.currentUser() !== null, { label: 'client A auth state to settle' });
  });

  await step('client B signs in as the same emulator user', async () => {
    const res = await b.client.signIn(email, password);
    assert.equal(res.ok, true, 'signIn should succeed: ' + JSON.stringify(res));
    await waitUntil(() => b.client.currentUser() !== null, { label: 'client B auth state to settle' });
  });

  const saleId = Date.now();
  const productId = saleId + 1;

  await step('client A pushes a snapshot; client B receives it via onRemote', async () => {
    const snapshot = sampleSnapshot({
      sales: [{ id: saleId, numVenta: 1, items: [{ id: 1, name: 'Coca 350', qty: 2, price: 1000 }], subtotal: 2000, fee: 0, finalAmount: 2000, totalCost: 1200, margin: 800, marginPct: 40, paymentMethod: 'efectivo', date: new Date().toISOString(), location: 'Local', isAbono: false }],
      products: [{ id: productId, name: 'Coca 350', costPrice: 600, salePrice: 1000, stock: 10, unit: 'u', category: 'Bebidas', image: null, offers: [], gramStep: 250 }],
    });
    a.client.push(snapshot);

    await waitUntil(() => b.rec.findRemote('sales', (e) => e.upserts.some((d) => d.id === saleId)), { timeout: 8000, label: 'client B onRemote for the pushed sale' });
    await waitUntil(() => b.rec.findRemote('products', (e) => e.upserts.some((d) => d.id === productId)), { timeout: 8000, label: 'client B onRemote for the pushed product' });

    const saleEvent = b.rec.findRemote('sales', (e) => e.upserts.some((d) => d.id === saleId));
    const receivedSale = saleEvent.upserts.find((d) => d.id === saleId);
    assert.equal(receivedSale.subtotal, 2000);
    assert.equal(receivedSale.paymentMethod, 'efectivo');
    // Sync-only fields must never leak into onRemote payloads.
    assert.equal(receivedSale._updatedAt, undefined);
    assert.equal(receivedSale._device, undefined);
    assert.equal(receivedSale._deleted, undefined);
  });

  await step('client B deletes the sale; client A receives the delete', async () => {
    // B applies A's earlier upsert locally (as B3 would), then removes the sale and pushes.
    const snapshotWithoutSale = sampleSnapshot({
      products: [{ id: productId, name: 'Coca 350', costPrice: 600, salePrice: 1000, stock: 10, unit: 'u', category: 'Bebidas', image: null, offers: [], gramStep: 250 }],
    });
    b.client.push(snapshotWithoutSale);

    await waitUntil(() => a.rec.findRemote('sales', (e) => e.deletes.includes(saleId)), { timeout: 8000, label: 'client A onRemote delete for the sale' });
  });

  // ---------------------------------------------------------------------
  // Offline-first: client A goes offline, pushes a write, and must not hang or re-send it.
  // ---------------------------------------------------------------------
  const offlineSaleId = Date.now() + 500;
  const offlineSaleDate = new Date().toISOString(); // fixed on purpose: built once and reused so
  // the two "identical" pushes below produce byte-identical docs (a fresh `new Date()` per call
  // would make hashDoc() see a "change" every time and defeat the very thing being tested).
  function buildOfflineSnapshot() {
    return sampleSnapshot({
      sales: [{ id: offlineSaleId, numVenta: 2, items: [{ id: 1, name: 'Coca 350', qty: 1, price: 1000 }], subtotal: 1000, fee: 0, finalAmount: 1000, totalCost: 600, margin: 400, marginPct: 40, paymentMethod: 'efectivo', date: offlineSaleDate, location: 'Local', isAbono: false }],
      products: [{ id: productId, name: 'Coca 350', costPrice: 600, salePrice: 1000, stock: 10, unit: 'u', category: 'Bebidas', image: null, offers: [], gramStep: 250 }],
    });
  }

  await step('offline: A queues a write in the local cache and reports offline/pending (not stuck forever)', async () => {
    await a.client._network(false);

    const statsBefore = a.client._debugStats();
    a.client.push(buildOfflineSnapshot());

    // The batch is dispatched (commit() called) well before any server round-trip could
    // complete — this is exactly the "shadow updates before the ack" fix being tested.
    await waitUntil(() => a.client._debugStats().writesDispatched > statsBefore.writesDispatched, { timeout: 5000, label: 'offline push to dispatch its batch locally' });

    assert.ok(['offline', 'pending'].includes(a.client.status()), `status should be 'offline' or 'pending' while disconnected with a write queued, got '${a.client.status()}'`);
  });

  await step('offline: a repeat push() with no real changes dispatches zero additional writes', async () => {
    const statsBefore = a.client._debugStats();
    // Byte-identical to the previous step's snapshot: the shadow was already updated
    // optimistically, so this diff must come back empty and flushPush must return without
    // calling dispatchOps again.
    a.client.push(buildOfflineSnapshot());
    await sleep(PUSH_DEBOUNCE_WAIT_MS);

    assert.equal(a.client._debugStats().writesDispatched, statsBefore.writesDispatched, 'an unchanged push must not dispatch new writes, offline or not (this was the bug: stale-shadow re-sends)');
  });

  await step('offline: reconnecting flushes the queued write through to client B and A settles to synced', async () => {
    await a.client._network(true);

    await waitUntil(() => b.rec.findRemote('sales', (e) => e.upserts.some((d) => d.id === offlineSaleId)), { timeout: 10000, label: 'client B to receive the sale queued while A was offline' });
    await waitUntil(() => a.client.status() === 'synced', { timeout: 10000, label: "client A status to settle to 'synced' once its queued commit is acked" });
  });

  // ---------------------------------------------------------------------
  // firstSync merge cases (fresh account so nothing above interferes).
  // ---------------------------------------------------------------------
  const mergeEmail = uniqueEmail('merge');
  const c = newClient(); // "device 1": first ever login, cloud is empty
  const d = newClient(); // "device 2": logs in later, already has local-only data

  const p1Id = Date.now() + 1000;
  const p2Id = Date.now() + 2000;

  await step('firstSync: cloud empty uploads all local data unchanged', async () => {
    const su = await c.client.signUp(mergeEmail, password);
    assert.equal(su.ok, true, JSON.stringify(su));
    await waitUntil(() => c.client.currentUser() !== null, { label: 'client C auth state to settle' });

    const local = sampleSnapshot({ products: [{ id: p1Id, name: 'Local-C', costPrice: 100, salePrice: 200, stock: 5, unit: 'u', category: 'General', image: null, offers: [], gramStep: 250 }] });
    const merged = await c.client.firstSync(local);
    assert.equal(merged.products.length, 1);
    assert.equal(merged.products[0].name, 'Local-C');
  });

  await step('firstSync: both non-empty unions by id, remote wins on conflicts, local-only gets uploaded', async () => {
    const si = await d.client.signIn(mergeEmail, password);
    assert.equal(si.ok, true, JSON.stringify(si));
    await waitUntil(() => d.client.currentUser() !== null, { label: 'client D auth state to settle' });

    const local = sampleSnapshot({
      products: [
        { id: p1Id, name: 'Local-D-conflict', costPrice: 999, salePrice: 1999, stock: 99, unit: 'u', category: 'General', image: null, offers: [], gramStep: 250 }, // conflicts with cloud's p1
        { id: p2Id, name: 'Local-D-only', costPrice: 50, salePrice: 90, stock: 2, unit: 'u', category: 'General', image: null, offers: [], gramStep: 250 }, // local-only
      ],
    });
    const merged = await d.client.firstSync(local);
    const byId = Object.fromEntries(merged.products.map((p) => [p.id, p]));
    assert.equal(byId[p1Id].name, 'Local-C', 'remote should win on the conflicting id');
    assert.equal(byId[p2Id].name, 'Local-D-only', 'local-only product must survive the merge');
  });

  // ---------------------------------------------------------------------
  // Rules check: a different user must not be able to read this data.
  // ---------------------------------------------------------------------
  await step('firestore rules: another user cannot read the first user\'s data', async () => {
    const intruderEmail = uniqueEmail('intruder');
    const intruderApp = initializeApp(FIREBASE_CONFIG, 'cobral-intruder-' + Math.random().toString(36).slice(2));
    const intruderAuth = initializeAuth(intruderApp, { persistence: inMemoryPersistence });
    connectAuthEmulator(intruderAuth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
    const intruderDb = initializeFirestore(intruderApp, { localCache: memoryLocalCache() });
    connectFirestoreEmulator(intruderDb, EMULATOR_HOST, 8080);

    // createUserWithEmailAndPassword isn't imported twice on purpose; sign in via a fresh signUp
    // using the auth module already imported at top-level would collide on the app instance, so
    // we reuse signInWithEmailAndPassword after creating the account through client `a` style API
    // is unnecessary here — use the auth SDK directly against this isolated app instance.
    const { createUserWithEmailAndPassword } = await import('firebase/auth');
    await createUserWithEmailAndPassword(intruderAuth, intruderEmail, password);
    await waitUntil(() => intruderAuth.currentUser !== null, { label: 'intruder auth state to settle' });

    const victimUid = a.client.currentUser().uid;
    let denied = false;
    try {
      await getDoc(doc(intruderDb, 'users', victimUid, 'meta', 'settings'));
    } catch (err) {
      denied = err && (err.code === 'permission-denied' || /insufficient permissions/i.test(err.message || ''));
      if (!denied) throw err;
    }
    assert.equal(denied, true, 'reading another user\'s data must be denied by firestore.rules');

    await deleteApp(intruderApp);
  });

  // ---------------------------------------------------------------------
  // B4: three-way stock merge (COBRAL_SLICES.md "Stock merge by deltas").
  // This harness re-implements, byte-for-byte, the same merge formula www/index.html's
  // applyRemoteChange() uses for collection 'products': if the local product exists and the
  // incoming upsert carries a numeric _baseStock, merged.stock = upsert.stock + (local.stock -
  // upsert._baseStock); otherwise (new product, or base unknown) take the remote doc as-is.
  // ---------------------------------------------------------------------

  function applyRemoteMergeLikeApp(localState, change) {
    if (change.collection !== 'products') return;
    const arr = localState.products;
    for (const doc of change.upserts) {
      const i = arr.findIndex((p) => p.id === doc.id);
      const merged = { ...doc };
      const hasBase = typeof doc._baseStock === 'number';
      delete merged._baseStock;
      if (i >= 0 && hasBase) merged.stock = doc.stock + (arr[i].stock - doc._baseStock);
      if (i >= 0) arr[i] = merged; else arr.push(merged);
    }
    for (const id of change.deletes || []) {
      const i = arr.findIndex((p) => p.id === id);
      if (i >= 0) arr.splice(i, 1);
    }
  }

  function snapshotFromState(localState) {
    return sampleSnapshot({ products: localState.products });
  }

  // A tiny "app loop" stand-in: processes every NEW 'products' event touching `productId`
  // recorded on `clientObj.rec` since `cursor.i`, merging + re-pushing exactly like
  // onCloudRemote -> applyRemoteChange -> finishRemoteApply -> saveData() would in the app.
  // Safe to call repeatedly (e.g. from inside a waitUntil poll): already-seen events are never
  // reprocessed because `cursor.i` only advances forward.
  function processNewProductEvents(clientObj, productId, cursor) {
    let n = 0;
    while (cursor.i < clientObj.rec.remoteEvents.length) {
      const ev = clientObj.rec.remoteEvents[cursor.i++];
      if (ev.collection === 'products' && ev.upserts.some((d) => d.id === productId)) {
        applyRemoteMergeLikeApp(clientObj.state, ev);
        clientObj.client.push(snapshotFromState(clientObj.state));
        n++;
      }
    }
    return n;
  }

  const stockEmail = uniqueEmail('stock');
  const g = newClient(); // "device A" for the stock-merge scenario
  const h = newClient(); // "device B"
  const stockProductId = Date.now() + 3000;
  const gCursor = { i: 0 };
  const hCursor = { i: 0 };

  await step('B4 setup: two devices converge on one product starting at stock 10', async () => {
    const su = await g.client.signUp(stockEmail, password);
    assert.equal(su.ok, true, JSON.stringify(su));
    await waitUntil(() => g.client.currentUser() !== null, { label: 'device A auth state to settle' });
    const mergedG = await g.client.firstSync(sampleSnapshot({
      products: [{ id: stockProductId, name: 'Stock item', costPrice: 100, salePrice: 200, stock: 10, unit: 'u', category: 'General', image: null, offers: [], gramStep: 250 }],
    }));
    g.state = { products: mergedG.products.map((p) => ({ ...p })) };
    // firstSync's upload is fire-and-forget (offline-first: it doesn't await the server ack).
    // Wait for it to actually land before device B reads the cloud, otherwise B's firstSync()
    // (a one-shot getDocs) can race ahead of A's write and see an empty products collection.
    await waitUntil(() => g.client.status() === 'synced', { timeout: 10000, label: "device A's initial upload to be acked before device B signs in" });

    const si = await h.client.signIn(stockEmail, password);
    assert.equal(si.ok, true, JSON.stringify(si));
    await waitUntil(() => h.client.currentUser() !== null, { label: 'device B auth state to settle' });
    const mergedH = await h.client.firstSync(sampleSnapshot());
    h.state = { products: mergedH.products.map((p) => ({ ...p })) };
    assert.equal(h.state.products.find((p) => p.id === stockProductId).stock, 10, 'device B must start from the same cloud stock');

    // Let any in-flight onSnapshot listener noise from the firstSync race settle before we start
    // counting events, so the concurrent-decrement step below only sees the events it triggers.
    await sleep(500);
    gCursor.i = g.rec.remoteEvents.length;
    hCursor.i = h.rec.remoteEvents.length;
  });

  // The concurrency pattern that matters here is exactly the one from the bug report: device B's
  // sale finishes (decrement + push) while device A's own sale (a separate, independent -2) is
  // still open. Neither device has SEEN the other's change before it pushes its own raw local
  // value: B pushes without ever knowing about A, and A's own push (its raw, unmerged -2) is
  // dispatched before A folds in B's update — exactly mirroring www/index.html's payment flow
  // (saveData() runs before flushPendingRemote(), see line ~1492). The critical correctness
  // detail (and the reason this bug existed) is _timing_ of when `_baseStock` gets captured: it
  // must be frozen at the moment the module's onSnapshot listener processes the incoming remote
  // doc — i.e. BEFORE device A's own push has a chance to advance its shadowStock — not
  // recomputed later when the app finally gets around to applying the queued change. If A's own
  // push observes/advances its shadow first, the base is lost and the merge degenerates into
  // last-write-wins (the very bug B4 fixes). So this harness captures A's queued event the
  // instant it arrives, exactly like state.pendingRemote does in the app.
  await step("B4: device B sells 1 and pushes; device A's own sale (sells 2) is still open, so it observes and queues B's update", async () => {
    h.state.products.find((p) => p.id === stockProductId).stock -= 1; // B's local decrement, pushed immediately (a clean, fast sale)
    h.client.push(snapshotFromState(h.state));

    g.state.products.find((p) => p.id === stockProductId).stock -= 2; // A's local decrement, reserved but NOT pushed yet (sale still open)

    const queued = await waitUntil(() => {
      return g.rec.remoteEvents.slice(gCursor.i).find((e) => e.collection === 'products' && e.upserts.some((d) => d.id === stockProductId));
    }, { timeout: 8000, label: "device A to observe (and queue) device B's push while its own sale is open" });
    gCursor.i = g.rec.remoteEvents.indexOf(queued) + 1;
    assert.equal(queued.upserts.find((d) => d.id === stockProductId)._baseStock, 10, "the queued event's _baseStock must be frozen at the pre-sale cloud value (10), captured before device A's own push ever touches its shadow");
    g.queuedRemote = queued; // mirrors state.pendingRemote in www/index.html
  });

  await step('B4: device A completes its sale (pushes the raw, unmerged local decrement first — exactly like saveData() before flushPendingRemote())', async () => {
    g.client.push(snapshotFromState(g.state)); // pushes A's raw local stock (8), momentarily clobbering B's 9 in Firestore
    await waitUntil(() => g.client.status() === 'synced', { timeout: 10000, label: "device A's raw sale push to be acked" });
  });

  await step('B4: device A applies the queued merge (flushPendingRemote-equivalent) and pushes the correction; both devices converge to 7', async () => {
    applyRemoteMergeLikeApp(g.state, g.queuedRemote);
    assert.equal(g.state.products.find((p) => p.id === stockProductId).stock, 7, 'device A must merge to base(10) - a(2) - b(1) = 7');
    g.client.push(snapshotFromState(g.state)); // finishRemoteApply()'s saveData(), pushing the corrected value

    await waitUntil(() => {
      processNewProductEvents(h, stockProductId, hCursor);
      return h.state.products.find((p) => p.id === stockProductId).stock === 7;
    }, { timeout: 10000, label: "device B to receive device A's correction and converge to 7" });
  });

  await step('B4: both devices converge to 7 in Firestore too (drain cross-echoes to quiescence)', async () => {
    await waitUntil(() => {
      const processed = processNewProductEvents(g, stockProductId, gCursor) + processNewProductEvents(h, stockProductId, hCursor);
      return processed === 0 && g.client.status() === 'synced' && h.client.status() === 'synced';
    }, { timeout: 10000, label: 'stock merge to quiesce with both devices synced' });
    assert.equal(g.state.products.find((p) => p.id === stockProductId).stock, 7);
    assert.equal(h.state.products.find((p) => p.id === stockProductId).stock, 7);
  });

  await step('B4: a remote update with no local change yields exactly the remote value (no double counting)', async () => {
    g.state.products.find((p) => p.id === stockProductId).stock = 20; // e.g. a restock, no concurrent local change on B
    g.client.push(snapshotFromState(g.state));
    await waitUntil(() => {
      const processed = processNewProductEvents(h, stockProductId, hCursor);
      return processed > 0;
    }, { timeout: 8000, label: 'device B to receive the restock' });
    assert.equal(h.state.products.find((p) => p.id === stockProductId).stock, 20, 'no local delta on B means the merge must equal the remote value exactly');

    await waitUntil(() => {
      const processed = processNewProductEvents(g, stockProductId, gCursor) + processNewProductEvents(h, stockProductId, hCursor);
      return processed === 0 && g.client.status() === 'synced' && h.client.status() === 'synced';
    }, { timeout: 10000, label: 'restock to quiesce with both devices synced' });
  });

  await step('B4: after convergence, no further writes ping-pong (write counters stay flat for 5s)', async () => {
    const gBefore = g.client._debugStats().writesDispatched;
    const hBefore = h.client._debugStats().writesDispatched;
    await sleep(5000);
    assert.equal(processNewProductEvents(g, stockProductId, gCursor), 0, 'no new remote product events should have arrived for device A');
    assert.equal(processNewProductEvents(h, stockProductId, hCursor), 0, 'no new remote product events should have arrived for device B');
    assert.equal(g.client._debugStats().writesDispatched, gBefore, 'device A must not keep pushing once converged');
    assert.equal(h.client._debugStats().writesDispatched, hBefore, 'device B must not keep pushing once converged');
    assert.equal(g.state.products.find((p) => p.id === stockProductId).stock, 20);
    assert.equal(h.state.products.find((p) => p.id === stockProductId).stock, 20);
  });

  // ---------------------------------------------------------------------
  await a.client.signOut();
  await b.client.signOut();
  await c.client.signOut();
  await d.client.signOut();
  await g.client.signOut();
  await h.client.signOut();
}

main()
  .then(() => {
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} steps passed`);
    process.exit(0);
  })
  .catch(() => {
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} steps passed`);
    process.exit(1);
  });
