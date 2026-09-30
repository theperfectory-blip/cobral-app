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

### [x] A6 · Cart minimize / maximize by gesture only
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

### [x] A7 · Margins in inventory + live price from target margin
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

**Phase A exit — DONE 2026-09-19** (regression passed: sale→débito, edit sale, debt + abono, inventory CSV share; `Cobral_v5.6.apk` versionCode 56).
Original checklist: bump title/CSV headers to **v5.6**, full regression pass on the emulator
(sale → payment → Ventas → edit sale → debt → inventory CSV export), update `COBRAL_CODE_MAP_EN.md`,
copy `app-debug.apk` to the project root as `Cobral_v5.6.apk` for Jimbo to install over the current one.

### [x] A8 · Prices per location (requested 2026-09-19, ships in v6.0)
Jimbo sells some products cheaper at some locations (e.g. Guillermo Mann vs Los Aromos / María Celeste).
Decisions: **special price per product per location** (optional; otherwise the normal price); **offers are the same
everywhere**; **the cart uses the current location's price**.
- Data: optional `product.locationPrices = { "<location name>": price }` (keys = the location names used in
  `state.locations` values and `sale.location`). Old products without it keep working. Syncs as part of the product doc.
- Helper `getProductPrice(p, loc = state.currentLocation)` → `p.locationPrices?.[loc] ?? p.salePrice`; use it everywhere a
  list price is taken: `addToCart` (current location), edit sale (the sale's `location`), edit debt (the debt's `location`),
  sale-picker card price, and `calculateItemPrice` (offers apply when the item price equals that location's list price,
  i.e. not manually edited — today it compares with `p.salePrice`).
- Changing the current location while a sale is open: cart lines still at the old location's list price switch to the
  new location's price; manually edited prices stay. Picker cards and totals refresh.
- Product modal: section **"Precios por ubicación"** listing each distinct location name with an optional price input
  (placeholder = precio normal) and a live margin pill per location (same formula/colors as A7). Empty = normal price.
- Sale picker card: shows the current location's price; when it's a special price, a small tag with the location name.
  Inventory list: normal price + a small "N precios por ubicación" hint; margin pill keeps using the normal price.
- Renaming a location in `openLocationModal` migrates `locationPrices` keys (old name → new name) when no other day still uses the old name.
- Inventory CSV: new optional column `PreciosUbicacion` = `Mann:7500|Los Aromos:8000` (export + import; missing column = none;
  update the embedded instructions).
- **Test:** Miel ulmo normal $8.000, Mann $7.500 → location Mann: card and cart show $7.500 → switch to Los Aromos with the
  sale open → $8.000; a manually edited line keeps its price; an offer product still applies its offer at normal price;
  edit an old sale made at Mann → added items use Mann prices; CSV export → import round-trip keeps the prices; sync to the
  peer keeps `locationPrices`.

---

## Phase B — Backend: Firebase Auth + Firestore sync (release as **v6.0** with Phase C)

### [x] B1 · Firebase project (Opus — account operations)
- **Done 2026-09-19:** project `cobral-app`, web app `1:60325446787:web:292ff3035908f69c2f07b6`,
  Email/Password enabled (`firebase deploy --only auth`), Firestore `(default)` recreated **in `southamerica-west1` (Santiago)** on 2026-09-19 (the first one was auto-created in `nam5`; deleted while empty, 0 prod users) —
  rules redeployed.
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

### [x] B3 · Wire sync into the app (Sonnet, `index.html`)
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

### [x] B4 · Stock merge by deltas (found testing B3)
- Problem (reproduced on the emulator): stock is last-write-wins. A remote product update that was queued during
  an open sale is applied after the sale and overwrites the local decrement (sold 2 locally + 1 remotely → only 1 counted).
- Fix: three-way merge for `products[].stock`. The module keeps `shadowStock[id]` = last stock value this device
  knows is in the cloud (set on remote receipt and on push dispatch) and passes it as `_baseStock` with product
  upserts in `onRemote`. The app merges `stock = remote.stock + (local.stock − base)` (other fields: remote wins),
  then `saveData()` pushes the merged value. Concurrent decrements on two devices must converge to base − a − b.
- **Done:** device re-test 23 − 2 (phone, sale open) − 1 (peer) = 20 on phone and cloud. Unit 33/33, e2e 17/17.
  **Residual limitation (documented, accepted):** two devices writing the same product's stock blind in the same
  ~1 s window can still lose one side. Full fix = stock as a movement log (future, only if Jimbo adds more sellers).
- Tests: unit tests in sync-core, an e2e step with two clients selling the same product concurrently, and Opus
  repeats the queued-during-sale scenario on the emulator.

### Test infra for Phase B (emulator only)
- `bash tools/emulators.sh` (background) starts Auth+Firestore emulators and `adb reverse` 9099/8080.
- In the app: `localStorage.cobralEmulatorHost='127.0.0.1'` (set via cdp) → the cloud module targets the emulators.
- `android/app/src/debug/` adds a debug-only network security config allowing cleartext to 127.0.0.1/10.0.2.2/localhost.
- `node tools/sync-peer.mjs dump|add-sale|delete-sale|watch <email> <pass> …` = second device (Node).

---

## Phase C — Web version

### [x] C1 · Responsive web shell (Sonnet)
- **Done 2026-09-19.** Tested: APK unchanged; browser pane (gate, validation, 1280px centered 760px column, centered
  540px dialogs, Escape minimizes sale, click grabber/mini bar on pointer:fine); web build inside the emulator WebView via
  `tools/navigate.mjs` against the emulators: login loads cloud without uploading defaults, web→peer and peer→web sync,
  SW `cobral-web-v6` active, sign-out clears ventasApp/shadow/Firestore cache/photos.
- **Bugs found while testing C1 (fixed by Opus):** the module used a random FirebaseApp name per launch → the session
  and the Firestore offline queue were lost on every restart (now fixed name `cobral`, `appName` option for tests);
  status showed "Sincronizado" after restarting with offline-queued writes (now `waitForPendingWrites` at login);
  web sign-out now also deletes the local photos DB.
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
- `firebase.json` hosting (public = `www`, no-cache headers for html/js). **Done 2026-09-22:** Hosting site
  `cobral` created (`https://cobral.web.app`, the short name Jimbo asked for — the default `cobral-app` site
  still exists but is unused), wired via `firebase target:apply hosting web cobral` + `"target":"web"` in
  `firebase.json`. **Not deployed yet** — still needs Jimbo's go-ahead before `firebase deploy --only hosting`.
- **Also done 2026-09-22:** Firestore `(default)` delete protection **ENABLED** (was disabled) — requires
  explicitly disabling it again before the database could ever be deleted.
- **Test:** login on the browser pane with the same account as the emulator, full sale flow, sync both ways.

**Phase B+C exit:** version **v6.0**, code map + project context updated, `Cobral_v6.0.apk` in project root.

---

## Post-v6.0 review fixes (2026-09-22, APK only; web review pending)
Loop used: Opus writes the spec → Haiku implements → (Sonnet if Haiku fails) → Opus reviews diff, builds, tests on emulator.
- [x] F1 · First login on a fresh install wiped sales/debts made before logging in (`finishCloudLogin` now sends this session's sales/debts/new products; samples ids 1–92 still never uploaded).
- [x] F2 · Product edit silently lost when a remote change replaced the product object while the modal was open (`saveProduct` re-resolves the live product; untouched stock field keeps live stock).
- [x] F3 · `cancelSale` restored every product to the open-time snapshot, reverting remote decrements (now restores only what the cart took).
- [x] F4 · Clearing a day in Ubicaciones deleted special prices; saving a product dropped prices for locations not in the schedule.
- [x] F5 · Cloud status stuck in "Pendiente" after sign-out/sign-in with unacked writes (module: auth-session generation + listener `hasPendingWrites` instead of `waitForPendingWrites`).
- [x] F6 · CSV import ids `Date.now()+Math.random()*1000|0` (32-bit wrap, frequent collisions) → `newProductId()`.
- [x] F7 · Android back button closed the app and lost the open sale → `@capacitor/app` backButton handler (minimize sale → close modal → Home → minimizeApp).
- [x] Minor: percentages with decimal comma; payment labels capitalized; long names no longer overlap "+" in picker cards; Enter/Go in Cuenta; remote schedule change updates today's location; email kept after a failed login.

---

## Phase D — Desktop web design (requested 2026-09-30, ships as v6.1)
Web review found the desktop web is the phone UI in a centered 760 px column (40 % of a 1920 px screen, bottom nav,
cards instead of tables, bottom sheets). Jimbo approved an exclusive desktop design (mockup shown in chat) + **all
extras** (daily-sales chart, keyboard shortcuts, export current view to CSV). Main use on PC: **review and administer**
(selling from the PC is occasional) → prioritise Inicio / Ventas / Inventario; POS two-pane is functional, not cash-register-optimised.

Work happens on branch `desktop` in the worktree `C:\Users\Administrator\Downloads\Cobral App\cobral-desktop`
(main stays stable for APK verification). Loop: Opus spec → **Haiku** implements (→ Sonnet if Haiku fails) →
Opus tests in the browser pane at 1280 / 1440 / 1920 px AND at 375 px (mobile must be unchanged).

### Hard rules for every D slice
1. Desktop mode = **web only** (`!isNative`) **and** viewport ≥ 1100 px → `document.body.classList.add('desk')`, kept in sync
   with a `matchMedia('(min-width:1100px)')` listener that re-renders on change. APK and < 1100 px: **byte-for-byte the
   current UI** (all desktop CSS scoped under `body.desk`, all desktop JS paths behind a single `isDesk()` helper).
2. **No duplicated business logic.** Desktop renderers call the same data functions (getVisibleSales, getStats,
   getTopProductsByRevenue, getFilteredSalesByPeriodAndLocation, addToCart, completeSale, saveProduct, openSaleDetail…).
   Only markup/layout differs.
3. No external libraries or CDNs (offline-first): charts are hand-written inline SVG.
4. Full dark-mode coverage (`body.dark-mode.desk …`). Chilean Spanish copy. Surgical edits; don't reformat.
5. `node tools/check.mjs` must print OK. Do not bump version, commit, deploy or touch adb/Firebase.

### [ ] D1 · Desktop shell
- Left **sidebar** (fixed, 232 px): Cobral logo + user name; nav Inicio / Ventas / Deudas / Inventario (active state,
  hover, icons from the existing SVG set); bottom block: current location (click → openLocationModal), cloud status
  (same states as the header icon; click → openAccountModal), Configuración (openSettings), dark-mode toggle.
  When a sale is in progress (cart non-empty or minimized) show a "Venta en curso · $total" item that opens it.
- Hide the mobile header, bottom nav and mini bar in desk mode. Main area: `margin-left:232px`, content max-width 1320 px,
  24–32 px padding, a page title row (title + right-aligned actions).
- **Drawers:** in desk mode, generic modals (sale detail, product editor, drill-down, debtor detail, settings, account,
  locations, CSV) render as a right-side drawer (width 480 px, full height, own scroll, overlay click / × / Esc closes).
  Small confirmations and the calendar picker stay centered dialogs. Implement once (CSS on `.modal-overlay`/`.modal` +
  a drawer class chosen by the opener) so existing modal functions keep working unchanged.
- **Period bar** (shared by Inicio and Ventas in desk mode): segmented Día / Semana / Mes / Año + ‹ label › stepper
  (previous/next period, next disabled at the current period) + "Hoy" + calendar button, in one line. Uses the existing
  state fields and goToCurrentPeriod.

### [ ] D2 · Inicio (dashboard)
- Toolbar: period bar, location filter (select), category filter (select), actions "Exportar vista" and "Nueva venta".
- KPI row (6 cards): Ingresos, Costo, Margen, Margen %, N° ventas, Ticket promedio — for the Top filters (period +
  location). Ticket promedio = ingresos / ventas.
- **Sales chart** (inline SVG bars, responsive width, ~220 px high): day → per hour (8–21 h), week → per day (Lu–Do),
  month → per day of month, year → per month. Hover tooltip with value; y-axis with 3–4 gridlines in CLP short format
  ($1,2M / $350k); bar for the current/selected unit highlighted.
- Top ventas as a **table**: #, Producto, Categoría, Uds (or g), Ingresos, % del total; sortable by clicking headers;
  row click → existing openTopProductSales (in a drawer).

### [ ] D3 · Ventas
- Toolbar: period bar, payment filter, location filter, search (same matching as getVisibleSales incl. #ticket),
  "Exportar vista", "Nueva venta". KPI strip (Ingresos, Costo, Margen, %) updates live with search (reuse renderSalesStats data).
- **Table**: # ticket, Fecha y hora, Productos (single line, ellipsis, full list in title tooltip), Ubicación, Pago (badge),
  Total; sortable headers (default newest first); row click → openSaleDetail in a drawer (Eliminar / Modificar still work;
  Modificar opens the edit flow). Show 50 rows + "Mostrar más".

### [ ] D4 · Inventario
- Summary cards: Referencias, Costo inventario, Margen potencial. Toolbar: search, category select, "Exportar vista",
  "Importar CSV", "Nuevo producto".
- **Table**: Foto (thumb), Nombre, Categoría, Stock (red ≤ 0, amber ≤ 5), Costo, Precio, Margen (existing pill),
  Precios por ubicación (count or "—"); sortable headers; row click → product editor in a drawer (renderProductModal content).

### [ ] D5 · Deudas
- Two panes: left list of debtors with total owed (tabs Pendientes / Historial), right the selected debtor's detail
  (existing debtor detail/history content inline, with Pagar / Editar / Eliminar actions). Empty state when nothing selected.

### [ ] D6 · Nueva venta (two panes)
- In desk mode the sale opens in the main area (not a sheet): left search (autofocus) + category chips + product **grid**
  (4–6 columns, A5 halves still work with the mouse: left half −, right half +); right fixed cart panel (lines with qty
  input, price input, line total, remove), totals, payment method buttons with fees, location, "Confirmar venta",
  "Cancelar venta". Debt sales work the same way. Navigating to another page keeps the sale (sidebar "Venta en curso").

### [ ] D7 · Shortcuts + export view
- Shortcuts (desk only, ignored while typing in an input except Esc): N = nueva venta, / = focus search of the current
  page, Esc = close drawer (sale: go back / keep sale), ? = shortcuts help popover. Enter in the sale confirms when the
  cart has items and a payment method is selected.
- "Exportar vista" on Inicio (top table), Ventas (filtered table) and Inventario (sorted/filtered table): CSV with the
  visible columns and current sort, `;` separator, UTF-8 BOM, filename with page + period (e.g. `ventas-2026-09.csv`),
  via the existing downloadCSV.

## Post-v6.0 verification fixes (2026-09-30, found by tools/regress.mjs + tools/regress-sync.mjs)
- [x] F8a · `dispatchOps` didn't refresh the status when it queued writes → "Sincronizado" during a long first upload
      (fixed by Opus: `queueMicrotask(refreshStatus)` at the start of dispatchOps).
- [x] Dark mode: green amounts / cart line totals / payment amount / "Ver" badge unreadable (fixed by Opus, CSS).
- [x] F8b · Status says "Sincronizado" for a few seconds right after sign-in/sign-up, before `firstSync` has even read the
      cloud. Module (`cloud-src/cobral-cloud.js`): add `let firstSyncRunning = 0;` — `firstSync()` does
      `firstSyncRunning++; refreshStatus();` at its start and `firstSyncRunning--; refreshStatus();` in a `finally`
      AFTER `dispatchOps` has been called (so the in-flight counter already covers the upload). `refreshStatus()` treats
      `firstSyncRunning>0` like unacked writes (→ 'pending' / 'offline'). App: `finishCloudLogin` must not force a
      'synced' status itself; it only reflects `onStatus`.
- [x] F9 · A local edit made less than ~1.5 s before a remote update of the SAME doc is lost (reproduced: price edited to
      $8.500 on the phone, another device sells that product inside the push debounce window → remote doc overwrites the
      whole product locally, price back to $8.000, nothing pushed). Fix = "local pending wins":
      - Module: keep `dirty = {sales:Set, products:Set, debts:Set, debtHistory:Set, settings:false}`. In `push(snapshot)`
        compute `diff(shadow, snapshot)` and add every upsert/delete id to `dirty` (settings → true). In `flushPush`,
        after `dispatchOps`, clear the ids that were dispatched. On sign-out, reset `dirty`.
      - Module listener: for a remote change whose id is in `dirty[col]` (or settings while `dirty.settings`), do NOT
        update `shadow[col][id]` (so the pending local version still diffs as changed and gets pushed), but for products
        DO update `shadow.stock[id]` to the remote stock after computing `_baseStock`; emit the upsert with
        `_localPending:true` (keep `_baseStock`).
      - App `applyRemoteChange`: if `doc._localPending` → for products apply ONLY the stock three-way merge
        (`local.stock = doc.stock + (local.stock − doc._baseStock)`) and keep every other local field; for
        sales/debts/debtHistory/settings ignore the remote version entirely. Strip `_localPending`. The following
        `saveData()` → `push()` sends the local fields + merged stock (local edit wins, stock stays correct).
      - Tests: unit test for the dirty bookkeeping; e2e step: client A changes product price and pushes (debounce
        pending) while client B sells 1 of that product → both converge to A's price and stock base − 1.

- F9 note (Opus): Haiku's app-side merge deleted `doc._baseStock` before using it → stock NaN; fixed. Verified on the device:
  regress-sync 5/5 (serialized with settle waits — acks via `adb reverse` can take minutes) and an armed-peer race test:
  price edit kept (7.000 → 7.700 on phone and cloud).
- [ ] F10 · Stock as server-side deltas. Armed-peer race still loses a stock decrement: peer sells 1 (stock −1 → −2) while
      the phone's price edit is in its 1.5 s debounce; the phone's write lands after and blindly sets stock −1. Fix:
      - Module `buildOpsFromDiff` for products whose id has a known `shadow.stock[id]`: write the doc with
        `batch.set(ref, dataWithoutStock, { merge: true })` + `stock: increment(local.stock − shadow.stock[id])`
        (skip the stock field when the delta is 0); products without a known base keep writing the absolute stock.
        After dispatch set `shadow.stock[id] = local.stock`.
      - Listener: for products, do NOT skip own-device echoes when `remote.stock !== shadow.stock[id]` (the server value
        may combine other devices' deltas); emit the upsert with `_baseStock = shadow.stock[id]` so the app's existing
        three-way merge (`local = remote + (local − base)`) adds the missing deltas; skip only when nothing differs.
      - Keep F9 (_localPending) and B4 behaviour; `firstSync` keeps absolute values.
      - Tests: unit tests for the delta computation; e2e: two clients decrement the same product concurrently (A −2,
        B −1, both pushed before seeing each other, including A's push landing last) → both converge to base − 3 and
        Firestore holds base − 3; a price edit on A + sale on B in the same window → A's price and base − 1.
