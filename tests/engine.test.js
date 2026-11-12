const test = require('node:test');
const assert = require('node:assert/strict');
const GE = require('../engine.js');

test('tax: 2% rounded down, free under 50, capped at 5M', () => {
  assert.equal(GE.tax(49), 0);
  assert.equal(GE.tax(50), 1);
  assert.equal(GE.tax(99), 1);
  assert.equal(GE.tax(100), 2);
  assert.equal(GE.tax(1200), 24);
  assert.equal(GE.tax(60000), 1200);
  assert.equal(GE.tax(10000000), 200000);
  assert.equal(GE.tax(250000000), 5000000);
  assert.equal(GE.tax(1600000000), 5000000);
  assert.equal(GE.tax(3000000000), 5000000); // above 32-bit
  assert.equal(GE.tax(0), 0);
});

test('margin and break-even', () => {
  assert.equal(GE.margin(1245, 1310), 1310 - 26 - 1245);
  for (const buy of [1, 48, 49, 50, 51, 99, 100, 1245, 672664, 99999999, 260000000, 1500000000]) {
    const be = GE.breakEvenSell(buy);
    assert.ok(GE.netSell(be) >= buy, 'break-even covers cost for ' + buy);
    assert.ok(be === 1 || GE.netSell(be - 1) < buy, 'break-even is the smallest such price for ' + buy);
  }
});

test('parseGp and formatting', () => {
  assert.equal(GE.parseGp('10m'), 10000000);
  assert.equal(GE.parseGp('250k'), 250000);
  assert.equal(GE.parseGp('1.2b'), 1200000000);
  assert.equal(GE.parseGp('1,000,000'), 1000000);
  assert.equal(GE.parseGp(' 35M gp '), 35000000);
  assert.equal(GE.parseGp('abc'), null);
  assert.equal(GE.parseGp(''), null);
  assert.equal(GE.parseGp('-5'), null);
  assert.equal(GE.fmtGp(96000), '96K');
  assert.equal(GE.fmtGp(100000), '100K');
  assert.equal(GE.fmtGp(500300), '500K');
  assert.equal(GE.fmtGp(10000), '10K');
  assert.equal(GE.fmtGp(10000000), '10M');
  assert.equal(GE.fmtGp(200000000), '200M');
  assert.equal(GE.fmtGp(1000000000), '1B');
  assert.equal(GE.fmtGp(2500000), '2.5M');
  assert.equal(GE.fmtGp(0), '0');
  assert.equal(GE.fmtGp(999), '999');
  assert.equal(GE.fmtGp(2490000), '2.49M');
  assert.equal(GE.fmtGp(1245), '1,245');
  assert.equal(GE.fmtGp(12400), '12.4K');
  assert.equal(GE.fmtGp(1250000000), '1.25B');
  assert.equal(GE.fmtGp(-96000), '-96K');
  assert.equal(GE.fmtExact(672664), '672,664');
});

const NOW = 1794523200;
function mkt(over) {
  return Object.assign({
    latest: { 1: { high: 1310, highTime: NOW - 60, low: 1245, lowTime: NOW - 90 }, 561: { high: 100, highTime: NOW, low: 98, lowTime: NOW }, 554: { high: 5, highTime: NOW, low: 4, lowTime: NOW } },
    m5: { 1: { avgHighPrice: 1308, highPriceVolume: 900, avgLowPrice: 1247, lowPriceVolume: 800 } },
    h1: { 1: { avgHighPrice: 1305, highPriceVolume: 12000, avgLowPrice: 1250, lowPriceVolume: 10000 } },
    d1: { 1: { avgHighPrice: 1300, highPriceVolume: 250000, avgLowPrice: 1252, lowPriceVolume: 240000 } }
  }, over || {});
}
const ITEM = { id: 1, name: 'Test item', limit: 10000, highalch: 0, members: true };

test('active flip quote uses the conservative side of live and 1h prices', () => {
  const q = GE.flipQuote(ITEM, mkt(), 'active', { now: NOW, cash: 2500000 });
  assert.equal(q.buyAt, 1250);   // max(live low 1245, 1h avg low 1250)
  assert.equal(q.sellAt, 1305);  // min(live high 1310, 1h avg high 1305)
  assert.equal(q.per, 1305 - 26 - 1250);
  assert.equal(q.qty, Math.min(Math.floor(10000 * 0.15), Math.floor(2500000 / 1250), 10000));
  assert.equal(q.profit, q.per * q.qty);
  assert.equal(q.level, 'pass');
});

test('quantity respects cash, buy limit and volume share', () => {
  const m = mkt();
  assert.equal(GE.flipQuote(ITEM, m, 'active', { now: NOW, cash: 125000 }).qty, 100);            // cash
  assert.equal(GE.flipQuote(ITEM, m, 'active', { now: NOW, cash: 1e9, limitLeft: 40 }).qty, 40); // limit left
  assert.equal(GE.flipQuote(ITEM, m, 'active', { now: NOW, cash: 1e9 }).qty, 1500);              // 15% of 10,000
});

test('stale, illiquid, falling and too-good prices fail', () => {
  const stale = mkt(); stale.latest[1].lowTime = NOW - 3 * 3600;
  assert.equal(GE.flipQuote(ITEM, stale, 'active', { now: NOW, cash: 1e7 }).level, 'fail');
  const thin = mkt(); thin.h1[1].lowPriceVolume = 2;
  assert.equal(GE.flipQuote(ITEM, thin, 'active', { now: NOW, cash: 1e7 }).level, 'fail');
  const falling = mkt(); falling.d1[1] = { avgHighPrice: 1450, highPriceVolume: 250000, avgLowPrice: 1400, lowPriceVolume: 240000 };
  assert.equal(GE.flipQuote(ITEM, falling, 'active', { now: NOW, cash: 1e7 }).level, 'fail');
  const silly = mkt(); silly.latest[1].high = 2600; silly.h1[1].avgHighPrice = 2500;
  assert.equal(GE.flipQuote(ITEM, silly, 'active', { now: NOW, cash: 1e7 }).level, 'fail');
});

test('no quote when there is no profit after tax or data is missing', () => {
  const flat = mkt(); flat.latest[1].high = 1260; flat.h1[1].avgHighPrice = 1262;
  assert.equal(GE.flipQuote(ITEM, flat, 'active', { now: NOW, cash: 1e7 }), null);
  const none = mkt(); delete none.h1[1];
  assert.equal(GE.flipQuote(ITEM, none, 'active', { now: NOW, cash: 1e7 }), null);
  assert.equal(GE.flipQuote({ id: 13190, name: 'Old school bond', limit: 100 }, mkt(), 'active', { now: NOW, cash: 1e9 }), null);
});

test('a spread that only exists in the latest tick is not used', () => {
  const m = mkt(); m.latest[1].high = 1500; m.latest[1].low = 1100; // one stray trade each side
  const q = GE.flipQuote(ITEM, m, 'active', { now: NOW, cash: 1e7 });
  assert.equal(q.buyAt, 1250); assert.equal(q.sellAt, 1305);
  assert.ok(q.checks.some(c => c.key === 'outlier'));
});

/* synthetic history: price oscillates between low and high every few windows */
function wave(n, low, high, vol, period) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = Math.sin(i / period * 2 * Math.PI) * 3;
    out.push({ timestamp: NOW - (n - i) * 300, avgHighPrice: Math.round(high + s), highPriceVolume: vol, avgLowPrice: Math.round(low + s), lowPriceVolume: vol });
  }
  return out;
}

test('backtest: a steady, liquid spread wins most of the time', () => {
  const bt = GE.backtestFlip(wave(365, 1250, 1305, 500, 9), 'active', 100);
  assert.ok(bt.enough);
  assert.ok(bt.n >= 60, 'samples: ' + bt.n);
  assert.ok(bt.chance > 0.8, 'chance ' + bt.chance);
  assert.ok(bt.medianMinutes > 0 && bt.medianMinutes <= 120);
  assert.equal(bt.wins + bt.nofill + bt.stuck, bt.n);
});

test('backtest: a crashing price gets stuck with a loss', () => {
  const s = [];
  for (let i = 0; i < 365; i++) {
    const p = 2000 - i * 3;
    s.push({ timestamp: NOW - (365 - i) * 300, avgHighPrice: p + 40, highPriceVolume: 300, avgLowPrice: p, lowPriceVolume: 300 });
  }
  const bt = GE.backtestFlip(s, 'active', 50);
  assert.ok(bt.n > 0);
  assert.ok(bt.chance < 0.3, 'chance ' + bt.chance);
  assert.ok(bt.stuck > 0 && bt.stuckAvgPer < 0);
});

test('backtest: too little history reports not enough data', () => {
  const bt = GE.backtestFlip(wave(30, 1250, 1305, 500, 9), 'active', 100);
  assert.equal(bt.enough, false);
  assert.equal(bt.chance, null);
});

test('backtest: volume limits fills (big orders fill less often than small ones)', () => {
  const s = wave(365, 1250, 1305, 8, 9);
  const small = GE.backtestFlip(s, 'active', 2), big = GE.backtestFlip(s, 'active', 500);
  assert.ok(small.wins > big.wins);
  assert.equal(big.wins, 0);
});

test('NO LOOK-AHEAD: a decision at t never reads windows at or after t', () => {
  const base = wave(365, 1250, 1305, 500, 9);
  for (const mode of ['active', 'overnight']) {
    for (let t = GE.BT[mode].lookback; t < 300; t += 7) {
      let maxRead = -1;
      const spy = new Proxy(base, { get(target, prop) { const i = Number(prop); if (Number.isInteger(i)) maxRead = Math.max(maxRead, i); return target[prop]; } });
      GE.decideAt(spy, t, mode);
      assert.ok(maxRead < t, mode + ' decision at ' + t + ' read index ' + maxRead);
    }
  }
});

test('NO LOOK-AHEAD: changing the future never changes a past decision', () => {
  const a = wave(365, 1250, 1305, 500, 9);
  for (let t = 12; t < 340; t += 11) {
    const b = a.map((w, i) => i >= t ? Object.assign({}, w, { avgHighPrice: 9999, avgLowPrice: 1, highPriceVolume: 1e6, lowPriceVolume: 1e6 }) : w);
    assert.deepEqual(GE.decideAt(a, t, 'active'), GE.decideAt(b, t, 'active'));
  }
});

test('walk-forward returns predicted chance from the older part and outcomes from the newer part', () => {
  const wf = GE.walkForward(wave(365, 1250, 1305, 500, 9), 'active', 100);
  assert.ok(wf && wf.predicted > 0.8 && wf.n >= 8 && wf.wins <= wf.n);
});

test('verdicts', () => {
  const q = GE.flipQuote(ITEM, mkt(), 'active', { now: NOW, cash: 2500000 });
  assert.equal(GE.verdict(q, null).untested, true);
  assert.equal(GE.verdict(q, { enough: true, n: 50, wins: 45, stuck: 2, nofill: 3, chance: 0.9, stuckAvgPer: -10 }).word, 'Strong');
  assert.equal(GE.verdict(q, { enough: true, n: 50, wins: 30, stuck: 5, nofill: 15, chance: 0.6, stuckAvgPer: -10 }).word, 'OK');
  assert.equal(GE.verdict(q, { enough: true, n: 50, wins: 20, stuck: 25, nofill: 5, chance: 0.4, stuckAvgPer: -10 }).word, 'Risky');
  assert.equal(GE.verdict(q, { enough: true, n: 50, wins: 40, stuck: 10, nofill: 0, chance: 0.8, stuckAvgPer: -500 }).word, 'Risky'); // losses outweigh wins
  assert.equal(GE.verdict(q, { enough: false, n: 4, wins: 4 }).thin, true);
});

test('high alch: profit = alch value - item - nature rune, no tax', () => {
  const item = { id: 2, name: 'Rune thing', limit: 70, highalch: 39000, members: true };
  const m = mkt();
  m.latest[2] = { high: 38500, highTime: NOW - 120, low: 38300, lowTime: NOW - 200 };
  m.h1[2] = { avgHighPrice: 38480, highPriceVolume: 300, avgLowPrice: 38290, lowPriceVolume: 280 };
  m.d1[2] = { avgHighPrice: 38450, highPriceVolume: 6000, avgLowPrice: 38280, lowPriceVolume: 5800 };
  const q = GE.alchQuote(item, m, { fireStaff: true }, { now: NOW, cash: 1e7 });
  assert.equal(q.per, 39000 - 38500 - 100);
  assert.equal(q.maxPay, 39000 - 100 - 1);
  assert.equal(q.qty, 70);
  assert.equal(q.profit, 400 * 70);
  const noStaff = GE.alchQuote(item, m, { fireStaff: false }, { now: NOW, cash: 1e7 });
  assert.equal(noStaff.per, 39000 - 38500 - 100 - 25);
  m.latest[2].high = 38950;
  assert.equal(GE.alchQuote(item, m, { fireStaff: true }, { now: NOW, cash: 1e7 }), null); // 39000-38950-100 < 0
});

test('alch backtest counts windows where buying was profitable', () => {
  const s = wave(100, 38000, 38500, 20, 9);
  const all = GE.backtestAlch(s, 38899), none = GE.backtestAlch(s, 38000);
  assert.equal(all.chance, 1); assert.equal(none.chance, 0); assert.equal(all.n, 100);
});

test('buy-limit usage and cash tied up', () => {
  const trades = [
    { itemId: 1, qty: 300, buyPrice: 1000, placedAt: NOW - 3600, status: 'holding' },
    { itemId: 1, qty: 200, buyPrice: 1000, placedAt: NOW - 5 * 3600, status: 'done' },
    { itemId: 1, qty: 50, buyPrice: 1000, placedAt: NOW - 600, status: 'cancelled' },
    { itemId: 9, qty: 5, buyPrice: 100, placedAt: NOW - 600, status: 'buying' }
  ];
  const u = GE.limitUsage(1, trades, NOW);
  assert.equal(u.used, 300);
  assert.equal(u.resetAt, NOW - 3600 + 4 * 3600);
  assert.equal(GE.cashTiedUp(trades), 300 * 1000 + 5 * 100);
});

test('realized profit', () => {
  assert.equal(GE.realized({ status: 'done', kind: 'flip', buyPrice: 1250, soldPrice: 1305, qty: 100 }), (1305 - 26 - 1250) * 100);
  assert.equal(GE.realized({ status: 'done', kind: 'alch', buyPrice: 38500, alchValue: 39000, runeCost: 100, qty: 70 }), 400 * 70);
  assert.equal(GE.realized({ status: 'holding', kind: 'flip', buyPrice: 1, qty: 1 }), null);
});

test('advice on open offers', () => {
  const m = mkt();
  const buying = { itemId: 1, kind: 'flip', mode: 'active', status: 'buying', buyPrice: 1250, targetSell: 1305, qty: 100, placedAt: NOW - 600 };
  assert.equal(GE.advise(buying, m, NOW).tone, 'good');
  const gone = mkt(); gone.latest[1].high = 1255; gone.h1[1].avgHighPrice = 1256;
  assert.match(GE.advise(buying, gone, NOW).text, /Cancel/);
  const holding = { itemId: 1, kind: 'flip', mode: 'active', status: 'holding', buyPrice: 1250, targetSell: 1305, qty: 100, placedAt: NOW - 3600, boughtAt: NOW - 1800 };
  assert.equal(GE.advise(holding, m, NOW).tone, 'good');
  const slipped = mkt(); slipped.latest[1].high = 1290; slipped.h1[1].avgHighPrice = 1292;
  const adv = GE.advise(holding, slipped, NOW);
  assert.equal(adv.price, 1290); assert.match(adv.text, /Lower/);
  const crashed = mkt(); crashed.latest[1] = { high: 1150, highTime: NOW, low: 1120, lowTime: NOW }; crashed.h1[1] = { avgHighPrice: 1160, highPriceVolume: 9000, avgLowPrice: 1130, lowPriceVolume: 9000 };
  assert.match(GE.advise(holding, crashed, NOW).text, /Sell now/);
  const dipped = mkt(); dipped.latest[1] = { high: 1262, highTime: NOW, low: 1240, lowTime: NOW }; dipped.h1[1] = { avgHighPrice: 1270, highPriceVolume: 9000, avgLowPrice: 1262, lowPriceVolume: 9000 };
  const hold = GE.advise(holding, dipped, NOW);
  assert.match(hold.text, /Hold/); assert.equal(hold.price, GE.breakEvenSell(1250));
});
