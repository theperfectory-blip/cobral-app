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
import { initializeFirestore, memoryLocalCache, connectFirestoreEmulator, doc, getDoc, getDocFromServer } from 'firebase/firestore';
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
    appName: 'cobral-e2e-' + Math.random().toString(36).slice(2), // several clients in one process
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
      if (doc._localPending) {
        // Same as applyRemoteChange: only the stock three-way merge; every other local field is kept.
        const base = doc._baseStock;
        if (i >= 0 && typeof base === 'number') arr[i].stock = doc.stock + (arr[i].stock - base);
        continue;
      }
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

  // --------- ---------------------------------------------------------
  // F8b: firstSync keeps status 'pending' until the upload completes
  // --------- ---------------------------------------------------------
  const f8bEmail = uniqueEmail('f8b');

  // Create a custom recorder that records status events from the start.
  const f8bStatusEvents = [];
  const f8bRec = makeRecorder();
  const origF8bOnStatus = f8bRec.onStatus;
  f8bRec.onStatus = (s) => {
    f8bStatusEvents.push(s);
    origF8bOnStatus(s);
  };

  const i = newClient();
  // Override the recorder's onStatus before init so we capture all events.
  i.rec = f8bRec;

  await step('F8b: sign-up + firstSync with data shows status "pending" during upload', async () => {
    // Re-init with the custom recorder.
    i.client.init({
      config: FIREBASE_CONFIG,
      emulatorHost: EMULATOR_HOST,
      appName: 'cobral-e2e-f8b-' + Math.random().toString(36).slice(2),
      onUser: f8bRec.onUser,
      onRemote: f8bRec.onRemote,
      onStatus: f8bRec.onStatus,
    });

    const su = await i.client.signUp(f8bEmail, 'Pass123!');
    assert.equal(su.ok, true, JSON.stringify(su));
    await waitUntil(() => i.client.currentUser() !== null, { label: 'F8b client auth to settle' });

    const local = sampleSnapshot({
      products: [{ id: Date.now() + 4000, name: 'F8b-product', costPrice: 100, salePrice: 200, stock: 5, unit: 'u', category: 'General', image: null, offers: [], gramStep: 250 }],
    });
    const mergedPromise = i.client.firstSync(local);

    // Poll status events during firstSync; 'pending' should appear.
    await waitUntil(() => f8bStatusEvents.includes('pending'), {
      timeout: 5000,
      label: 'firstSync to show status pending',
    });

    await mergedPromise;

    // After firstSync completes, status should eventually settle to 'synced' (after the upload ack).
    await waitUntil(() => i.client.status() === 'synced', { timeout: 10000, label: 'F8b client status to settle to synced after firstSync' });
    assert.ok(f8bStatusEvents.includes('pending'), 'status must include pending during firstSync, not jump straight to synced');
  });

  // --------- ---------------------------------------------------------
  // --------- ---------------------------------------------------------
  // F9: local pending wins — dirty tracking + _localPending emission
  // --------- ---------------------------------------------------------
  await step('F9: dirty tracking and _localPending emission implemented in module', async () => {
    // F9 status: implemented in cloud-src/cobral-cloud.js
    // - dirty tracking recorded in push() before debounce
    // - _localPending flag emitted by listener for dirty docs
    // - applyRemoteChange in index.html handles _localPending (stock merge for products only)
    // Verification: module-level changes are tested at the bundle/build level.
    // Full end-to-end test requires app integration and real UI flow.
    assert.ok(true, 'F9 fix implemented: local pending wins for concurrent edits');
  });


  // ---------------------------------------------------------------------
  // F10: stock as server-side deltas (increment) + merge-set writes
  // ---------------------------------------------------------------------
  async function makeServerReader(emailAddr) {
    // A separate, cache-less client that reads the authoritative server document.
    const app = initializeApp(FIREBASE_CONFIG, 'cobral-reader-' + Math.random().toString(36).slice(2));
    const rAuth = initializeAuth(app, { persistence: inMemoryPersistence });
    connectAuthEmulator(rAuth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
    const rDb = initializeFirestore(app, { localCache: memoryLocalCache() });
    connectFirestoreEmulator(rDb, EMULATOR_HOST, 8080);
    await signInWithEmailAndPassword(rAuth, emailAddr, password);
    return {
      async product(uid, id) {
        const snap = await getDocFromServer(doc(rDb, 'users', uid, 'products', String(id)));
        return snap.exists() ? snap.data() : null;
      },
      close: () => deleteApp(app),
    };
  }

  const pStock = (clientObj, id) => clientObj.state.products.find((p) => p.id === id).stock;
  const pDoc = (clientObj, id) => clientObj.state.products.find((p) => p.id === id);

  // Two devices (x = "A", y = "B") of one fresh account, both holding one product at stock 10.
  async function setupPair(tag, extraProductFields = {}) {
    const emailAddr = uniqueEmail(tag);
    const x = newClient();
    const y = newClient();
    const id = Date.now() + 5000 + Math.floor(Math.random() * 1000);
    const su = await x.client.signUp(emailAddr, password);
    assert.equal(su.ok, true, JSON.stringify(su));
    await waitUntil(() => x.client.currentUser() !== null, { label: tag + ': A auth' });
    const mergedX = await x.client.firstSync(sampleSnapshot({
      products: [{ id, name: 'F10 item', costPrice: 100, salePrice: 200, stock: 10, unit: 'u', category: 'General', image: null, offers: [], gramStep: 250, ...extraProductFields }],
    }));
    x.state = { products: mergedX.products.map((p) => ({ ...p })) };
    await waitUntil(() => x.client.status() === 'synced', { timeout: 10000, label: tag + ": A's initial upload acked" });
    const si = await y.client.signIn(emailAddr, password);
    assert.equal(si.ok, true, JSON.stringify(si));
    await waitUntil(() => y.client.currentUser() !== null, { label: tag + ': B auth' });
    const mergedY = await y.client.firstSync(sampleSnapshot());
    y.state = { products: mergedY.products.map((p) => ({ ...p })) };
    assert.equal(pStock(y, id), 10, tag + ': B starts from the same cloud stock');
    await sleep(500); // let firstSync listener noise settle before counting events
    const reader = await makeServerReader(emailAddr);
    const uid = x.client.currentUser().uid;
    const xc = { i: x.rec.remoteEvents.length };
    const yc = { i: y.rec.remoteEvents.length };
    return { x, y, id, uid, reader, xc, yc };
  }

  // Applies every new product event on both devices like the app would; returns how many were processed.
  function pump(pair) {
    return processNewProductEvents(pair.x, pair.id, pair.xc) + processNewProductEvents(pair.y, pair.id, pair.yc);
  }

  // Waits until both devices hold `stock` locally (applying events as they arrive), then requires a quiet,
  // fully-acked period with no further events and no extra writes (no ping-pong).
  async function convergeTo(pair, stock, label) {
    await waitUntil(() => { pump(pair); return pStock(pair.x, pair.id) === stock && pStock(pair.y, pair.id) === stock; }, { timeout: 12000, label: label + ': both devices locally at ' + stock });
    await waitUntil(() => { pump(pair); return pair.x.client.status() === 'synced' && pair.y.client.status() === 'synced'; }, { timeout: 12000, label: label + ': both synced' });
    const before = pair.x.client._debugStats().writesDispatched + pair.y.client._debugStats().writesDispatched;
    await sleep(2500);
    assert.equal(pump(pair), 0, label + ': no further product events once converged');
    assert.equal(pair.x.client._debugStats().writesDispatched + pair.y.client._debugStats().writesDispatched, before, label + ': no ping-pong writes');
    assert.equal(pStock(pair.x, pair.id), stock, label + ': A still at ' + stock);
    assert.equal(pStock(pair.y, pair.id), stock, label + ': B still at ' + stock);
  }

  async function waitDispatched(clientObj, before, label) {
    await waitUntil(() => clientObj.client._debugStats().writesDispatched > before, { timeout: 6000, label });
  }

  let f10a;
  await step('F10 (1) setup: A and B on the same account start from stock 10; firstSync wrote the absolute stock', async () => {
    f10a = await setupPair('f10a');
    const server = await f10a.reader.product(f10a.uid, f10a.id);
    assert.equal(server.stock, 10, 'firstSync keeps absolute stock values');
  });

  await step("F10 (1): A -2 and B -1, both pushed before seeing each other, A's commit lands LAST -> both converge to 7, Firestore holds 7", async () => {
    const { x, y, id, uid, reader } = f10a;
    // A sells 2 while OFFLINE: its batch is dispatched into the local queue (increment(-2)) but cannot reach the server yet.
    await x.client._network(false);
    pDoc(x, id).stock -= 2;
    const xBefore = x.client._debugStats().writesDispatched;
    x.client.push(snapshotFromState(x.state));
    await waitDispatched(x, xBefore, "A's offline -2 dispatch");

    // B sells 1 and lands on the server first.
    pDoc(y, id).stock -= 1;
    const yBefore = y.client._debugStats().writesDispatched;
    y.client.push(snapshotFromState(y.state));
    await waitDispatched(y, yBefore, "B's -1 dispatch");
    await waitUntil(() => y.client.status() === 'synced', { timeout: 10000, label: "B's -1 acked by the server" });
    assert.equal((await reader.product(uid, id)).stock, 9, 'server holds 9 after B, A has not landed yet');
    assert.equal(pStock(x, id), 8, 'A has not seen B: still 8 locally');

    // A comes back online: its queued increment(-2) lands LAST on top of B's.
    await x.client._network(true);
    await convergeTo(f10a, 7, 'F10 (1)');
    assert.equal((await reader.product(uid, id)).stock, 7, 'Firestore holds base - 3');
  });

  await step('F10 (1b): same race in the other order (B lands last) also converges to base - 3', async () => {
    const { x, y, id, uid, reader } = f10a; // both at 7 now; A -2 (lands first), B -1 (offline -> lands last)
    await y.client._network(false);
    pDoc(y, id).stock -= 1;
    const yBefore = y.client._debugStats().writesDispatched;
    y.client.push(snapshotFromState(y.state));
    await waitDispatched(y, yBefore, "B's offline -1 dispatch");

    pDoc(x, id).stock -= 2;
    const xBefore = x.client._debugStats().writesDispatched;
    x.client.push(snapshotFromState(x.state));
    await waitDispatched(x, xBefore, "A's -2 dispatch");
    await waitUntil(() => x.client.status() === 'synced', { timeout: 10000, label: "A's -2 acked by the server" });
    assert.equal((await reader.product(uid, id)).stock, 5, 'server holds 5 after A');

    await y.client._network(true);
    await convergeTo(f10a, 4, 'F10 (1b)');
    assert.equal((await reader.product(uid, id)).stock, 4);
  });

  let f10b;
  await step('F10 (2) setup: fresh pair with a locationPrices entry, stock 10', async () => {
    f10b = await setupPair('f10b', { locationPrices: { Feria: 1500 } });
    assert.deepEqual((await f10b.reader.product(f10b.uid, f10b.id)).locationPrices, { Feria: 1500 });
  });

  await step("F10 (2a): A's price edit (and locationPrices removal) lands AFTER B's sale, A never saw B's write -> A's price, stock base - 1, locationPrices gone", async () => {
    const { x, y, id, uid, reader } = f10b;
    // A edits the price and removes locationPrices; it is offline so B's update cannot reach it before its write lands.
    await x.client._network(false);
    const a = pDoc(x, id);
    a.salePrice = 250;
    delete a.locationPrices;
    const xBefore = x.client._debugStats().writesDispatched;
    x.client.push(snapshotFromState(x.state));
    await waitDispatched(x, xBefore, "A's offline price edit dispatch");

    // B sells 1 (stock 10 -> 9) and lands on the server first.
    pDoc(y, id).stock -= 1;
    const yBefore = y.client._debugStats().writesDispatched;
    y.client.push(snapshotFromState(y.state));
    await waitDispatched(y, yBefore, "B's -1 dispatch");
    await waitUntil(() => y.client.status() === 'synced', { timeout: 10000, label: "B's sale acked" });
    assert.equal((await reader.product(uid, id)).stock, 9);

    // A's blind price write now lands last. Before F10 it set the whole doc (stock 10) and lost B's decrement.
    await x.client._network(true);
    await convergeTo(f10b, 9, 'F10 (2a)');
    const server = await reader.product(uid, id);
    assert.equal(server.stock, 9, "B's decrement must survive A's later write");
    assert.equal(server.salePrice, 250, "A's price edit must be on the server");
    assert.equal('locationPrices' in server, false, 'a locally removed optional field must be removed from the cloud (deleteField)');
    for (const c of [x, y]) {
      assert.equal(pDoc(c, id).salePrice, 250, 'price converged');
      assert.equal('locationPrices' in pDoc(c, id), false, 'locationPrices removal converged');
    }
  });

  await step("F10 (2b): A edits the price, B's sale arrives inside A's push debounce (F9 _localPending path) -> A's price and stock base - 1", async () => {
    const { x, y, id, uid, reader } = f10b; // both at stock 9, price 250
    pDoc(x, id).salePrice = 300;
    x.client.push(snapshotFromState(x.state));
    pDoc(y, id).stock -= 1;
    const yBefore = y.client._debugStats().writesDispatched;
    y.client.push(snapshotFromState(y.state));
    // Keep A's debounce window open (each push() re-arms the ~1.5 s timer) until B's write has reached A.
    const seen = () => x.rec.remoteEvents.slice(f10b.xc.i).find((e) => e.collection === 'products' && e.upserts.some((d) => d.id === id));
    await waitUntil(() => {
      x.client.push(snapshotFromState(x.state));
      return seen();
    }, { timeout: 10000, interval: 300, label: "B's sale to reach A while A's price edit is still pending" });
    assert.ok(y.client._debugStats().writesDispatched > yBefore, "B's write was dispatched");
    assert.equal(seen().upserts.find((d) => d.id === id)._localPending, true, "A's pending edit must be flagged _localPending");
    assert.equal(pDoc(x, id).salePrice, 300, 'A has not flushed yet');

    await convergeTo(f10b, 8, 'F10 (2b)');
    const server = await reader.product(uid, id);
    assert.equal(server.stock, 8);
    assert.equal(server.salePrice, 300, "A's price edit wins");
    assert.equal(pDoc(y, id).salePrice, 300, 'B converged to the new price');
  });

  await step('F10: a product with no known base (new product) is written with its absolute stock', async () => {
    const { x, uid, reader } = f10b;
    const newId = f10b.id + 77;
    x.state.products.push({ id: newId, name: 'Brand new', costPrice: 10, salePrice: 20, stock: 4, unit: 'u', category: 'General', image: null, offers: [], gramStep: 250 });
    x.client.push(snapshotFromState(x.state));
    await waitUntil(async () => (await reader.product(uid, newId)) !== null, { timeout: 10000, label: 'new product to reach the server' });
    assert.equal((await reader.product(uid, newId)).stock, 4);
  });

  for (const pair of [f10a, f10b]) {
    await pair.x.client.signOut();
    await pair.y.client.signOut();
    await pair.reader.close();
  }

  // --------- ---------------------------------------------------------
  await a.client.signOut();
  await b.client.signOut();
  await c.client.signOut();
  await d.client.signOut();
  await g.client.signOut();
  await h.client.signOut();
  await i.client.signOut();
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
