// cloud-src/cobral-cloud.js
//
// Cobral's Firebase cloud-sync module. Bundled by `npm run build:cloud` (esbuild, IIFE, minified,
// target es2019) into www/cloud/cobral-cloud.js — a classic <script> that sets window.CobralCloud.
// No CDN anywhere: everything ships inside the bundle so the Capacitor APK boots offline.
//
// ============================================================================================
// PUBLIC API  (window.CobralCloud in the browser bundle; `createClient()` named export in Node)
// ============================================================================================
//
//   init({ config, onUser, onRemote, onStatus, emulatorHost })
//     - config: the Firebase web config object (window.COBRAL_FIREBASE_CONFIG).
//     - onUser(user|null): called on every auth state change. `user` is the raw firebase User
//       (or null when signed out). Read user.uid / user.email from it as needed.
//     - onRemote({ collection, upserts, deletes }): called when OTHER devices (or the server)
//       change data. `collection` is one of 'sales' | 'products' | 'debts' | 'debtHistory' |
//       'settings'. `upserts` is an array of plain app docs (no "_"-prefixed sync fields).
//       `deletes` is an array of ids (numbers) to remove locally. Local echoes of this device's
//       own writes are filtered out already — never re-push what you receive here.
//     - onStatus(status): called whenever status() changes. One of:
//       'signed-out' | 'offline' | 'pending' | 'synced' | 'error'.
//     - emulatorHost (optional): '10.0.2.2' | '127.0.0.1' | etc. When set (or when
//       localStorage.getItem('cobralEmulatorHost') is set), Auth and Firestore connect to the
//       local emulators (ports 9099 / 8080) instead of production.
//     Returns nothing; callbacks fire asynchronously as Firebase initializes.
//
//   signIn(email, pass) -> Promise<{ ok:true, user } | { ok:false, message }>
//   signUp(email, pass) -> Promise<{ ok:true, user } | { ok:false, message }>
//   signOut() -> Promise<void>
//   resetPassword(email) -> Promise<{ ok:true } | { ok:false, message }>
//     `message` is a short Chilean-Spanish string suitable for direct display in the UI.
//
//   currentUser() -> the current firebase User, or null.
//
//   push(snapshot)
//     Fire-and-forget. Debounces ~1.5s, diffs `snapshot` against the per-uid shadow, and writes
//     only the changed docs in batches of <= 450 ops. Safe to call on every saveData().
//     snapshot shape:
//       {
//         sales: Array<{id:number, ...}>, products: Array<{id:number, ...}>,
//         debts: Array<{id:number, ...}>, debtHistory: Array<{id:number, ...}>,
//         settings: { categories, locations, userName, debitFee, creditFee, soundEnabled, darkMode }
//       }
//     (this is exactly the shape saveData() already persists, minus `image`/`userPhoto` — photos
//     stay device-local in this phase).
//
//   firstSync(localSnapshot) -> Promise<mergedSnapshot>
//     Call once, right after a successful sign-in/sign-up on a device that may already have local
//     data. Reads the cloud, merges (cloud empty -> upload everything; both non-empty -> union by
//     id, remote wins on conflicts, local-only docs get uploaded), and returns the merged
//     snapshot for the caller to load into `state` + localStorage. Also updates the shadow so a
//     subsequent push() only sends further changes.
//
//   status() -> 'signed-out' | 'offline' | 'pending' | 'synced' | 'error'
//
// Data model on the wire: users/{uid}/{sales|products|debts|debtHistory}/{String(id)} and
// users/{uid}/meta/settings. Every doc carries _updatedAt (serverTimestamp), _deleted (bool,
// tombstone) and _device (random id, persisted in localStorage) — last write wins per document.
// ============================================================================================

import { initializeApp } from 'firebase/app';
import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  inMemoryPersistence,
  connectAuthEmulator,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  sendPasswordResetEmail,
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
  connectFirestoreEmulator,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';
import {
  COLLECTIONS,
  diff,
  isDiffEmpty,
  mergeFirstSync,
  toRemoteData,
  toTombstone,
  fromRemoteDoc,
  hashDoc,
  coerceId,
  buildShadowFromSnapshot,
  updateShadowForCollection,
  updateShadowSettings,
  emptyShadow,
} from './sync-core.js';

const MAX_BATCH_OPS = 450;
const PUSH_DEBOUNCE_MS = 1500;

function hasIndexedDB() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch (e) {
    return false;
  }
}

function hasLocalStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch (e) {
    return false;
  }
}

/** Tiny storage abstraction so multiple independent clients (e.g. in tools/cloud-e2e.mjs) don't
 *  collide when there is no real localStorage (Node). In the browser there is only ever one
 *  CobralCloud instance, so it simply wraps the real localStorage. */
function makeStore() {
  if (hasLocalStorage()) {
    return {
      get(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
      },
      set(key, val) {
        try { localStorage.setItem(key, val); } catch (e) { /* ignore (quota / private mode) */ }
      },
    };
  }
  const mem = new Map();
  return {
    get(key) { return mem.has(key) ? mem.get(key) : null; },
    set(key, val) { mem.set(key, val); },
  };
}

function randomDeviceId() {
  return 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Auth error mapping (short Chilean Spanish messages)
// ---------------------------------------------------------------------------

function mapAuthError(err) {
  const code = (err && err.code) || '';
  switch (code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
      return 'Correo o contraseña incorrectos';
    case 'auth/email-already-in-use':
      return 'Ese correo ya tiene una cuenta';
    case 'auth/weak-password':
      return 'La contraseña debe tener al menos 6 caracteres';
    case 'auth/network-request-failed':
      return 'Sin conexión. Intenta de nuevo.';
    case 'auth/too-many-requests':
      return 'Demasiados intentos. Espera un momento e intenta de nuevo.';
    case 'auth/invalid-email':
      return 'Correo inválido';
    default:
      return 'No se pudo completar la operación. Intenta de nuevo.';
  }
}

// ---------------------------------------------------------------------------
// Client factory. The browser bundle instantiates exactly one of these as
// window.CobralCloud. Node (unit/e2e tests) can create several independent
// instances by calling createClient() more than once.
// ---------------------------------------------------------------------------

export function createClient() {
  const store = makeStore();

  let app = null;
  let auth = null;
  let db = null;
  let device = null;

  let onUserCb = () => {};
  let onRemoteCb = () => {};
  let onStatusCb = () => {};

  let currentStatus = 'signed-out';
  let currentUid = null;
  let shadow = emptyShadow();

  let unsubscribers = []; // firestore onSnapshot unsubscribes for the current user
  let authUnsub = null;

  let pendingSnapshot = null;
  let debounceTimer = null;
  let onlineRetryArmed = false;

  function setStatus(next) {
    if (next === currentStatus) return;
    currentStatus = next;
    try { onStatusCb(currentStatus); } catch (e) { /* caller's problem */ }
  }

  function shadowKey(uid) {
    return 'cobralCloudShadow:' + uid;
  }

  function loadShadow(uid) {
    const raw = store.get(shadowKey(uid));
    if (!raw) return emptyShadow();
    try {
      const parsed = JSON.parse(raw);
      return { ...emptyShadow(), ...parsed };
    } catch (e) {
      return emptyShadow();
    }
  }

  function persistShadow(uid) {
    try { store.set(shadowKey(uid), JSON.stringify(shadow)); } catch (e) { /* ignore */ }
  }

  function collectionRef(uid, col) {
    return collection(db, 'users', uid, col);
  }

  function docRef(uid, col, id) {
    return doc(db, 'users', uid, col, String(id));
  }

  function settingsRef(uid) {
    return doc(db, 'users', uid, 'meta', 'settings');
  }

  // -------------------------------------------------------------------------
  // init()
  // -------------------------------------------------------------------------

  function init(opts) {
    const { config, onUser, onRemote, onStatus, emulatorHost } = opts || {};
    onUserCb = typeof onUser === 'function' ? onUser : () => {};
    onRemoteCb = typeof onRemote === 'function' ? onRemote : () => {};
    onStatusCb = typeof onStatus === 'function' ? onStatus : () => {};

    device = store.get('cobralDeviceId');
    if (!device) {
      device = randomDeviceId();
      store.set('cobralDeviceId', device);
    }

    app = initializeApp(config, 'cobral-' + Math.random().toString(36).slice(2));

    const indexedDbAvailable = hasIndexedDB();
    auth = initializeAuth(app, {
      persistence: indexedDbAvailable ? [indexedDBLocalPersistence, browserLocalPersistence] : inMemoryPersistence,
    });

    db = initializeFirestore(app, {
      localCache: indexedDbAvailable
        ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
        : memoryLocalCache(),
    });

    const emuHost = emulatorHost || (hasLocalStorage() ? (() => {
      try { return localStorage.getItem('cobralEmulatorHost'); } catch (e) { return null; }
    })() : null);
    if (emuHost) {
      connectAuthEmulator(auth, 'http://' + emuHost + ':9099', { disableWarnings: true });
      connectFirestoreEmulator(db, emuHost, 8080);
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', () => {
        if (pendingSnapshot) scheduleFlush(0);
      });
    }

    authUnsub = onAuthStateChanged(auth, (user) => {
      detachListeners();
      if (user) {
        currentUid = user.uid;
        shadow = loadShadow(currentUid);
        attachListeners(currentUid);
        setStatus('synced');
      } else {
        currentUid = null;
        shadow = emptyShadow();
        setStatus('signed-out');
      }
      try { onUserCb(user); } catch (e) { /* caller's problem */ }
    });
  }

  // -------------------------------------------------------------------------
  // Remote listeners (feed onRemote; keep shadow in sync so we never push back
  // what we just received)
  // -------------------------------------------------------------------------

  function detachListeners() {
    for (const unsub of unsubscribers) {
      try { unsub(); } catch (e) { /* ignore */ }
    }
    unsubscribers = [];
  }

  function attachListeners(uid) {
    for (const col of COLLECTIONS) {
      const unsub = onSnapshot(collectionRef(uid, col), { includeMetadataChanges: true }, (snap) => {
        const upserts = [];
        const deletes = [];
        for (const change of snap.docChanges()) {
          if (change.doc.metadata.hasPendingWrites) continue; // our own write, not yet acked
          const data = change.doc.data();
          if (data && data._device === device) continue; // our own device's acked echo
          const idStr = change.doc.id;
          if (data && data._deleted) {
            if (shadow[col] && idStr in shadow[col]) deletes.push(coerceId(idStr));
          } else {
            const clean = fromRemoteDoc(data);
            const h = hashDoc(clean);
            if ((shadow[col] || {})[idStr] !== h) upserts.push(clean);
          }
        }
        if (!upserts.length && !deletes.length) return;
        shadow = updateShadowForCollection(shadow, col, upserts, deletes);
        persistShadow(uid);
        try { onRemoteCb({ collection: col, upserts, deletes }); } catch (e) { /* caller's problem */ }
      }, (err) => {
        setStatus(err && err.code === 'unavailable' ? 'offline' : 'error');
      });
      unsubscribers.push(unsub);
    }

    const unsubSettings = onSnapshot(settingsRef(uid), { includeMetadataChanges: true }, (snap) => {
      if (!snap.exists()) return;
      if (snap.metadata.hasPendingWrites) return;
      const data = snap.data();
      if (data && data._device === device) return;
      const clean = fromRemoteDoc(data);
      const h = hashDoc(clean);
      if (shadow.settings === h) return;
      shadow = updateShadowSettings(shadow, clean);
      persistShadow(uid);
      try { onRemoteCb({ collection: 'settings', upserts: [clean], deletes: [] }); } catch (e) { /* caller's problem */ }
    }, (err) => {
      setStatus(err && err.code === 'unavailable' ? 'offline' : 'error');
    });
    unsubscribers.push(unsubSettings);
  }

  // -------------------------------------------------------------------------
  // push() — debounced diff + batched write
  // -------------------------------------------------------------------------

  function scheduleFlush(delayMs) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { flushPush(); }, delayMs);
  }

  function push(snapshot) {
    if (!currentUid) return; // signed out: nothing to sync to
    pendingSnapshot = snapshot;
    setStatus('pending');
    scheduleFlush(PUSH_DEBOUNCE_MS);
  }

  async function writeOpsInBatches(uid, ops) {
    for (let i = 0; i < ops.length; i += MAX_BATCH_OPS) {
      const batch = writeBatch(db);
      for (const op of ops.slice(i, i + MAX_BATCH_OPS)) batch.set(op.ref, op.data);
      await batch.commit();
    }
  }

  function buildOpsFromDiff(uid, changes) {
    const ops = [];
    for (const col of COLLECTIONS) {
      for (const d of changes[col].upserts) {
        ops.push({ ref: docRef(uid, col, d.id), data: { ...toRemoteData(d, device), _updatedAt: serverTimestamp() } });
      }
      for (const id of changes[col].deletes) {
        ops.push({ ref: docRef(uid, col, id), data: { ...toTombstone(id, device), _updatedAt: serverTimestamp() } });
      }
    }
    if (changes.settings.upsert) {
      ops.push({ ref: settingsRef(uid), data: { ...toRemoteData(changes.settings.upsert, device), _updatedAt: serverTimestamp() } });
    }
    return ops;
  }

  function applyDiffToShadow(changes) {
    for (const col of COLLECTIONS) {
      shadow = updateShadowForCollection(shadow, col, changes[col].upserts, changes[col].deletes);
    }
    if (changes.settings.upsert) shadow = updateShadowSettings(shadow, changes.settings.upsert);
  }

  async function flushPush() {
    debounceTimer = null;
    if (!currentUid || !pendingSnapshot) return;
    const uid = currentUid;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;

    const changes = diff(shadow, snapshot);
    if (isDiffEmpty(changes)) { setStatus('synced'); return; }

    const ops = buildOpsFromDiff(uid, changes);
    try {
      await writeOpsInBatches(uid, ops);
      applyDiffToShadow(changes);
      persistShadow(uid);
      setStatus('synced');
    } catch (err) {
      pendingSnapshot = snapshot; // keep it queued so a later push()/online event retries
      if (err && (err.code === 'unavailable' || err.code === 'failed-precondition')) {
        setStatus('offline');
      } else {
        setStatus('error');
      }
    }
  }

  // -------------------------------------------------------------------------
  // firstSync() — one-time merge on first login on a device
  // -------------------------------------------------------------------------

  async function fetchRemoteSnapshot(uid) {
    const remote = { sales: [], products: [], debts: [], debtHistory: [], settings: null };
    for (const col of COLLECTIONS) {
      const snap = await getDocs(collectionRef(uid, col));
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        if (data && data._deleted) return; // tombstones don't participate in the merge
        remote[col].push(fromRemoteDoc(data));
      });
    }
    const settingsSnap = await getDoc(settingsRef(uid));
    if (settingsSnap.exists()) {
      const data = settingsSnap.data();
      if (!(data && data._deleted)) remote.settings = fromRemoteDoc(data);
    }
    return remote;
  }

  async function firstSync(localSnapshot) {
    if (!currentUid) throw new Error('firstSync() requires a signed-in user');
    const uid = currentUid;
    const remote = await fetchRemoteSnapshot(uid);
    const { merged, upload } = mergeFirstSync(localSnapshot, remote);

    const uploadChanges = { settings: { upsert: upload.settings || null } };
    for (const col of COLLECTIONS) uploadChanges[col] = { upserts: upload[col] || [], deletes: [] };

    if (!isDiffEmpty(uploadChanges)) {
      const ops = buildOpsFromDiff(uid, uploadChanges);
      await writeOpsInBatches(uid, ops);
    }

    // The shadow must reflect the FULL merged snapshot (local- and remote-origin docs alike) so
    // the upcoming onSnapshot initial-fetch and the next push() don't re-send anything.
    shadow = buildShadowFromSnapshot(merged);
    persistShadow(uid);
    setStatus('synced');
    return merged;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  async function signIn(email, pass) {
    try {
      const cred = await signInWithEmailAndPassword(auth, email, pass);
      return { ok: true, user: cred.user };
    } catch (err) {
      return { ok: false, message: mapAuthError(err) };
    }
  }

  async function signUp(email, pass) {
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      return { ok: true, user: cred.user };
    } catch (err) {
      return { ok: false, message: mapAuthError(err) };
    }
  }

  async function signOut() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    pendingSnapshot = null;
    await firebaseSignOut(auth);
  }

  async function resetPassword(email) {
    try {
      await sendPasswordResetEmail(auth, email);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: mapAuthError(err) };
    }
  }

  function currentUserFn() {
    return (auth && auth.currentUser) || null;
  }

  function status() {
    return currentStatus;
  }

  return {
    init,
    signIn,
    signUp,
    signOut,
    resetPassword,
    currentUser: currentUserFn,
    push,
    firstSync,
    status,
  };
}

if (typeof window !== 'undefined') {
  window.CobralCloud = createClient();
}
