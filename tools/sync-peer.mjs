// A second "device" for sync tests: a Node client of cloud-src/cobral-cloud.js pinned to the LOCAL
// Firebase emulators (tools/emulators.sh). Never talks to the real cobral-app project.
// Usage:
//   node tools/sync-peer.mjs signup  <email> <pass>
//   node tools/sync-peer.mjs dump    <email> <pass>
//   node tools/sync-peer.mjs add-sale <email> <pass> <productName>     (sells 1 unit of that product)
//   node tools/sync-peer.mjs delete-sale <email> <pass> <numVenta>
//   node tools/sync-peer.mjs watch   <email> <pass> <seconds>          (prints remote changes)
import { createClient } from '../cloud-src/cobral-cloud.js';

const [cmd, email, pass, arg] = process.argv.slice(2);
const config = { apiKey: 'emulator-fake-api-key', authDomain: 'cobral-app.firebaseapp.com', projectId: 'cobral-app', appId: '1:60325446787:web:292ff3035908f69c2f07b6' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const empty = () => ({ sales: [], products: [], debts: [], debtHistory: [], settings: null });

const client = createClient();
const remote = [];
let user = null;
client.init({ config, emulatorHost: '127.0.0.1', onUser: u => { user = u; }, onRemote: c => remote.push(c) });

const auth = cmd === 'signup' ? await client.signUp(email, pass) : await client.signIn(email, pass);
if (!auth.ok) { console.log('AUTH FAIL: ' + auth.message); process.exit(1); }
for (let i = 0; i < 50 && !user; i++) await sleep(100);

const snap = await client.firstSync(empty());
const summary = s => `sales=${s.sales.length} products=${s.products.length} debts=${s.debts.length} lastTicket=#${Math.max(0, ...s.sales.map(x => x.numVenta || 0))}`;

if (cmd === 'signup' || cmd === 'dump') {
  console.log(summary(snap));
} else if (cmd === 'add-sale') {
  const p = snap.products.find(x => x.name === arg) || snap.products[0];
  const num = Math.max(0, ...snap.sales.map(x => x.numVenta || 0)) + 1;
  const sale = { id: Date.now(), numVenta: num, items: [{ productId: p.id, name: p.name, price: p.salePrice, costPrice: p.costPrice, qty: 1, unit: p.unit || 'u' }],
    subtotal: p.salePrice, fee: 0, finalAmount: p.salePrice, totalCost: p.costPrice, margin: p.salePrice - p.costPrice,
    marginPct: (p.salePrice - p.costPrice) / p.salePrice * 100, paymentMethod: 'efectivo', date: new Date().toISOString(), location: 'Peer', isAbono: false };
  p.stock -= 1;
  client.push({ ...snap, sales: [...snap.sales, sale] });
  await sleep(2500);
  console.log(`pushed sale #${num} (${p.name} $${p.salePrice}) id=${sale.id}; status=${client.status()}`);
} else if (cmd === 'delete-sale') {
  const n = Number(arg);
  client.push({ ...snap, sales: snap.sales.filter(s => s.numVenta !== n) });
  await sleep(2500);
  console.log(`deleted sale #${n}; status=${client.status()}`);
} else if (cmd === 'watch') {
  await sleep(Number(arg || 10) * 1000);
  for (const c of remote) console.log(`${c.collection}: +${c.upserts.length} -${c.deletes.length} ${c.upserts.slice(0, 3).map(u => u.numVenta ? '#' + u.numVenta : (u.name || u.id)).join(',')}`);
  console.log(summary(snap) + ` | remote events=${remote.length}`);
}
await client.signOut();
process.exit(0);
