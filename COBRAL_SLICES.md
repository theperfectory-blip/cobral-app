# Cobral — Macro slices (v5.52 → v6.0)

Source of truth for every development slice. Each Sonnet agent reads this file plus
`../COBRAL_CODE_MAP_EN.md` and `../COBRAL_PROJECT_CONTEXT.md` before touching code.
Line numbers refer to `www/index.html` at the v5.52 baseline and **drift after each slice**:
locate code by function name, not by line.

## Decisions (confirmed by Jimbo, 2026-09-19)
- Backend: **new Firebase project "cobral"** in la cuenta de Google de Jimbo (separate from TSC).
- Login: **email + contraseña** (Firebase Auth JS SDK, no native plugins).
- Margin formula: **sobre la venta** → `precio = costo / (1 − m)`, rounded **up** to $100.
- "Versión ver" = **versión web** on Firebase Hosting, synced with the APK.
- Offline-first stays non-negotiable: the APK must work with no login and no internet.

---

## The loop (Opus orchestrates, Sonnet builds, Opus tests on the real app)

```
┌─ Opus: pick next slice, send brief ──────────────────────────────┐
│  Sonnet: surgical edits → node tools/check.mjs → report          │
│  Opus: git diff review → bash tools/build.sh → emulator UI test  │
│        (real taps/swipes via adb, screenshots light + dark,      │
│         logcat for JS errors)                                    │
│     ├─ FAIL → SendMessage same Sonnet agent with evidence (≤3x)  │
│     └─ PASS → git commit "<slice>: …" → tick box below → next    │
└──────────────────────────────────────────────────────────────────┘
```

- **One slice at a time on `www/index.html`** (single file → parallel agents would collide).
  Work that lives in *new* files (Phase B scaffolding) may run in parallel.
- Only Opus drives the emulator. Sonnet never runs `tools/build.sh`, never touches the device.
- Test data: `node tools/cdp.mjs -f tools/seed.js` (296 sales over 76 days, ~1/3 with 5+ products).
  Emulator only — never on Jimbo's phone.

### Tooling (`tools/`)
| Script | Use |
|---|---|
| `node tools/check.mjs` | Integrity check: scripts compile, no duplicate functions, handlers call defined functions |
| `bash tools/build.sh [--sync]` | check → `cap copy/sync` → `gradlew assembleDebug` → `adb install -r` → launch |
| `node tools/cdp.mjs "<js>"` / `-f file.js` | Evaluate JS inside the running WebView (state, DOM asserts) |
| `node tools/tap.mjs "<sel>" [i] [fx]` | Real tap at element (fx = horizontal fraction, e.g. 0.2 = left side) |
| `node tools/tap.mjs --swipe "<sel>" up\|down [px] [ms]` | Real swipe from element center |
| `bash tools/shot.sh <name>` | Screenshot → `tools/out/<name>.png` |

### Rules for every Sonnet slice
1. **Surgical edits only** (Edit tool, exact-string replacements). Never rewrite or reformat the file.
   Keep the existing compact one-line-per-function style.
2. UI copy in **Chilean Spanish**, neutral tone (no voseo, no Argentine idioms).
3. Every new visual element needs **dark-mode coverage** (`body.dark-mode …` rules) and must work at 360–430 px width.
4. Do not change persisted data shapes unless the slice says so; old `localStorage['ventasApp']` data must keep loading.
5. `state.locations` is keyed by `Date.getDay()` (0 = domingo). **Never change those keys.**
6. Run `node tools/check.mjs` until it prints `OK` before reporting.
7. Do **not** bump the version, commit, build, or edit `COBRAL_SLICES.md` — Opus does that.
8. Report: functions added/changed, any deviation from the spec and why, anything Opus should test specially.

---

## Phase A — APK improvements (release as **v5.6**)

### [x] A1 · Quick wins: "IVA incluido" + live totals on sales search
- **Payment modal** (`renderPaymentModal`): the card-fee badges read `-1.3029% IVA incl.`;
  the summary row reads `Comisión (IVA incluido)`. Same wording in `openSaleDetail` summary and
  in Settings labels (`Comisión débito (IVA incluido)` / `Comisión crédito (IVA incluido)`).
  Show fee percentages with Chilean decimal comma (`1,3029%`).
- **Sales search** (`renderSales` / `updateSalesSearch`): typing in "Buscar ventas…" must update the
  stats card (Ingresos, Costo, Margen, %) in real time, not just the list. Extract one shared
  `getVisibleSales()` (period + payment filter + search) and render stats into an element with id
  `salesStats` so `updateSalesSearch` can refresh it without re-rendering the input (keep focus/caret).
- Search also matches the **ticket number**: a query of digits (optionally prefixed with `#`) matches
  `s.numVenta` exactly, in addition to product names containing it.
- **Test:** type a product name → totals shrink to match the list; type `#12` → exactly ticket 12 and its total; clear → totals restored; input keeps focus while typing.

### [x] A2 · Calendar: Monday first + Monday–Sunday weeks
- `getWeekStart` → Monday-based (`(getDay()+6)%7`). Everything that derives weeks (Top + Ventas
  week filters, `getWeeksForMonth`, pickers, `visibilitychange` refresh, `init`) must follow.
- `renderCalendarGrid`: labels `Lu Ma Mi Ju Vi Sá Do`, leading blanks = `(getDay()+6)%7`.
- Week chips show the ISO-8601 week number above the range (`Sem 38` / `15 – 21 sep`); when a week
  spans two months show both (`29 sep – 5 oct`).
- `openLocationModal` lists days Lunes → Domingo (display order only; keys stay 0–6 by `getDay()`).
- **Test:** calendar for sep-2026 starts on Lu with 1 sep under Ma; week filter shows Monday–Sunday ranges; a sale made on a Sunday falls in the week that started the previous Monday; ubicación by day unchanged.

### [x] A3 · Pinned "Hoy" in every period selector (Ventas + Top)
- In both `renderHome` and `renderSales`, the period selector gets a **sticky "Hoy" button** that
  never scrolls out of view (right edge, next to the calendar icon), for **día, semana, mes and año**.
- Tap → jumps to the current period: día = today; semana = current Monday-week (and current
  month/year so the chip list contains it); mes = current month + year; año = current year.
  Then re-render and center the active chip (`scrollToActivePeriod`).
- Visual: gold outline when the selection is **not** the current period, muted when it already is.
- Also add a "Hoy" action inside the date-picker calendar modal.
- **Test:** in Ventas and Top, for each of the 4 modes: select an old period, tap Hoy → current period active and visible; Hoy button visible after scrolling the chips fully left.

### [x] A4 · Top ventas → drill into a product's sales
- Tapping a product row in Top ventas opens a modal: product name, the active period label
  (e.g. `Semana 15 – 21 sep`), active location filter, total units and revenue for that product.
- A segmented control **Día / Semana / Mes / Año** inside the modal switches `state.homeFilterPeriod`
  (anchored on the currently selected date) and refreshes both the modal and Top behind it.
- Lists every sale in that period/location containing the product (newest first): `#ticket`, date+time,
  payment, sale total. Inside each sale the **selected product is listed first and highlighted**, then the rest.
- Tapping a sale opens `openSaleDetail` with the same product first/highlighted and a **"Volver"**
  button back to the product list (existing Eliminar/Modificar keep working).
- Works for discontinued products (ids no longer in `state.products`).
- **Test:** pick a seeded product with sales in 5+-item carts; each card shows it first; totals equal the Top row; switch Día→Mes updates list and totals.

### [x] A5 · Product card halves: left = −, right = +
- In the product pickers of **new sale** (`renderSaleProducts`), **edit sale** (`renderEditProducts`)
  and **edit debt** (`renderEditDebtProducts`), each card gets a semi-transparent layer split in two
  halves: left half shows **−**, right half shows **+**. Tap right = add `gStep(id)`; tap left = subtract
  `gStep(id)` (removing the line at 0, restoring stock exactly like `updateCartQtyRT`).
- The layer must keep name, stock and price readable (light tint, glyphs ~40–50 % opacity); the − half
  is dimmed and inert when the product isn't in the cart. Brief press feedback on the tapped half.
- The old "×" remove badge goes away (the − half and the cart qty input replace it).
- Update in place (no full modal re-render) so the list doesn't jump while tapping quickly.
- **Test:** real taps at 25 % and 75 % of a card width: qty +1/−1, stock ±1, cart total updates; gram product steps by its `gramStep`; − on qty 1 removes the line; dark mode legible.

### [ ] A6 · Cart minimize / maximize by gesture only
- New-sale modal and payment modal: remove every **click** path to minimize (overlay tap, the
  "minimizar" strip, the header). Replace the strip text with a grabber pill.
  **Drag down** on the grabber/header → sheet follows the finger; release past ~80 px (or a fast
  flick) → `minimizeSale()`, otherwise it springs back.
- Mini bar: remove `onclick="expandSale()"`; **swipe up** on it → `expandSale()`. Add a small grabber
  hint on the bar. The mini bar's "×" (cancel) stays a tap.
- Implement with **Pointer Events** (`pointerdown/move/up`, `touch-action:none` on the handle) so the same
  gesture works with a mouse drag on the web version. Buttons inside the header (×) must still tap normally.
- Scrolling the product list must never trigger minimize.
- **Test:** tap overlay/header → nothing; swipe down on header → minimized mini bar with cart intact; short drag (40 px) → springs back; swipe up on mini bar → sale restored; scroll product list → no minimize.

### [ ] A7 · Margins in inventory + live price from target margin
- Product modal (`renderProductModal` / `saveProduct`): add **Margen %** between cost and sale price.
  - Typing margin → sale price = `ceil(costo / (1 − m/100) / 100) × 100` **live**; show below it
    `Margen real: 31,4 %` (after rounding). For `unit==='g'` (price per gram) round up to 0,1 instead.
  - Typing sale price → margin field updates live to the real margin (no rounding of the price).
  - Typing cost → keep the margin, recompute the price.
  - Validation: 0 ≤ m < 100. Opening an existing product pre-fills margin from its prices.
- Inventory list (`renderInventoryList`): each product shows its margin % (color: red < 15 %, amber
  15–30 %, green > 30 %). Top card adds **Margen potencial** = Σ (venta − costo) × stock (stock > 0).
- Sort modal: add **Mayor margen** / **Menor margen**.
- **Test:** cost 1.000 + margin 30 → price 1.500, "Margen real 33,3 %"; type price 1.200 → margin 16,7; change cost to 800 with margin 30 → 1.200; sorting and colors correct; save persists.

**Phase A exit:** bump title/CSV headers to **v5.6**, full regression pass on the emulator
(sale → payment → Ventas → edit sale → debt → inventory CSV export), update `COBRAL_CODE_MAP_EN.md`,
copy `app-debug.apk` to the project root as `Cobral_v5.6.apk` for Jimbo to install over the current one.

---

## Phase B — Backend: Firebase Auth + Firestore sync (release as **v6.0** with Phase C)

### [x] B1 · Firebase project (Opus — account operations)
- **Done 2026-09-19:** project `cobral-app`, web app `1:60325446787:web:292ff3035908f69c2f07b6`,
  Email/Password enabled (`firebase deploy --only auth`), Firestore `(default)` created **in `nam5` (US)** —
  pending Jimbo's call on moving it to `southamerica-west1` while it's still empty. Rules deployed.
  Config: `www/cloud/config.js` (`window.COBRAL_FIREBASE_CONFIG`).
- Create project `cobral-*` in la cuenta de Google de Jimbo, register a Web app, enable Email/Password
  auth, create Firestore in `southamerica-west1` (Santiago). Deploy rules:
  `match /users/{uid}/{document=**} { allow read, write: if request.auth.uid == uid; }`.
- Commit `firebase.json`, `.firebaserc`, `firebase/firestore.rules`. Web config goes in `www/cloud/config.js`.

### [x] B2 · Cloud module (Sonnet — new files only, can run in parallel with Phase A)
- `npm i -D firebase esbuild`; bundle Auth + Firestore into `www/vendor/firebase.js` (local file, so the APK
  boots offline — **no CDN**). Firestore with `persistentLocalCache` (multi-tab on web).
- `www/cloud/cobral-cloud.js` exposing `window.CobralCloud = { init, signIn, signUp, signOut, resetPassword, onUser, pushChanges, … }`.
- Data model: `users/{uid}/sales/{id}`, `products/{id}`, `debts/{id}`, `debtHistory/{id}`, `meta/settings`
  (categories, locations, fees, userName). Every doc carries `updatedAt` (server timestamp) and deletions
  are **tombstones** (`deleted:true`) so offline devices converge. Last-write-wins per document.
- Photos stay device-local in this phase (Firebase Storage requires the Blaze plan).
- **Done 2026-09-19:** `cloud-src/` (source + 23 unit tests), bundle `www/cloud/cobral-cloud.js` (682 KB min), e2e 10/10 on
  emulators incl. offline queueing (`npm run e2e:cloud`, needs JAVA_HOME + PATH + the JAVA_TOOL_OPTIONS workaround).
  API: `init/signIn/signUp/signOut/resetPassword/currentUser/push/firstSync/status` — see header of `cloud-src/cobral-cloud.js`.

### [ ] B3 · Wire sync into the app (Sonnet, `index.html`)
- Sync `settings` WITHOUT device preferences: `darkMode` and `soundEnabled` stay per-device.
- `numVenta` can collide when two devices sell offline: after merges, keep numbers unique (later sale by date gets the next free number) and never renumber existing unique tickets.
- Known limitation to tell Jimbo: `stock` on products is last-write-wins — two devices selling the same product at the same time can lose one decrement.
- Settings gets **Cuenta**: login / crear cuenta / recuperar contraseña / cerrar sesión, sync status
  (`Sincronizado`, `Pendiente (sin conexión)`, error). Login is **optional** in the APK.
- `saveData()` stays the single write path: after writing localStorage it diffs against the last synced
  snapshot and pushes only changed docs. `onSnapshot` listeners merge remote changes into `state`,
  persist to localStorage and `render()` (without clobbering an open sale/cart).
- First login on a device with local data: if the cloud is empty upload everything; if both have data,
  merge by id (sale numbers re-assigned by date with `assignSaleNumbers` rules).
- **Test (Opus):** emulator APK + web client on the same account: sale on one appears on the other;
  airplane mode on the emulator → sale → back online → synced; delete propagates; logout keeps local data.

---

## Phase C — Web version

### [ ] C1 · Responsive web shell (Sonnet)
- Same `www/index.html`. Detect `window.Capacitor?.isNativePlatform()`; on web **login is required**.
- ≥ 900 px: centered app column with max width, modals as centered dialogs instead of bottom sheets,
  hover states, keyboard (Enter/Escape). Gestures from A6 work with mouse drag (Pointer Events).
- CSV export/import: web fallback (Blob download / file input) where the app uses Capacitor Filesystem/Share.
- Service worker caches the shell so the web app also opens offline after the first visit.
  **Known bug (pre-existing):** `sw.js` `cache.addAll` rejects ("Request failed") in the APK — it lists
  `./app_ventas_local_v5_2.html`, which doesn't exist, so the SW never installs (harmless today). Fixing it naively
  would be dangerous: its cache-first strategy would serve a stale `index.html` after every APK update and would
  intercept cross-origin Firestore/Auth requests. Required design:
  - **Do not register the SW inside Capacitor** (`window.Capacitor?.isNativePlatform()`); unregister any existing one there.
  - Web only: handle **same-origin GET only** (never touch `*.googleapis.com` / cross-origin); **network-first** for
    navigations and `.html`/`.js`, cache fallback when offline; versioned cache name; precache `./`, `index.html`,
    `cloud/config.js`, `cloud/cobral-cloud.js`.

### [ ] C2 · Hosting deploy (Opus — ask Jimbo before publishing)
- `firebase.json` hosting (public = `www`, no-cache headers for html/js), deploy to `cobral-*.web.app`.
- **Test:** login on the browser pane with the same account as the emulator, full sale flow, sync both ways.

**Phase B+C exit:** version **v6.0**, code map + project context updated, `Cobral_v6.0.apk` in project root.
