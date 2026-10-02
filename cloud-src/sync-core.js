// cloud-src/sync-core.js
//
// PURE sync logic for Cobral's cloud module. No Firebase imports here on purpose:
// everything in this file is plain data-in/data-out so it can be unit-tested with
// node:test and reused unchanged by cobral-cloud.js (browser) and tools/cloud-e2e.mjs (Node).
//
// Data model reminder (see COBRAL_SLICES.md B2 + www/index.html):
//   snapshot = {
//     sales:        Array<{ id:number, ... }>,
//     products:     Array<{ id:number, ... }>,
//     debts:        Array<{ id:number, ... }>,
//     debtHistory:  Array<{ id:number, ... }>,   // id is inherited from the debt it settles
//     settings:     { categories, locations, userName, debitFee, creditFee, soundEnabled, darkMode } | null
//   }
//   Firestore layout: users/{uid}/{sales|products|debts|debtHistory}/{String(id)}, users/{uid}/meta/settings.
//   Every remote doc also carries sync-only fields prefixed with "_": _updatedAt, _deleted, _device.
//   Those are stripped before hashing/diffing and before handing a doc back to app code.

export const COLLECTIONS = ['sales', 'products', 'debts', 'debtHistory'];

// ---------------------------------------------------------------------------
// Stable stringify + hashing (content fingerprint used to detect real changes)
// ---------------------------------------------------------------------------

/** Deterministic JSON.stringify: object keys are sorted recursively so key order never affects the result. */
export function stableStringify(value) {
  return _stringify(value);
}

function _stringify(value) {
  if (value === undefined) return 'null'; // JSON has no undefined; normalize like JSON.stringify(array) would
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => _stringify(v)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + _stringify(value[k])).join(',') + '}';
}

/** Small, fast, non-cryptographic string hash (FNV-1a, 32-bit) rendered as hex. Good enough for change detection. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Content hash of a document, ignoring sync-only "_"-prefixed fields. */
export function hashDoc(doc) {
  return fnv1a(_stringify(stripSyncFields(doc)));
}

// ---------------------------------------------------------------------------
// Firestore doc <-> app doc mapping (pure; caller adds serverTimestamp())
// ---------------------------------------------------------------------------

/** Removes _updatedAt/_deleted/_device, leaving the plain app-shaped document (including numeric id). */
export function stripSyncFields(data) {
  if (!data || typeof data !== 'object') return data;
  const clean = {};
  for (const k of Object.keys(data)) {
    if (k === '_updatedAt' || k === '_deleted' || k === '_device') continue;
    clean[k] = data[k];
  }
  return clean;
}

/**
 * Builds the data to write for an upsert. Does NOT include _updatedAt — the caller
 * (cobral-cloud.js) stamps that with firebase's serverTimestamp() right before writing,
 * since this module must stay Firebase-free.
 */
export function toRemoteData(localDoc, device) {
  return { ...stripSyncFields(localDoc), _deleted: false, _device: device };
}

/** Builds a tombstone for a deleted id. Same caveat: caller adds _updatedAt. */
export function toTombstone(id, device) {
  return { id: coerceId(id), _deleted: true, _device: device };
}

/** Strips sync-only fields from a doc read back from Firestore, yielding the plain app doc. */
export function fromRemoteDoc(remoteData) {
  return stripSyncFields(remoteData);
}

/** Firestore doc ids are strings; app ids are numeric timestamps. Coerce back when it round-trips cleanly. */
export function coerceId(id) {
  const n = Number(id);
  return Number.isFinite(n) && String(n) === String(id) ? n : id;
}

// ---------------------------------------------------------------------------
// Array <-> id-keyed map helpers
// ---------------------------------------------------------------------------

export function arrayToMap(arr) {
  const map = {};
  for (const doc of arr || []) map[String(doc.id)] = doc;
  return map;
}

export function mapToArray(map) {
  return Object.values(map || {});
}

// ---------------------------------------------------------------------------
// Shadow: per-uid record of what we believe is already synced, as { collection: { id: hash } } + settings hash.
// Persisted by cobral-cloud.js under a per-uid localStorage key; this module only shapes it.
// ---------------------------------------------------------------------------

export function emptyShadow() {
  const shadow = { settings: null, stock: {} };
  for (const col of COLLECTIONS) shadow[col] = {};
  return shadow;
}

/** Extracts { [id]: stock } for products carrying a numeric stock; ignores the rest. Used to seed
 *  shadow.stock (see below) from a full snapshot, e.g. right after firstSync's merge. */
export function stockMapFromProducts(products) {
  const map = {};
  for (const p of products || []) {
    if (p && typeof p.stock === 'number') map[String(p.id)] = p.stock;
  }
  return map;
}

/**
 * Reads `_baseStock` for each product upsert from `shadowStockMap` (shadow.stock, indexed by
 * String(id)), i.e. the last stock value this device knows is in the cloud, BEFORE the update
 * being processed. Attach this to a remote batch of product upserts *before* folding it into the
 * shadow (see cobral-cloud.js onRemote for 'products'), so the app can three-way-merge stock:
 *   merged.stock = upsert.stock + (local.stock - upsert._baseStock)
 * Pure; does not mutate `upserts`. A product with no known shadow stock (new product, or a
 * shadow that predates this feature) gets no `_baseStock` field at all — the app treats that as
 * "unknown base" and simply takes the remote value, same as before this merge existed.
 */
export function attachBaseStock(shadowStockMap, upserts) {
  return (upserts || []).map((doc) => {
    const known = (shadowStockMap || {})[String(doc.id)];
    return typeof known === 'number' ? { ...doc, _baseStock: known } : { ...doc };
  });
}

// ---------------------------------------------------------------------------
// F10: stock as server-side deltas.
// A product whose id has a known shadow.stock[id] (the stock value this device last knew was in the
// cloud) is written with set(..., {merge:true}) + stock: increment(local.stock - shadow.stock[id]),
// so concurrent decrements from several devices add up on the server instead of overwriting each
// other. Products without a known base (new ones, firstSync uploads) keep writing the absolute stock.
// ---------------------------------------------------------------------------

/** Product keys that are optional in the app (may be absent from a local doc). Because a merge-set never
 *  removes fields, a key that is absent locally must be written as deleteField() or the old value would
 *  survive in the cloud and come back on other devices (e.g. removing the last locationPrices entry). */
export const OPTIONAL_PRODUCT_KEYS = ['locationPrices', 'offers', 'gramStep', 'imageUrl'];

/** stock delta vs the shadow base: a number (may be 0) when BOTH the base and doc.stock are finite numbers,
 *  otherwise null ("unknown base" -> caller writes the absolute stock). Pure. */
export function stockDelta(shadowStockMap, doc) {
  if (!doc) return null;
  const known = (shadowStockMap || {})[String(doc.id)];
  if (typeof known !== 'number' || typeof doc.stock !== 'number') return null;
  if (!Number.isFinite(known) || !Number.isFinite(doc.stock)) return null;
  return doc.stock - known;
}

/** Optional product keys that are absent from the local doc (to be written as deleteField()). */
export function optionalKeysToDelete(doc) {
  return OPTIONAL_PRODUCT_KEYS.filter((k) => !doc || !(k in doc) || doc[k] === undefined);
}

/**
 * Plans how to write one product upsert.
 *   { mode:'absolute' }                                   -> normal set() with the whole doc (incl. stock)
 *   { mode:'delta', delta:number, deleteKeys:string[] }   -> set(doc minus stock, {merge:true}) + (delta !== 0 ?
 *                                                            stock: increment(delta) : no stock field) + deleteField() per deleteKeys
 * `absolute:true` forces the first mode (firstSync uploads). Pure.
 */
export function planProductWrite(shadowStockMap, doc, { absolute = false } = {}) {
  if (absolute) return { mode: 'absolute' };
  const delta = stockDelta(shadowStockMap, doc);
  if (delta === null) return { mode: 'absolute' };
  return { mode: 'delta', delta, deleteKeys: optionalKeysToDelete(doc) };
}

/** True when an own-device echo of a product carries a stock different from shadow.stock[id], i.e. the server
 *  value already includes other devices' deltas and must NOT be skipped. Pure. */
export function ownEchoHasStockDrift(shadowStockMap, id, remoteStock) {
  const known = (shadowStockMap || {})[String(id)];
  return typeof known === 'number' && typeof remoteStock === 'number' && known !== remoteStock;
}

/** Builds a shadow that exactly matches a snapshot (used right after firstSync / a full push). */
export function buildShadowFromSnapshot(snapshot) {
  const shadow = emptyShadow();
  for (const col of COLLECTIONS) {
    const map = arrayToMap(snapshot[col]);
    for (const id of Object.keys(map)) shadow[col][id] = hashDoc(map[id]);
  }
  shadow.settings = snapshot.settings ? hashDoc(snapshot.settings) : null;
  shadow.stock = stockMapFromProducts(snapshot.products);
  return shadow;
}

/** Returns a new shadow with the given collection's upserts/deletes applied. Pure (does not mutate input).
 *  For collection === 'products', also refreshes shadow.stock[id] to the upsert's `stock` (this is how
 *  shadowStock stays current both on remote receipt and on push dispatch — see the header comment
 *  in cobral-cloud.js for the three points where this fires). */
export function updateShadowForCollection(shadow, collection, upserts, deleteIds) {
  const next = { ...shadow, [collection]: { ...shadow[collection] } };
  for (const doc of upserts || []) next[collection][String(doc.id)] = hashDoc(doc);
  for (const id of deleteIds || []) delete next[collection][String(id)];
  if (collection === 'products') {
    next.stock = { ...(shadow.stock || {}) };
    for (const doc of upserts || []) {
      if (doc && typeof doc.stock === 'number') next.stock[String(doc.id)] = doc.stock;
    }
    for (const id of deleteIds || []) delete next.stock[String(id)];
  }
  return next;
}

/** Returns a new shadow with the settings hash replaced (pass null to mark "no settings doc known"). */
export function updateShadowSettings(shadow, settingsDocOrNull) {
  return { ...shadow, settings: settingsDocOrNull ? hashDoc(settingsDocOrNull) : null };
}

// ---------------------------------------------------------------------------
// Diff: what changed in `snapshot` relative to `shadow`.
// ---------------------------------------------------------------------------

function diffCollection(shadowCol, currentArr) {
  const currentMap = arrayToMap(currentArr);
  const upserts = [];
  const deletes = [];
  for (const id of Object.keys(currentMap)) {
    const h = hashDoc(currentMap[id]);
    if ((shadowCol || {})[id] !== h) upserts.push(currentMap[id]);
  }
  for (const id of Object.keys(shadowCol || {})) {
    if (!(id in currentMap)) deletes.push(coerceId(id));
  }
  return { upserts, deletes };
}

/**
 * diff(shadow, snapshot) -> { sales:{upserts,deletes}, products:{...}, debts:{...}, debtHistory:{...},
 *                              settings:{ upsert: doc|null } }
 * `settings.upsert` is the settings doc when it changed, else null (settings has no deletes/tombstones).
 */
export function diff(shadow, snapshot) {
  const result = {};
  for (const col of COLLECTIONS) {
    result[col] = diffCollection((shadow || {})[col], snapshot[col]);
  }
  const settingsHash = snapshot.settings ? hashDoc(snapshot.settings) : null;
  const shadowSettingsHash = (shadow || {}).settings || null;
  result.settings = { upsert: settingsHash !== shadowSettingsHash ? snapshot.settings || null : null };
  return result;
}

/** True when a diff() result has nothing to push. */
export function isDiffEmpty(d) {
  if (d.settings && d.settings.upsert) return false;
  return COLLECTIONS.every((col) => d[col].upserts.length === 0 && d[col].deletes.length === 0);
}

// ---------------------------------------------------------------------------
// First-login merge.
// ---------------------------------------------------------------------------

/**
 * mergeFirstSync(local, remote) -> { merged, upload }
 *  - local:  snapshot built from this device's localStorage.
 *  - remote: snapshot built from Firestore (already stripped of _deleted docs and sync fields
 *            by the caller — a tombstone is simply absent from `remote`).
 * Per collection:
 *  - cloud empty  -> merged = local, upload = local (all of it)
 *  - cloud non-empty -> merged = union by id, remote wins on a shared id; upload = local-only docs
 * Settings (single doc, no ids to union):
 *  - remote settings present -> merged = remote, nothing to upload
 *  - remote settings absent, local present -> merged = local, upload local
 *  - neither present -> merged = null, nothing to upload
 */
export function mergeFirstSync(local, remote) {
  const merged = {};
  const upload = {};
  for (const col of COLLECTIONS) {
    const localMap = arrayToMap(local[col]);
    const remoteMap = arrayToMap(remote[col]);
    const remoteEmpty = Object.keys(remoteMap).length === 0;
    if (remoteEmpty) {
      merged[col] = mapToArray(localMap);
      upload[col] = mapToArray(localMap);
    } else {
      const mergedMap = { ...localMap, ...remoteMap }; // remote wins on matching ids
      merged[col] = mapToArray(mergedMap);
      const localOnlyIds = Object.keys(localMap).filter((id) => !(id in remoteMap));
      upload[col] = localOnlyIds.map((id) => localMap[id]);
    }
  }
  if (remote.settings) {
    merged.settings = remote.settings;
    upload.settings = null;
  } else if (local.settings) {
    merged.settings = local.settings;
    upload.settings = local.settings;
  } else {
    merged.settings = null;
    upload.settings = null;
  }
  return { merged, upload };
}
