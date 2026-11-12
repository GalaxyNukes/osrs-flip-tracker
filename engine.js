/* GE Flip Tracker engine: every number shown in the app is computed here.
   Pure functions, no network, no DOM. Runs in the browser and in Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Game rules. Jagex changes these from time to time: edit here only. */
  var RULES = {
    taxDivisor: 50,            // 2% of the sell price, rounded down
    taxCap: 5000000,           // at most 5M tax per item
    buyLimitHours: 4,
    slotsMembers: 8,
    slotsF2P: 3,
    natureRuneId: 561,
    fireRuneId: 554,
    fireRunesPerCast: 5,
    castsPerHour: 1200,
    excludedIds: { 13190: true } // bonds: not flippable once bought
  };

  /* ---------- money maths ---------- */
  function tax(price) {
    if (!(price > 0)) return 0;
    return Math.min(Math.floor(price / RULES.taxDivisor), RULES.taxCap);
  }
  function netSell(price) { return price - tax(price); }
  function margin(buy, sell) { return netSell(sell) - buy; }
  function breakEvenSell(buy) {
    var s = Math.max(1, Math.min(Math.ceil(buy * 50 / 49), buy + RULES.taxCap));
    while (s > 1 && netSell(s - 1) >= buy) s--;
    while (netSell(s) < buy) s++;
    return s;
  }

  function parseGp(text) {
    if (typeof text === 'number') return isFinite(text) && text >= 0 ? Math.floor(text) : null;
    var s = String(text || '').trim().toLowerCase().replace(/[, _]/g, '').replace(/gp$/, '');
    var m = /^(\d+(?:\.\d+)?)([kmb]?)$/.exec(s);
    if (!m) return null;
    var mult = { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]];
    var v = Math.round(parseFloat(m[1]) * mult);
    return isFinite(v) ? v : null;
  }
  function fmtExact(n) {
    if (n == null || !isFinite(n)) return '?';
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtGp(n) {
    if (n == null || !isFinite(n)) return '?';
    var a = Math.abs(n), sign = n < 0 ? '-' : '';
    function trim(x, d) { var t = x.toFixed(d); return t.indexOf('.') >= 0 ? t.replace(/\.?0+$/, '') : t; }
    if (a < 10000) return sign + fmtExact(a);
    if (a < 1e6) return sign + trim(a / 1e3, a < 1e5 ? 1 : 0) + 'K';
    if (a < 1e9) return sign + trim(a / 1e6, a < 1e8 ? 2 : 1) + 'M';
    return sign + trim(a / 1e9, 2) + 'B';
  }

  /* ---------- helpers ---------- */
  function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
  function mid(a, b) { return a != null && b != null ? (a + b) / 2 : null; }
  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function check(key, level, text) { return { key: key, level: level, text: text }; }
  function worst(checks) {
    var w = 'pass';
    for (var i = 0; i < checks.length; i++) {
      if (checks[i].level === 'fail') return 'fail';
      if (checks[i].level === 'warn') w = 'warn';
    }
    return w;
  }
  function ageMin(now, t) { return t ? Math.max(0, (now - t) / 60) : Infinity; }

  /* ---------- flip quote ----------
     mode 'active'   : buy and sell within about an hour, priced from live + 1h data
     mode 'overnight': patient offers at the 24h average prices
     ctx: { now (unix s), cash (gp available for this item), limitLeft (or null) } */
  function flipQuote(item, mkt, mode, ctx) {
    if (!item || RULES.excludedIds[item.id]) return null;
    var l = mkt.latest[item.id], h = mkt.h1[item.id], f = mkt.m5[item.id], d = mkt.d1[item.id];
    if (!l || num(l.high) == null || num(l.low) == null) return null;
    var hLow = h && num(h.avgLowPrice), hHigh = h && num(h.avgHighPrice);
    var dLow = d && num(d.avgLowPrice), dHigh = d && num(d.avgHighPrice);
    var buyAt, sellAt;
    if (mode === 'active') {
      if (hLow == null || hHigh == null) return null;
      buyAt = Math.round(Math.max(l.low, hLow));   // never assume a cheaper buy than the hour shows
      sellAt = Math.round(Math.min(l.high, hHigh)); // never assume a dearer sale than the hour shows
    } else {
      if (dLow == null || dHigh == null) return null;
      buyAt = Math.round(dLow);
      sellAt = Math.round(dHigh);
    }
    if (!(buyAt > 0) || !(sellAt > buyAt)) return null;
    var per = margin(buyAt, sellAt);
    if (per <= 0) return null;

    var v1 = h ? Math.min(h.highPriceVolume || 0, h.lowPriceVolume || 0) : 0;
    var v1max = h ? Math.max(h.highPriceVolume || 0, h.lowPriceVolume || 0) : 0;
    var vd = d ? Math.min(d.highPriceVolume || 0, d.lowPriceVolume || 0) : 0;
    var vdmax = d ? Math.max(d.highPriceVolume || 0, d.lowPriceVolume || 0) : 0;

    var volCap = mode === 'active'
      ? Math.max(v1 >= 6 ? 1 : 0, Math.floor(v1 * 0.08))   // small enough to fill within the hour
      : Math.max(vd >= 20 ? 1 : 0, Math.floor(vd * 0.02));  // small enough to fill overnight
    var afford = Math.floor((ctx.cash || 0) / buyAt);
    var limit = item.limit > 0 ? item.limit : null;
    var limitLeft = ctx.limitLeft != null ? ctx.limitLeft : limit;
    var qty = Math.min(volCap, afford, limitLeft != null ? limitLeft : Infinity);
    var capBy = qty === afford ? 'cash' : (limitLeft != null && qty === limitLeft ? 'limit' : 'volume');
    if (!isFinite(qty) || qty < 0) qty = 0;

    var now = ctx.now, checks = [];
    var aH = ageMin(now, l.highTime), aL = ageMin(now, l.lowTime), age = Math.max(aH, aL);
    if (mode === 'active') {
      if (age <= 15) checks.push(check('fresh', 'pass', 'Both prices traded in the last 15 minutes'));
      else if (age <= 60) checks.push(check('fresh', 'warn', 'One price is ' + Math.round(age) + ' minutes old'));
      else checks.push(check('fresh', 'fail', 'Prices are stale: last trade ' + fmtAge(age) + ' ago'));
      if (v1 >= 30) checks.push(check('liquid', 'pass', 'Trades often: ' + fmtExact(v1) + '+ an hour on each side'));
      else if (v1 >= 6) checks.push(check('liquid', 'warn', 'Trades slowly: about ' + v1 + ' an hour on the quiet side'));
      else checks.push(check('liquid', 'fail', 'Hardly trades: ' + v1 + ' an hour on the quiet side'));
    } else {
      if (age <= 240) checks.push(check('fresh', 'pass', 'Traded on both sides in the last 4 hours'));
      else if (age <= 1440) checks.push(check('fresh', 'warn', 'Last trade on one side was ' + fmtAge(age) + ' ago'));
      else checks.push(check('fresh', 'fail', 'Prices are stale: last trade ' + fmtAge(age) + ' ago'));
      if (vd >= 20) checks.push(check('liquid', 'pass', 'Trades daily: ' + fmtExact(vd) + '+ a day on each side'));
      else if (vd >= 8) checks.push(check('liquid', 'warn', 'Trades slowly: about ' + vd + ' a day on the quiet side'));
      else checks.push(check('liquid', 'fail', 'Hardly trades: ' + vd + ' a day on the quiet side'));
    }
    var big = mode === 'active' ? v1max : vdmax, small = mode === 'active' ? v1 : vd;
    if (big > 0 && small / big < 0.05) checks.push(check('balance', 'warn', 'One side trades far less than the other'));

    // does the gap hold across recent windows?
    var m1 = hLow != null && hHigh != null ? margin(Math.round(hLow), Math.round(hHigh)) : null;
    var m5 = f && num(f.avgLowPrice) != null && num(f.avgHighPrice) != null
      ? margin(Math.round(f.avgLowPrice), Math.round(f.avgHighPrice)) : null;
    var live = margin(l.low, l.high);
    if (mode === 'active') {
      if (m1 != null && m1 > 0 && (m5 == null || m5 > 0)) checks.push(check('holds', 'pass', 'The gap has held over the last hour'));
      else if (m1 != null && m1 > 0) checks.push(check('holds', 'warn', 'The gap closed in the last 5 minutes'));
      else checks.push(check('holds', 'fail', 'No profit at the average prices of the last hour'));
      if (live > per * 3 && live - per > 2) checks.push(check('outlier', 'warn', 'The gap right now is unusually wide; the card uses the normal prices'));
    } else {
      if (m1 == null || m1 > 0) checks.push(check('holds', 'pass', 'The gap shows in both the 24 hour and 1 hour averages'));
      else checks.push(check('holds', 'warn', 'No gap in the last hour; it only shows across the day'));
    }

    // trend: last hour against the day
    var midH = mid(hLow, hHigh), midD = mid(dLow, dHigh), midL = mid(l.low, l.high);
    var ref = midH != null ? midH : midL;
    var trend = midD ? (ref - midD) / midD : null;
    if (trend == null) checks.push(check('trend', 'warn', 'No 24 hour average to compare the price with'));
    else if (trend <= -0.07) checks.push(check('trend', 'fail', 'Price is falling fast: ' + pct(trend) + ' against the day'));
    else if (trend <= -0.03) checks.push(check('trend', 'warn', 'Price is slipping: ' + pct(trend) + ' against the day'));
    else if (trend >= 0.07) checks.push(check('trend', 'warn', 'Price jumped ' + pct(trend) + ' against the day and may fall back'));
    else checks.push(check('trend', 'pass', 'Price is steady against the day'));

    var roi = per / buyAt, gap = sellAt - buyAt;
    if (gap <= 3) checks.push(check('tick', 'fail', 'The gap is only ' + gap + ' gp, the smallest steps a price can move. Bots queue at these prices, so your offer may never be reached'));
    if (roi > 0.25) checks.push(check('sane', 'fail', 'Too good to be true: ' + pct(roi) + ' profit usually means a broken price'));
    else if (roi > 0.10) checks.push(check('sane', 'warn', 'Very wide gap (' + pct(roi) + '); these rarely last'));
    if (midH != null && Math.abs(midL - midH) / midH > 0.05) checks.push(check('jump', 'warn', 'The latest trades are far from the hourly average'));
    if (limit == null) checks.push(check('limit', 'warn', 'Buy limit unknown'));

    return {
      id: item.id, name: item.name, mode: mode, kind: 'flip',
      buyAt: buyAt, sellAt: sellAt, per: per, roi: roi, tax: tax(sellAt),
      qty: qty, capBy: capBy, cost: buyAt * qty, profit: per * qty,
      limit: limit, limitLeft: limitLeft, vol1h: v1, vol24h: vd, ageMin: age, trend: trend,
      checks: checks, level: worst(checks)
    };
  }
  function pct(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0) + '%'; }
  function fmtAge(min) {
    if (!isFinite(min)) return 'a long time';
    if (min < 1) return 'under a minute';
    if (min < 90) return Math.round(min) + ' min';
    if (min < 2880) return Math.round(min / 60) + ' hours';
    return Math.round(min / 1440) + ' days';
  }

  /* ---------- backtest ----------
     Replays history. A decision at index t reads only windows before t.
     series: [{timestamp, avgHighPrice, highPriceVolume, avgLowPrice, lowPriceVolume}] oldest first */
  var BT = {
    active: { lookback: 12, horizon: 24, step: 4, stepMin: 5, share: 0.3 },
    overnight: { lookback: 24, horizon: 16, step: 3, stepMin: 60, share: 0.3 }
  };
  function decideAt(series, t, mode) {
    var p = BT[mode], lo = 0, loV = 0, hi = 0, hiV = 0, lastLow = null, lastHigh = null;
    for (var i = t - p.lookback; i < t; i++) {
      var w = series[i];
      if (!w) return null;
      if (w.avgLowPrice != null && w.lowPriceVolume > 0) { lo += w.avgLowPrice * w.lowPriceVolume; loV += w.lowPriceVolume; lastLow = w.avgLowPrice; }
      if (w.avgHighPrice != null && w.highPriceVolume > 0) { hi += w.avgHighPrice * w.highPriceVolume; hiV += w.highPriceVolume; lastHigh = w.avgHighPrice; }
    }
    if (!loV || !hiV) return null;
    var avgLow = lo / loV, avgHigh = hi / hiV, buyAt, sellAt;
    if (mode === 'active') { buyAt = Math.round(Math.max(lastLow, avgLow)); sellAt = Math.round(Math.min(lastHigh, avgHigh)); }
    else { buyAt = Math.round(avgLow); sellAt = Math.round(avgHigh); }
    if (!(sellAt > buyAt) || margin(buyAt, sellAt) <= 0) return null;
    return { buyAt: buyAt, sellAt: sellAt };
  }
  function simulate(series, t, dec, qty, mode) {
    var p = BT[mode], end = t + p.horizon, need = Math.max(1, qty), got = 0, i, w, boughtAt = -1;
    var buyDeadline = t + Math.ceil(p.horizon / 2);
    for (i = t; i < buyDeadline; i++) {
      w = series[i];
      if (w.avgLowPrice != null && w.lowPriceVolume > 0 && w.avgLowPrice <= dec.buyAt) {
        got += w.lowPriceVolume * p.share;
        if (got >= need) { boughtAt = i; break; }
      }
    }
    var held = boughtAt >= 0 ? need : Math.floor(got);
    if (held < 1) return { outcome: 'nofill' };
    if (boughtAt < 0) boughtAt = buyDeadline - 1;
    var sold = 0;
    for (i = boughtAt + 1; i < end; i++) {
      w = series[i];
      if (w.avgHighPrice != null && w.highPriceVolume > 0 && w.avgHighPrice >= dec.sellAt) {
        sold += w.highPriceVolume * p.share;
        if (sold >= held) return { outcome: 'win', minutes: (i - t + 1) * p.stepMin, full: held === need };
      }
    }
    var exit = null;
    for (i = end - 1; i >= boughtAt; i--) { if (series[i].avgLowPrice != null) { exit = series[i].avgLowPrice; break; } }
    if (exit == null) exit = dec.buyAt;
    return { outcome: 'stuck', perUnit: margin(dec.buyAt, Math.round(exit)) };
  }
  function backtestFlip(series, mode, qty, range) {
    var p = BT[mode], res = { mode: mode, n: 0, wins: 0, nofill: 0, stuck: 0, minutes: [], stuckPer: [], from: null, to: null };
    if (!series || series.length < p.lookback + p.horizon + 1) return finish(res);
    var start = range ? Math.max(p.lookback, range[0]) : p.lookback;
    var stop = range ? Math.min(series.length - p.horizon, range[1]) : series.length - p.horizon;
    for (var t = start; t <= stop; t += p.step) {
      var dec = decideAt(series, t, mode);
      if (!dec) continue;
      var r = simulate(series, t, dec, qty, mode);
      res.n++;
      if (res.from == null) res.from = series[t].timestamp;
      res.to = series[t].timestamp;
      if (r.outcome === 'win' && r.full) { res.wins++; res.minutes.push(r.minutes); }
      else if (r.outcome === 'win' || r.outcome === 'nofill') res.nofill++; // part-fills count as not filled: no loss, but not the full profit
      else { res.stuck++; res.stuckPer.push(r.perUnit); }
    }
    return finish(res);
  }
  var MIN_SAMPLES = 15;
  function finish(res) {
    res.enough = res.n >= MIN_SAMPLES;
    res.chance = res.enough ? res.wins / res.n : null;
    res.medianMinutes = median(res.minutes);
    res.stuckAvgPer = res.stuckPer.length ? res.stuckPer.reduce(function (a, b) { return a + b; }, 0) / res.stuckPer.length : 0;
    delete res.minutes; delete res.stuckPer;
    return res;
  }
  /* Honesty check: rate the flip on the older 60% of history, then see what
     the newer 40% actually did. Feeds the Accuracy page. */
  function walkForward(series, mode, qty) {
    var p = BT[mode];
    if (!series || series.length < (p.lookback + p.horizon) * 3) return null;
    var cut = Math.floor(series.length * 0.6);
    var a = backtestFlip(series, mode, qty, [p.lookback, cut - p.horizon]);
    var b = backtestFlip(series, mode, qty, [cut, series.length - p.horizon]);
    if (!a.enough || b.n < 8) return null;
    return { predicted: a.chance, n: b.n, wins: b.wins };
  }

  /* expected gp per attempt, counting the times it gets stuck */
  function expectedValue(q, bt) {
    if (!bt || !bt.enough) return null;
    var win = bt.wins / bt.n, stuck = bt.stuck / bt.n;
    return win * q.profit + stuck * bt.stuckAvgPer * q.qty;
  }
  function verdict(q, bt) {
    if (q.level === 'fail') return { word: 'Risky', cls: 'risky' };
    if (!bt) return { word: q.level === 'pass' ? 'Looks OK' : 'Risky', cls: q.level === 'pass' ? 'ok' : 'risky', untested: true };
    if (!bt.enough) return { word: q.level === 'pass' ? 'OK' : 'Risky', cls: q.level === 'pass' ? 'ok' : 'risky', thin: true };
    var ev = expectedValue(q, bt);
    if (ev <= 0 || bt.chance < 0.5) return { word: 'Risky', cls: 'risky' };
    if (bt.chance >= 0.75 && q.level === 'pass') return { word: 'Strong', cls: 'strong' };
    return { word: 'OK', cls: 'ok' };
  }

  /* ---------- high alch ---------- */
  function runeCost(mkt, settings) {
    var n = mkt.latest[RULES.natureRuneId];
    if (!n || num(n.high) == null) return null;
    var c = n.high;
    if (!settings.fireStaff) {
      var fr = mkt.latest[RULES.fireRuneId];
      if (!fr || num(fr.high) == null) return null;
      c += fr.high * RULES.fireRunesPerCast;
    }
    return c;
  }
  function alchQuote(item, mkt, settings, ctx) {
    if (!item || !(item.highalch > 0) || RULES.excludedIds[item.id]) return null;
    if (item.id === RULES.natureRuneId || item.id === RULES.fireRuneId) return null;
    var l = mkt.latest[item.id], h = mkt.h1[item.id], d = mkt.d1[item.id];
    var rc = runeCost(mkt, settings);
    if (rc == null || !l || num(l.high) == null) return null;
    var buyAt = l.high;                         // pay the instant-buy price
    var per = item.highalch - buyAt - rc;       // no GE tax: nothing is sold
    if (per <= 0) return null;
    var maxPay = item.highalch - rc - 1;        // dearest price that still profits
    var vd = d ? (d.highPriceVolume || 0) + (d.lowPriceVolume || 0) : 0;
    var v1 = h ? (h.highPriceVolume || 0) + (h.lowPriceVolume || 0) : 0;
    var volCap = d ? Math.floor(vd * 0.05) : Math.floor(v1 * 0.5);
    var limit = item.limit > 0 ? item.limit : null;
    var limitLeft = ctx.limitLeft != null ? ctx.limitLeft : limit;
    var afford = Math.floor((ctx.cash || 0) / (buyAt + rc));
    var batchCap = RULES.castsPerHour * RULES.buyLimitHours;
    var qty = Math.min(volCap, afford, batchCap, limitLeft != null ? limitLeft : Infinity);
    if (!isFinite(qty) || qty < 0) qty = 0;

    var checks = [], age = ageMin(ctx.now, l.highTime);
    if (age <= 30) checks.push(check('fresh', 'pass', 'Bought at this price in the last 30 minutes'));
    else if (age <= 180) checks.push(check('fresh', 'warn', 'Last bought at this price ' + fmtAge(age) + ' ago'));
    else checks.push(check('fresh', 'fail', 'Price is stale: last bought ' + fmtAge(age) + ' ago'));
    if (vd >= 400) checks.push(check('liquid', 'pass', 'Plenty for sale: ' + fmtGp(vd) + ' traded today'));
    else if (vd >= 60) checks.push(check('liquid', 'warn', 'Limited supply: ' + fmtExact(vd) + ' traded today'));
    else checks.push(check('liquid', 'fail', 'Hardly any for sale: ' + vd + ' traded today'));
    var hHigh = h && num(h.avgHighPrice);
    if (hHigh != null && hHigh > maxPay) checks.push(check('holds', 'warn', 'It usually costs more than this; the cheap price may not last'));
    else if (hHigh != null) checks.push(check('holds', 'pass', 'It has been this cheap for the last hour'));
    else checks.push(check('holds', 'warn', 'No trades in the last hour to confirm the price'));
    var roi = per / buyAt;
    if (roi > 0.2) checks.push(check('sane', 'fail', 'Too good to be true: the price is probably wrong'));
    else if (per < Math.max(5, buyAt * 0.003)) checks.push(check('thin', 'warn', 'Thin profit: a small price rise wipes it out'));
    if (limit == null) checks.push(check('limit', 'warn', 'Buy limit unknown'));

    return {
      id: item.id, name: item.name, kind: 'alch', mode: 'alch',
      buyAt: buyAt, maxPay: maxPay, alchValue: item.highalch, runeCost: rc, per: per, roi: roi,
      qty: qty, cost: (buyAt + rc) * qty, itemCost: buyAt * qty, profit: per * qty,
      minutes: Math.ceil(qty / RULES.castsPerHour * 60),
      limit: limit, limitLeft: limitLeft, vol24h: vd, ageMin: age,
      checks: checks, level: worst(checks)
    };
  }
  /* How often could you have bought at a profitable price? */
  function backtestAlch(series, maxPay) {
    var n = 0, ok = 0, from = null, to = null;
    for (var i = 0; i < (series ? series.length : 0); i++) {
      var w = series[i];
      if (w.avgHighPrice == null || !(w.highPriceVolume > 0)) continue;
      n++; if (w.avgHighPrice <= maxPay) ok++;
      if (from == null) from = w.timestamp; to = w.timestamp;
    }
    return { mode: 'alch', n: n, wins: ok, enough: n >= MIN_SAMPLES, chance: n >= MIN_SAMPLES ? ok / n : null, from: from, to: to };
  }
  function alchVerdict(q, bt) {
    if (q.level === 'fail') return { word: 'Risky', cls: 'risky' };
    if (!bt) return { word: q.level === 'pass' ? 'Looks OK' : 'Risky', cls: q.level === 'pass' ? 'ok' : 'risky', untested: true };
    if (!bt.enough) return { word: q.level === 'pass' ? 'OK' : 'Risky', cls: q.level === 'pass' ? 'ok' : 'risky', thin: true };
    if (bt.chance < 0.5) return { word: 'Risky', cls: 'risky' };
    if (bt.chance >= 0.8 && q.level === 'pass') return { word: 'Strong', cls: 'strong' };
    return { word: 'OK', cls: 'ok' };
  }

  /* ---------- trades ---------- */
  function limitUsage(itemId, trades, now) {
    var windowS = RULES.buyLimitHours * 3600, used = 0, first = null;
    for (var i = 0; i < trades.length; i++) {
      var t = trades[i];
      if (t.itemId !== itemId || t.status === 'cancelled') continue;
      if (now - t.placedAt < windowS) { used += t.qty; if (first == null || t.placedAt < first) first = t.placedAt; }
    }
    return { used: used, resetAt: first != null ? first + windowS : null };
  }
  function isOpen(t) { return t.status === 'buying' || t.status === 'holding'; }
  function cashTiedUp(trades) {
    var c = 0;
    for (var i = 0; i < trades.length; i++) if (isOpen(trades[i])) c += trades[i].buyPrice * trades[i].qty;
    return c;
  }
  function realized(t) {
    if (t.status !== 'done') return null;
    if (t.kind === 'alch') return (t.alchValue - t.buyPrice - (t.runeCost || 0)) * t.qty;
    return margin(t.buyPrice, t.soldPrice) * t.qty;
  }
  /* What to do with an offer that is already in. Returns {tone, text, why, price?} */
  function advise(t, mkt, now) {
    var l = mkt.latest[t.itemId], h = mkt.h1[t.itemId], d = mkt.d1[t.itemId];
    if (!l || num(l.high) == null || num(l.low) == null) return { tone: 'muted', text: 'No live price right now', why: 'The feed has no recent trades for this item.' };
    var hHigh = h && num(h.avgHighPrice), hLow = h && num(h.avgLowPrice);
    var waited = (now - (t.status === 'holding' ? (t.boughtAt || t.placedAt) : t.placedAt)) / 60;
    if (t.kind === 'alch') {
      if (t.status === 'buying') {
        if (l.high > t.maxPay) return { tone: 'bad', text: 'Cancel the buy offer', why: 'It now costs ' + fmtExact(l.high) + ' gp, more than the ' + fmtExact(t.maxPay) + ' gp you can pay and still profit.' };
        return { tone: 'good', text: 'On track', why: 'Still profitable to alch at the current price.' };
      }
      return { tone: 'good', text: 'Alch them all', why: 'Alch value is fixed at ' + fmtExact(t.alchValue) + ' gp each, so the profit is locked in.' };
    }
    var ask = Math.round(hHigh != null ? Math.min(l.high, hHigh) : l.high);
    if (t.status === 'buying') {
      var nowPer = margin(t.buyPrice, ask);
      if (nowPer <= 0) return { tone: 'bad', text: 'Cancel the buy offer', why: 'It now sells for about ' + fmtExact(ask) + ' gp, so buying at ' + fmtExact(t.buyPrice) + ' gp no longer profits.' };
      var slow = t.mode === 'overnight' ? 720 : 45;
      if (l.low > t.buyPrice * 1.01 && waited > slow) return { tone: 'warn', text: 'Unlikely to fill: cancel or raise', why: 'People now sell for ' + fmtExact(l.low) + ' gp, above your ' + fmtExact(t.buyPrice) + ' gp offer, and you have waited ' + fmtAge(waited) + '.' };
      return { tone: 'good', text: 'On track', why: 'Still ' + fmtGp(nowPer) + ' gp profit each at current prices.' };
    }
    // holding: bought, sell offer in
    var target = t.targetSell, be = breakEvenSell(t.buyPrice);
    if (ask >= target * 0.997) return { tone: 'good', text: 'On track', why: 'It still sells for about ' + fmtExact(ask) + ' gp. Keep your sell offer at ' + fmtExact(target) + ' gp.' };
    if (ask >= be) return { tone: 'warn', text: 'Lower your sell price to ' + fmtExact(ask), price: ask, why: 'The market slipped. At ' + fmtExact(ask) + ' gp you still make ' + fmtGp(margin(t.buyPrice, ask)) + ' gp each.' };
    var midH = mid(hLow, hHigh), midD = d ? mid(num(d.avgLowPrice), num(d.avgHighPrice)) : null;
    var falling = midH != null && midD != null && (midH - midD) / midD < -0.03;
    var lossNow = margin(t.buyPrice, l.low) * t.qty;
    if (falling) return { tone: 'bad', text: 'Sell now at ' + fmtExact(l.low) + ' to limit the loss', price: l.low, why: 'The price is below what you paid and still falling against the day. Selling now loses about ' + fmtGp(-lossNow) + ' gp.' };
    return { tone: 'warn', text: 'Hold: set your sell price to ' + fmtExact(be), price: be, why: 'It dipped below your break-even of ' + fmtExact(be) + ' gp but is not falling against the day. Selling right now would lose about ' + fmtGp(-lossNow) + ' gp.' };
  }

  return {
    RULES: RULES, BT: BT, MIN_SAMPLES: MIN_SAMPLES,
    tax: tax, netSell: netSell, margin: margin, breakEvenSell: breakEvenSell,
    parseGp: parseGp, fmtGp: fmtGp, fmtExact: fmtExact, fmtAge: fmtAge, pct: pct, median: median,
    flipQuote: flipQuote, decideAt: decideAt, simulate: simulate, backtestFlip: backtestFlip, walkForward: walkForward,
    expectedValue: expectedValue, verdict: verdict,
    runeCost: runeCost, alchQuote: alchQuote, backtestAlch: backtestAlch, alchVerdict: alchVerdict,
    limitUsage: limitUsage, isOpen: isOpen, cashTiedUp: cashTiedUp, realized: realized, advise: advise
  };
});
