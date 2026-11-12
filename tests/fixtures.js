// TEST-ONLY synthetic market in the same shape as the OSRS Wiki API. Never shipped.
const NOW = Math.floor(Date.now() / 1000);
const items = [
  { id: 1, name: 'Steady potion(4)', limit: 10000, highalch: 120, members: true, lo: 1250, hi: 1305, v: 12000, kind: 'wave' },
  { id: 2, name: 'Abyssal whip', limit: 70, highalch: 72000, members: true, lo: 672000, hi: 692000, v: 90, kind: 'wave' },
  { id: 3, name: 'Stale relic', limit: 100, highalch: 10, members: true, lo: 5000, hi: 5600, v: 400, kind: 'wave', stale: 5 * 3600 },
  { id: 4, name: 'Illiquid idol', limit: 10, highalch: 10, members: true, lo: 90000, hi: 99000, v: 2, kind: 'wave' },
  { id: 5, name: 'Falling knife', limit: 1000, highalch: 10, members: true, lo: 2000, hi: 2080, v: 3000, kind: 'crash' },
  { id: 6, name: 'Too good ring', limit: 100, highalch: 10, members: true, lo: 1000, hi: 1500, v: 800, kind: 'wave' },
  { id: 7, name: 'Rune platebody', limit: 70, highalch: 39000, members: false, lo: 38300, hi: 38500, v: 900, kind: 'wave' },
  { id: 8, name: 'Onyx bolts (e)', limit: 11000, highalch: 9000, members: true, lo: 8610, hi: 8650, v: 6000, kind: 'wave' },
  { id: 9, name: 'Dragon claws', limit: 8, highalch: 123000, members: true, lo: 45000000, hi: 46600000, v: 5, kind: 'slow' },
  { id: 10, name: 'Armadyl godsword', limit: 8, highalch: 750000, members: true, lo: 10100000, hi: 10420000, v: 6, kind: 'slow' },
  { id: 11, name: 'Shark', limit: 10000, highalch: 180, members: true, lo: 780, hi: 812, v: 40000, kind: 'wave' },
  { id: 12, name: 'Prayer potion(4)', limit: 2000, highalch: 100, members: true, lo: 9100, hi: 9420, v: 5000, kind: 'wave' },
  { id: 13, name: 'Mithril <script>bar', limit: 10000, highalch: 180, members: false, lo: 610, hi: 640, v: 9000, kind: 'wave' },
  { id: 561, name: 'Nature rune', limit: 18000, highalch: 108, members: false, lo: 98, hi: 100, v: 90000, kind: 'wave' },
  { id: 554, name: 'Fire rune', limit: 50000, highalch: 2, members: false, lo: 4, hi: 5, v: 200000, kind: 'wave' },
  { id: 13190, name: 'Old school bond', limit: 100, highalch: 0, members: false, lo: 13000000, hi: 14000000, v: 300, kind: 'wave' }
];
for (let i = 0; i < 40; i++) items.push({ id: 100 + i, name: 'Filler item ' + (i + 1), limit: 500, highalch: 5, members: i % 3 === 0, lo: 2000 + i * 37, hi: 2000 + i * 37 + (i % 7) * 9 + 30, v: 200 + i * 15, kind: 'wave' });

function series(it, step, n) {
  const sec = { '5m': 300, '1h': 3600, '6h': 21600, '24h': 86400 }[step], out = [];
  const scale = sec / 3600;
  for (let i = 0; i < n; i++) {
    const s = Math.sin(i / 9 * 2 * Math.PI) * (it.hi - it.lo) * 0.12;
    let lo = it.lo + s, hi = it.hi + s;
    if (it.kind === 'crash') { const d = (n - i) * (step === '5m' ? 3 : 30); lo += d; hi += d; }
    const v = Math.max(it.kind === 'slow' && step === '5m' ? (i % 4 === 0 ? 1 : 0) : 1, Math.round(it.v * scale * (0.8 + 0.4 * ((i * 7) % 5) / 5)));
    out.push({ timestamp: NOW - (n - i) * sec, avgHighPrice: v ? Math.round(hi) : null, highPriceVolume: v, avgLowPrice: v ? Math.round(lo) : null, lowPriceVolume: v });
  }
  return out;
}
const byId = Object.fromEntries(items.map(i => [i.id, i]));
function bulk(mult, wob) {
  const data = {};
  for (const it of items) {
    let lo = it.lo + wob, hi = it.hi - wob;
    if (it.kind === 'crash' && mult === 24) { lo += 300; hi += 300; }
    data[it.id] = { avgHighPrice: hi, highPriceVolume: Math.round(it.v * mult), avgLowPrice: lo, lowPriceVolume: Math.round(it.v * mult * 0.9) };
  }
  return { data, timestamp: NOW };
}
module.exports = {
  NOW,
  handle(url) {
    const u = new URL(url), p = u.pathname.replace('/api/v1/osrs', '');
    if (p === '/mapping') return items.map(it => ({ id: it.id, name: it.name, limit: it.limit, highalch: it.highalch, lowalch: Math.round(it.highalch * 0.66), members: it.members, icon: it.name + '.png', value: 1, examine: 'x' }));
    if (p === '/latest') { const data = {}; for (const it of items) data[it.id] = { high: it.hi, highTime: NOW - 40 - (it.stale || 0), low: it.lo, lowTime: NOW - 70 - (it.stale || 0) }; return { data }; }
    if (p === '/5m') return bulk(1 / 12, 1);
    if (p === '/1h') return bulk(1, 2);
    if (p === '/24h') return bulk(24, 3);
    if (p === '/timeseries') { const it = byId[+u.searchParams.get('id')]; return { data: it ? series(it, u.searchParams.get('timestep'), 365) : [], itemId: +u.searchParams.get('id') }; }
    return null;
  }
};
