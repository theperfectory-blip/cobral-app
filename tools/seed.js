// Seed realistic test data into the running app (emulator only — never on the real phone).
// Run: node tools/cdp.mjs -f tools/seed.js
(() => {
  let rnd = 42;
  const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rand() * a.length)];
  const products = state.products.filter(p => p.salePrice > 0);
  const pays = ['efectivo', 'efectivo', 'efectivo', 'debito', 'credito', 'transferencia'];
  const sales = [];
  const now = new Date();
  let num = 1;
  for (let day = 75; day >= 0; day--) {
    const n = day === 0 ? 6 : 2 + Math.floor(rand() * 5);
    for (let k = 0; k < n; k++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day, 10 + Math.floor(rand() * 9), Math.floor(rand() * 60));
      if (d > now) d.setTime(now.getTime() - (n - k) * 60000);
      // ~1 in 3 sales has 5-8 distinct products
      const count = rand() < 0.35 ? 5 + Math.floor(rand() * 4) : 1 + Math.floor(rand() * 3);
      const chosen = new Map();
      while (chosen.size < count) { const p = pick(products); chosen.set(p.id, p); }
      const items = [...chosen.values()].map(p => ({
        productId: p.id, name: p.name, price: p.salePrice, costPrice: p.costPrice,
        qty: p.unit === 'g' ? (p.gramStep || 250) * (1 + Math.floor(rand() * 3)) : 1 + Math.floor(rand() * 3), unit: p.unit || 'u',
      }));
      const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
      const totalCost = items.reduce((s, i) => s + i.costPrice * i.qty, 0);
      const paymentMethod = pick(pays);
      const fee = paymentMethod === 'debito' ? subtotal * state.debitFee / 100 : paymentMethod === 'credito' ? subtotal * state.creditFee / 100 : 0;
      const finalAmount = subtotal - fee;
      sales.push({
        id: d.getTime() + k, numVenta: num++, items, subtotal, fee, finalAmount, totalCost,
        margin: finalAmount - totalCost, marginPct: finalAmount ? (finalAmount - totalCost) / finalAmount * 100 : 0,
        paymentMethod, date: d.toISOString(), location: state.locations[d.getDay()] || 'Libre', isAbono: false,
      });
    }
  }
  state.sales = sales;
  state.debts = [
    { id: 1, name: 'Doña Rosa', items: [{ productId: products[0].id, name: products[0].name, price: products[0].salePrice, costPrice: products[0].costPrice, qty: 2, unit: 'u' }], total: products[0].salePrice * 2, totalCost: products[0].costPrice * 2, remaining: products[0].salePrice * 2, date: new Date(now - 3 * 864e5).toISOString(), location: 'Metro' },
  ];
  state.userName = 'Jimbo (emulador)';
  saveData();
  setTimeout(() => location.reload(), 100);
  return `seeded ${sales.length} sales, ${sales.filter(s => s.items.length >= 5).length} with 5+ products`;
})()
