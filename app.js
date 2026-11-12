/* GE Flip Tracker app: fetches live prices from the OSRS Wiki, asks engine.js
   for every number, and draws the screens. Nothing here invents data. */
(function () {
  'use strict';
  var API = 'https://prices.runescape.wiki/api/v1/osrs';
  var ICONS = 'https://oldschool.runescape.wiki/images/';
  var TABS = ['home', 'screener', 'alch', 'trades', 'more'];
  var G = window.GE;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function now() { return Math.floor(Date.now() / 1000); }
  var gp = G.fmtGp, ex = G.fmtExact;

  /* ---------- storage (this phone only) ---------- */
  var mem = {};
  var store = {
    get: function (k, def) { try { var v = localStorage.getItem(k); return v == null ? (k in mem ? mem[k] : def) : JSON.parse(v); } catch (e) { return k in mem ? mem[k] : def; } },
    set: function (k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked: keep in memory */ } }
  };

  var S = {
    settings: store.get('ge.settings', null),
    trades: store.get('ge.trades', []),
    stars: store.get('ge.stars', {}),
    items: {}, itemList: [],
    mkt: { latest: {}, m5: {}, h1: {}, d1: {} },
    feed: { mapping: {}, latest: {}, m5: {}, h1: {}, d1: {}, series: {} },
    series: {}, wf: {},
    tab: 'home',
    scr: { mode: 'active', q: '', afford: true, pass: true, star: false, sort: 'profit' },
    alc: { sort: 'batch' },
    sheet: null, calc: null, undo: null
  };
  function saveTrades() { store.set('ge.trades', S.trades); }

  /* ---------- network ---------- */
  function getJSON(path) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    return fetch(API + path, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (!r.ok) throw new Error('the price server answered ' + r.status);
      return r.json();
    }).finally(function () { clearTimeout(to); });
  }
  function pull(key, path, apply) {
    return getJSON(path).then(function (j) {
      var n = apply(j);
      S.feed[key] = { ok: true, at: now(), n: n };
    }).catch(function (e) {
      var prev = S.feed[key] || {};
      S.feed[key] = { ok: false, at: prev.at || null, n: prev.n, err: friendly(e), failedAt: now() };
    });
  }
  function friendly(e) {
    var m = String((e && e.message) || e);
    if (/abort/i.test(m)) return 'the price server took too long to answer';
    if (/failed to fetch|networkerror|load failed/i.test(m)) return 'no connection to the price server';
    return m;
  }
  function count(o) { return o ? Object.keys(o).length : 0; }

  function loadMapping() {
    var cached = store.get('ge.map', null);
    function apply(rows) {
      S.items = {}; S.itemList = [];
      rows.forEach(function (r) {
        var it = { id: r[0], name: r[1], limit: r[2], highalch: r[3], members: !!r[4], icon: r[5] };
        S.items[it.id] = it; S.itemList.push(it);
      });
    }
    if (cached && cached.rows && cached.rows.length) {
      apply(cached.rows);
      S.feed.mapping = { ok: true, at: cached.at, n: cached.rows.length };
      if (now() - cached.at < 86400) return Promise.resolve();
    }
    return pull('mapping', '/mapping', function (list) {
      var rows = list.map(function (m) { return [m.id, m.name, m.limit || 0, m.highalch || 0, m.members ? 1 : 0, m.icon || '']; });
      apply(rows); store.set('ge.map', { at: now(), rows: rows });
      return rows.length;
    });
  }
  function loadLatest() { return pull('latest', '/latest', function (j) { S.mkt.latest = j.data || {}; return count(j.data); }); }
  function loadM5() { return pull('m5', '/5m', function (j) { S.mkt.m5 = j.data || {}; return count(j.data); }); }
  function loadH1() { return pull('h1', '/1h', function (j) { S.mkt.h1 = j.data || {}; return count(j.data); }); }
  function loadD1() { return pull('d1', '/24h', function (j) { S.mkt.d1 = j.data || {}; return count(j.data); }); }

  /* price history, one item at a time, politely spaced */
  var Q = [], qBusy = false;
  var TTL = { '5m': 600, '1h': 3600, '6h': 6 * 3600, '24h': 12 * 3600 };
  function wantSeries(id, step, front) {
    var key = id + '|' + step, c = S.series[key], t = now();
    if (c && c.data && t - c.at < TTL[step]) return c;
    if (c && c.pending) { if (front) { var i = Q.indexOf(key); if (i > 0) { Q.splice(i, 1); Q.unshift(key); } } return c; }
    if (c && c.err && t - c.at < 120) return c;
    c = S.series[key] = { pending: true, data: c && c.data, at: c && c.at };
    if (front) Q.unshift(key); else Q.push(key);
    pump();
    return c;
  }
  function pump() {
    if (qBusy || !Q.length || document.hidden) return;
    qBusy = true;
    var key = Q.shift(), parts = key.split('|');
    getJSON('/timeseries?timestep=' + parts[1] + '&id=' + parts[0]).then(function (j) {
      S.series[key] = { at: now(), data: (j && j.data) || [] };
      S.feed.series = { ok: true, at: now(), n: count(S.series) };
    }).catch(function (e) {
      var old = S.series[key] || {};
      S.series[key] = { at: now(), err: friendly(e), data: old.data };
      S.feed.series = { ok: false, at: (S.feed.series || {}).at || null, err: friendly(e), failedAt: now() };
    }).finally(function () {
      refresh();
      setTimeout(function () { qBusy = false; pump(); }, 700);
    });
  }

  /* ---------- sizing and shortlists ---------- */
  function slotsTotal() { return S.settings.members ? G.RULES.slotsMembers : G.RULES.slotsF2P; }
  function limitLeftFor(item, usage) {
    if (!(item.limit > 0)) return null;
    var u = usage[item.id];
    return u ? Math.max(0, item.limit - u.used) : null;
  }
  function usageMap(t) {
    var m = {};
    S.trades.forEach(function (tr) { if (!m[tr.itemId]) m[tr.itemId] = G.limitUsage(tr.itemId, S.trades, t); });
    return m;
  }
  function decorate(q) {
    var s = wantSeries(q.id, q.mode === 'overnight' ? '1h' : '5m');
    q.loading = !s.data && !s.err;
    if (s.data && q.kind === 'alch') {
      q.bt = G.backtestAlch(s.data, q.maxPay); q.v = G.alchVerdict(q, q.bt);
      q.ev = q.bt.enough ? q.profit * q.bt.chance : null;
    } else if (s.data) {
      q.bt = G.backtestFlip(s.data, q.mode, q.qty); q.v = G.verdict(q, q.bt); q.ev = G.expectedValue(q, q.bt);
      var wf = G.walkForward(s.data, q.mode, q.qty);
      if (wf) S.wf[q.id + '|' + q.mode] = wf;
    } else {
      q.bt = null; q.ev = null;
      q.v = q.kind === 'alch' ? G.alchVerdict(q, null) : G.verdict(q, null);
    }
    return q;
  }
  function rank(q) { return q.ev != null ? q.ev : q.profit * 0.4; }
  function shortlist(list, c, n) {
    var pre = list.filter(function (q) {
      return q.level !== 'fail' && q.qty >= 1 && q.profit >= c.minProfit && !c.openIds[q.id];
    }).sort(function (a, b) { return pre_(b) - pre_(a); }).slice(0, n).map(decorate);
    return pre.filter(function (q) { return q.v.cls !== 'risky'; }).sort(function (a, b) { return rank(b) - rank(a); });
  }
  function pre_(q) { return q.profit * (q.level === 'pass' ? 1 : 0.6) * (q.roi > 0.05 ? 0.5 : 1); }

  function compute() {
    var st = S.settings;
    if (!st || !S.itemList.length || !count(S.mkt.latest)) { S.calc = null; return; }
    var t = now(), open = S.trades.filter(G.isOpen), tied = G.cashTiedUp(S.trades);
    var c = { t: t, tied: tied, free: Math.max(0, st.cash - tied), slots: slotsTotal(), open: open, openIds: {}, usage: usageMap(t) };
    c.freeSlots = Math.max(0, c.slots - open.length);
    c.perItem = Math.min(c.free, Math.floor(st.cash * st.maxPct / 100));
    c.minProfit = Math.max(500, Math.round(st.cash * 0.001));
    open.forEach(function (tr) { c.openIds[tr.itemId] = true; });
    c.act = []; c.ovn = []; c.alc = [];
    for (var i = 0; i < S.itemList.length; i++) {
      var it = S.itemList[i];
      if (!st.members && it.members) continue;
      var ctx = { now: t, cash: c.perItem, limitLeft: limitLeftFor(it, c.usage) };
      var a = G.flipQuote(it, S.mkt, 'active', ctx); if (a) c.act.push(a);
      var o = G.flipQuote(it, S.mkt, 'overnight', ctx); if (o) c.ovn.push(o);
      if (st.canAlch) { var al = G.alchQuote(it, S.mkt, st, ctx); if (al) c.alc.push(al); }
    }
    c.short = { active: shortlist(c.act, c, 14), overnight: shortlist(c.ovn, c, 14), alch: st.canAlch ? shortlist(c.alc, c, 10) : [] };
    S.calc = c;
  }
  function quoteFor(id, mode, cash) {
    var it = S.items[id], c = S.calc;
    if (!it || !c) return null;
    var ctx = { now: now(), cash: cash != null ? cash : c.perItem, limitLeft: limitLeftFor(it, c.usage) };
    var q = mode === 'alch' ? G.alchQuote(it, S.mkt, S.settings, ctx) : G.flipQuote(it, S.mkt, mode, ctx);
    return q ? decorate(q) : null;
  }
  function buildPlan() {
    var c = S.calc, cash = c.free, slots = c.freeSlots, out = [], seen = {}, exp = 0;
    var pool = c.short.active.concat(c.short.overnight, c.short.alch).sort(function (a, b) { return rank(b) - rank(a); });
    for (var i = 0; i < pool.length && slots > 0; i++) {
      var q = pool[i];
      if (seen[q.id]) continue;
      var alloc = Math.min(c.perItem, cash);
      if (alloc <= 0) break;
      var nq = quoteFor(q.id, q.mode, alloc);
      if (!nq || nq.qty < 1 || nq.profit < c.minProfit || nq.v.cls === 'risky') continue;
      out.push(nq); seen[q.id] = true; cash -= nq.cost; slots--; exp += nq.profit;
    }
    return { list: out, used: c.free - cash, profit: exp };
  }

  /* ---------- small view helpers ---------- */
  function icon(it) {
    var src = it && it.icon ? ICONS + encodeURIComponent(it.icon.replace(/ /g, '_')) : '';
    return '<span class="icon">' + (src ? '<img alt="" loading="lazy" src="' + esc(src) + '" onerror="this.remove()">' : '') + '</span>';
  }
  function ago(ts) {
    if (!ts) return 'never';
    var s = Math.max(0, now() - ts);
    return s < 60 ? s + 's ago' : G.fmtAge(s / 60) + ' ago';
  }
  function dur(sec) {
    sec = Math.max(0, sec);
    var h = Math.floor(sec / 3600), m = Math.ceil((sec % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    return h ? h + 'h ' + m + 'm' : m + ' min';
  }
  function tip(label, text) { return '<span class="tip" data-act="tip" data-tip="' + esc(text) + '">' + label + '</span>'; }
  function spanDays(bt) {
    if (!bt || !bt.from) return '';
    var h = (bt.to - bt.from) / 3600;
    return h < 48 ? 'the last ' + Math.max(1, Math.round(h)) + ' hours' : 'the last ' + Math.round(h / 24) + ' days';
  }
  function reason(q) {
    var bad = q.checks.filter(function (c) { return c.level !== 'pass'; });
    if (bad.length) return bad[0].text + '.';
    var out = q.checks.filter(function (c) { return c.key === 'liquid' || c.key === 'holds'; }).map(function (c) { return c.text; });
    return out.join('. ') + '.';
  }
  function chanceLine(q) {
    if (q.loading) return '<div class="pulse">Testing against recent history…</div>';
    var bt = q.bt;
    if (!bt) return '<div class="muted">Chance: not yet tested (price history did not load)</div>';
    if (!bt.enough) return '<div class="muted">Chance: not enough history to test (' + bt.n + ' cases)</div>';
    var p = Math.round(bt.chance * 100);
    if (q.kind === 'alch') return '<div>' + tip('Chance the price holds', 'How often this item could be bought at a profitable price in recent 5-minute checks.') + ': <b>' + p + '%</b> <span class="muted">· cheap enough in ' + bt.wins + ' of ' + bt.n + ' checks over ' + spanDays(bt) + '</span></div>';
    return '<div>' + tip('Chance it works', 'How often this exact plan (same prices rule, same quantity) would have bought and sold in time when replayed on real past prices. Past results do not guarantee the next one.') + ': <b>' + p + '%</b> <span class="muted">· worked ' + bt.wins + ' of ' + bt.n + ' times over ' + spanDays(bt) + (bt.medianMinutes ? ' · usually about ' + G.fmtAge(bt.medianMinutes) : '') + '</span></div>';
  }
  function stepsHtml(q) {
    if (q.kind === 'alch') {
      return '<ol class="steps"><li><span>Buy <b>' + ex(q.qty) + '</b> at <b>' + ex(q.buyAt) + '</b> gp each <small>(costs ' + gp(q.itemCost) + '; never pay more than ' + ex(q.maxPay) + ')</small></span></li>' +
        '<li><span>Cast High Alchemy on each one <small>(' + ex(q.alchValue) + ' gp each, about ' + G.fmtAge(q.minutes) + ' of casting)</small></span></li></ol>';
    }
    return '<ol class="steps"><li><span>Buy <b>' + ex(q.qty) + '</b> at <b>' + ex(q.buyAt) + '</b> gp each <small>(costs ' + gp(q.cost) + ')</small></span></li>' +
      '<li><span>When they have bought, sell at <b>' + ex(q.sellAt) + '</b> gp each</span></li></ol>';
  }
  function profitLine(q) {
    var label = q.kind === 'alch' ? tip('Profit after runes', 'Alch value minus what you pay for the item and one nature rune' + (S.settings.fireStaff ? '' : ' and five fire runes') + ' per cast. No GE tax: nothing is sold.')
      : tip('Profit after tax', 'What you keep after the 2% Grand Exchange tax on the sale (' + ex(q.tax) + ' gp per item here).');
    return '<div class="big">' + label + ': <b>about ' + gp(q.profit) + '</b> <span class="muted">(' + gp(q.per) + ' each)</span></div>';
  }
  function card(q, placeable) {
    var it = S.items[q.id];
    return '<article class="card"><div class="card-h">' + icon(it) + '<h3>' + esc(q.name) + '</h3><span class="verdict ' + q.v.cls + '">' + q.v.word + '</span></div>' +
      stepsHtml(q) + '<div class="facts">' + profitLine(q) + chanceLine(q) + '</div><p class="reason">' + esc(reason(q)) + '</p>' +
      '<div class="row"><button class="btn ghost grow" data-act="why" data-id="' + q.id + '" data-mode="' + q.mode + '">Why?</button>' +
      (placeable ? '<button class="btn primary grow" data-act="place" data-id="' + q.id + '" data-mode="' + q.mode + '" data-qty="' + q.qty + '" data-buy="' + q.buyAt + '">I placed this</button>' : '') + '</div></article>';
  }
  function emptyBox(title, text) { return '<div class="empty"><b>' + title + '</b>' + text + '</div>'; }

  /* ---------- top bar, banner, tabs ---------- */
  function feedState() {
    var f = S.feed.latest, age = f.at ? now() - f.at : Infinity;
    if (f.at && age < 150) return 'live';
    if (f.at && age < 600) return 'stale';
    return 'down';
  }
  function renderTop() {
    var st = S.settings, c = S.calc, state = feedState();
    var label = !S.feed.latest.at ? (S.feed.latest.ok === false ? 'No live prices' : 'Loading prices…') : (state === 'live' ? 'Live' : 'Not updating') + ' · prices from ' + ago(S.feed.latest.at);
    var chips = st ? '<button class="chip" data-act="cash"><b class="num">' + gp(c ? c.free : st.cash) + '</b><span>Free cash</span></button>' +
      '<button class="chip" data-act="tab" data-tab="trades"><b class="num">' + (c ? c.freeSlots : slotsTotal()) + '/' + slotsTotal() + '</b><span>Free slots</span></button>' : '';
    $('top').innerHTML = '<div class="top-in"><div class="brand">GE Flips<small><i class="dot ' + state + '"></i><span id="feedtxt">' + label + '</span></small></div>' + chips + '</div>';
  }
  function renderBanner() {
    var b = $('banner'), f = S.feed.latest, msg = '', warn = false;
    if (navigator.onLine === false) msg = 'You are offline. ' + (f.at ? 'Showing prices from ' + ago(f.at) + '. Do not trade on these.' : 'Connect to the internet to load prices.');
    else if (f.ok === false && !f.at) msg = 'Cannot reach the price feed (' + esc(f.err) + '). Trying again every minute.';
    else if (f.at && now() - f.at >= 150) msg = 'Live prices stopped updating' + (f.err ? ' (' + esc(f.err) + ')' : '') + '. Showing prices from ' + ago(f.at) + '. Do not trade on these until this banner goes away.';
    else if (S.feed.d1.ok === false || S.feed.h1.ok === false) { warn = true; msg = 'Some price averages did not load, so fewer recommendations can be checked. Retrying.'; }
    b.hidden = !msg; b.className = warn ? 'warn' : ''; b.innerHTML = msg ? '<div>' + msg + '</div>' : '';
  }
  var TAB_ICON = {
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    screener: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
    alch: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
    trades: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'
  };
  var TAB_NAME = { home: 'For you', screener: 'Screener', alch: 'Alch', trades: 'My trades', more: 'More' };
  function renderTabs() {
    var nav = $('tabs');
    nav.hidden = !S.settings;
    if (!S.settings) return;
    var open = S.trades.filter(G.isOpen).length;
    nav.innerHTML = '<div class="tabs-in">' + TABS.map(function (t) {
      return '<button class="tab' + (S.tab === t ? ' on' : '') + '" data-act="tab" data-tab="' + t + '"' + (S.tab === t ? ' aria-current="page"' : '') + '><svg viewBox="0 0 24 24" aria-hidden="true">' + TAB_ICON[t] + '</svg>' + TAB_NAME[t] +
        (t === 'trades' && open ? '<span class="badge">' + open + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }

  /* ---------- views ---------- */
  function viewSetup() {
    var d = S.draft || (S.draft = { cash: '', members: true, canAlch: true, fireStaff: true });
    return '<div class="setup"><h1>Set up in 20 seconds</h1><p class="lead">Four questions, then you get live recommendations sized to your gold. You can change these later under More.</p>' +
      '<form class="form" data-form="setup"><label>How much gold do you want to trade with?<small>Type it like 10m, 250k or 1.2b</small>' +
      '<input class="field" name="cash" inputmode="text" autocomplete="off" placeholder="10m" value="' + esc(d.cash) + '"></label>' +
      (d.err ? '<div class="warnbox">' + esc(d.err) + '</div>' : '') +
      yn('members', 'Are you a member?', 'Members have 8 Grand Exchange slots and can trade members items. Free players have 3.', d.members) +
      yn('canAlch', 'Can you cast High Level Alchemy?', 'It needs 55 Magic.', d.canAlch) +
      (d.canAlch ? yn('fireStaff', 'Do you alch with a fire staff?', 'If not, five fire runes per cast are added to the cost.', d.fireStaff) : '') +
      '<button class="btn primary block" type="submit">Show my recommendations</button></form></div>';
  }
  function yn(name, q, hint, val) {
    return '<div><label>' + q + '<small>' + hint + '</small></label><div class="yn" style="margin-top:6px"><button type="button" data-act="yn" data-name="' + name + '" data-val="1" class="' + (val ? 'on' : '') + '">Yes</button><button type="button" data-act="yn" data-name="' + name + '" data-val="0" class="' + (!val ? 'on' : '') + '">No</button></div></div>';
  }

  function viewHome() {
    var c = S.calc, st = S.settings;
    if (!c) return loadingOrError();
    var n = st.cards || 5, h = '';
    h += '<div class="summary"><p>You have <b>' + gp(c.free) + '</b> free and <b>' + c.freeSlots + '</b> free ' + (c.freeSlots === 1 ? 'slot' : 'slots') + '.</p>' +
      (c.freeSlots > 0 && c.free > 0 ? '<button class="btn primary small" data-act="plan">Fill my slots</button>' : '') + '</div>';
    if (c.freeSlots === 0) h += '<p class="lead" style="margin-top:10px">All your slots are in use. Finish a trade under My trades to free one.</p>';
    else if (c.free < 1000) h += '<p class="lead" style="margin-top:10px">All your gold is tied up in open trades. Tap Free cash to change your total.</p>';
    var can = c.freeSlots > 0;
    var shown = {};
    c.short.active.slice(0, n).forEach(function (q) { shown[q.id] = true; });
    h += section('Flip now', 'buys and sells within about an hour', c.short.active, n, can, 'active');
    h += section('Set and forget', 'place both offers, check back in the morning', c.short.overnight.filter(function (q) { return !shown[q.id]; }), n, can, 'overnight');
    if (st.canAlch) h += section('Alch', 'buy, then cast High Alchemy', c.short.alch, n, can, 'alch');
    h += '<p class="count">Recommendations pass every check and are sized to at most ' + st.maxPct + '% of your gold per item. They are estimates from past prices, never guarantees.</p>';
    return h;
  }
  function section(title, sub, list, n, can, mode) {
    var h = '<div class="sec"><h2>' + title + '</h2><span>' + sub + '</span></div>';
    if (!list.length) {
      var src = mode === 'active' ? S.feed.h1 : mode === 'overnight' ? S.feed.d1 : S.feed.latest;
      if (src.ok === false && !src.at) return h + emptyBox('Cannot check these right now', 'The averages this list needs did not load (' + esc(src.err) + '). Retrying.');
      return h + emptyBox('Nothing worth doing right now', 'No item passes every check at your cash size. Check back in a bit.');
    }
    return h + list.slice(0, n).map(function (q) { return card(q, can); }).join('');
  }
  function loadingOrError() {
    var f = S.feed.latest, m = S.feed.mapping;
    if (f.ok === false || m.ok === false) return emptyBox('Cannot load prices yet', 'Reason: ' + esc(f.err || m.err) + '. The app keeps retrying every minute. Check your internet connection.');
    return '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  }

  function levelWord(q) {
    if (q.v && !q.v.untested) return '<span class="c-' + q.v.cls + '">' + q.v.word + '</span>';
    if (q.level === 'pass') return '<span class="c-strong">Passes checks</span>';
    if (q.level === 'warn') return '<span class="c-ok">Caution</span>';
    return '<span class="c-risky">Fails checks</span>';
  }
  function viewScreener() {
    var s = S.scr;
    return '<div class="sec"><h2>Screener</h2><span>every item with a gap, live</span></div><div class="tools">' +
      '<div class="seg"><button data-act="scr" data-k="mode" data-v="active" class="' + (s.mode === 'active' ? 'on' : '') + '">Flip now</button><button data-act="scr" data-k="mode" data-v="overnight" class="' + (s.mode === 'overnight' ? 'on' : '') + '">Overnight</button></div>' +
      '<input class="field" id="scr-q" type="search" placeholder="Search items" autocomplete="off" value="' + esc(s.q) + '">' +
      '<div class="toggles">' + tog('pass', 'Passing checks only', s.pass) + tog('afford', 'I can afford', s.afford) + tog('star', 'Starred', s.star) +
      '<select class="tog" id="scr-sort" aria-label="Sort by"><option value="profit"' + sel(s.sort, 'profit') + '>Sort: total profit</option><option value="per"' + sel(s.sort, 'per') + '>Sort: profit each</option><option value="roi"' + sel(s.sort, 'roi') + '>Sort: profit %</option><option value="vol"' + sel(s.sort, 'vol') + '>Sort: most traded</option></select></div></div>' +
      '<div id="scr-list">' + screenerList() + '</div>';
  }
  function sel(a, b) { return a === b ? ' selected' : ''; }
  function tog(k, label, on) { return '<button class="tog' + (on ? ' on' : '') + '" data-act="scr" data-k="' + k + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + label + '</button>'; }
  function screenerList() {
    var c = S.calc, s = S.scr;
    if (!c) return loadingOrError();
    var q = s.q.trim().toLowerCase();
    var list = (s.mode === 'active' ? c.act : c.ovn).filter(function (x) {
      if (q && x.name.toLowerCase().indexOf(q) < 0) return false;
      if (s.pass && x.level !== 'pass') return false;
      if (s.afford && x.qty < 1) return false;
      if (s.star && !S.stars[x.id]) return false;
      return true;
    });
    var key = { profit: function (x) { return x.profit; }, per: function (x) { return x.per; }, roi: function (x) { return x.roi; }, vol: function (x) { return s.mode === 'active' ? x.vol1h : x.vol24h; } }[s.sort];
    list.sort(function (a, b) { return key(b) - key(a); });
    if (!list.length) return emptyBox('No items match', 'Try turning a filter off or clearing the search.');
    var shown = list.slice(0, 60);
    return '<div class="list">' + shown.map(function (x) {
      return '<button class="item" data-act="why" data-id="' + x.id + '" data-mode="' + x.mode + '">' + icon(S.items[x.id]) +
        '<span><div class="n">' + (S.stars[x.id] ? '★ ' : '') + esc(x.name) + '</div><div class="s">Buy ' + ex(x.buyAt) + ' → sell ' + ex(x.sellAt) + ' · +' + gp(x.per) + ' each' + (x.qty >= 1 ? ' · ×' + ex(x.qty) : '') + '</div></span>' +
        '<span class="r"><b>' + (x.qty >= 1 ? '+' + gp(x.profit) : '+' + gp(x.per)) + '</b>' + levelWord(x) + '</span></button>';
    }).join('') + '</div><p class="count">Showing ' + shown.length + ' of ' + list.length + '. Tap an item for the full check and price history.</p>';
  }

  function viewAlch() {
    var c = S.calc, st = S.settings;
    var h = '<div class="sec"><h2>High alch</h2><span>items worth more alched than they cost</span></div>';
    if (!st.canAlch) return h + emptyBox('Alching is switched off', 'You said you cannot cast High Level Alchemy (55 Magic).') + '<div class="row" style="margin-top:10px"><button class="btn" data-act="open" data-sheet="settings">Change in settings</button></div>';
    if (!c) return h + loadingOrError();
    var rc = G.runeCost(S.mkt, st);
    h += '<p class="lead">Each cast costs ' + (rc != null ? '<b>' + ex(rc) + ' gp</b> in runes right now' : 'runes') + (st.fireStaff ? ' (one nature rune, fire staff equipped)' : ' (one nature rune and five fire runes)') + '. No GE tax applies.</p>';
    h += '<div class="tools"><div class="seg"><button data-act="alcsort" data-v="batch" class="' + (S.alc.sort === 'batch' ? 'on' : '') + '">Most profit in total</button><button data-act="alcsort" data-v="per" class="' + (S.alc.sort === 'per' ? 'on' : '') + '">Most profit per cast</button></div></div>';
    var list = c.alc.filter(function (x) { return x.level !== 'fail' && x.qty >= 1; });
    list.sort(S.alc.sort === 'batch' ? function (a, b) { return b.profit - a.profit; } : function (a, b) { return b.per - a.per; });
    if (!list.length) return h + emptyBox('Nothing profitable to alch right now', 'No item is cheaper than its alch value minus runes, with fresh prices and enough for sale. Check back in a bit.');
    var shown = list.slice(0, 60);
    return h + '<div class="list">' + shown.map(function (x) {
      return '<button class="item" data-act="why" data-id="' + x.id + '" data-mode="alch">' + icon(S.items[x.id]) +
        '<span><div class="n">' + esc(x.name) + '</div><div class="s">Buy at ' + ex(x.buyAt) + ' · alch for ' + ex(x.alchValue) + ' · +' + ex(x.per) + ' each · ×' + ex(x.qty) + '</div></span>' +
        '<span class="r"><b>+' + gp(x.profit) + '</b>' + levelWord(x) + '</span></button>';
    }).join('') + '</div><p class="count">Showing ' + shown.length + ' of ' + list.length + ', sized to your free cash and each buy limit.</p>';
  }

  function statusLabel(t) {
    if (t.status === 'buying') return 'Buy offer in';
    if (t.kind === 'alch') return 'Bought: alch them';
    return 'Bought: sell offer in';
  }
  function viewTrades() {
    var t = now(), open = S.trades.filter(G.isOpen), total = slotsTotal(), h = '';
    h += '<div class="sec"><h2>My trades</h2><span>' + open.length + ' of ' + total + ' slots in use</span></div><div class="slots" aria-hidden="true">';
    for (var i = 0; i < total; i++) h += '<i class="slot' + (i < open.length ? ' used' : '') + '"></i>';
    h += '</div><p class="count">' + gp(G.cashTiedUp(S.trades)) + ' tied up in open trades.</p>';
    if (!open.length) h += emptyBox('No open trades', 'Tap “I placed this” on a recommendation after you put the offer in the Grand Exchange, and it shows up here with advice.');
    open.forEach(function (tr) {
      var adv = count(S.mkt.latest) ? G.advise(tr, S.mkt, t) : null, it = S.items[tr.itemId];
      h += '<article class="card"><div class="card-h">' + icon(it) + '<h3>' + esc(tr.name) + '</h3><span class="verdict ok">' + statusLabel(tr) + '</span></div>';
      if (tr.status === 'buying') h += '<p>Buy offer: <b class="num">' + ex(tr.qty) + '</b> at <b class="num">' + ex(tr.buyPrice) + '</b> gp each <span class="muted">· placed ' + ago(tr.placedAt) + '</span></p>';
      else if (tr.kind === 'alch') h += '<p>You hold <b class="num">' + ex(tr.qty) + '</b>, bought at ' + ex(tr.buyPrice) + ' gp. Alch them for <b class="num">' + ex(tr.alchValue) + '</b> gp each.</p>';
      else h += '<p>You hold <b class="num">' + ex(tr.qty) + '</b>, bought at ' + ex(tr.buyPrice) + ' gp. Sell offer: <b class="num">' + ex(tr.targetSell) + '</b> gp each <span class="muted">· break-even ' + ex(G.breakEvenSell(tr.buyPrice)) + '</span></p>';
      if (adv) h += '<div class="advice ' + adv.tone + '"><b>' + esc(adv.text) + '</b><span>' + esc(adv.why) + '</span></div>';
      h += '<div class="row">';
      if (tr.status === 'buying') h += '<button class="btn primary grow" data-act="bought" data-id="' + tr.id + '">It bought</button><button class="btn danger" data-act="cancel" data-id="' + tr.id + '">Cancel</button>';
      else if (tr.kind === 'alch') h += '<button class="btn primary grow" data-act="alched" data-id="' + tr.id + '">Done alching</button><button class="btn danger" data-act="cancel" data-id="' + tr.id + '">Remove</button>';
      else h += '<button class="btn primary grow" data-act="sold" data-id="' + tr.id + '"' + (adv && adv.price ? ' data-price="' + adv.price + '"' : '') + '>It sold</button><button class="btn danger" data-act="cancel" data-id="' + tr.id + '">Remove</button>';
      h += '</div></article>';
    });
    h += '<button class="btn block" data-act="open" data-sheet="manual">Add a trade by hand</button>';

    var lim = [];
    Object.keys(usageMap(t)).forEach(function (id) {
      var u = G.limitUsage(+id, S.trades, t), it = S.items[id];
      if (u.used > 0 && it) lim.push('<tr><td>' + esc(it.name) + '</td><td>' + ex(u.used) + (it.limit ? ' of ' + ex(it.limit) : '') + '</td><td>resets in ' + dur(u.resetAt - t) + '</td></tr>');
    });
    if (lim.length) h += '<div class="sec"><h2>Buy limits</h2><span>' + tip('what is this?', 'The game only lets you buy a set number of each item every 4 hours. The timer starts with your first purchase.') + '</span></div><div class="panel"><table class="t"><tr><th>Item</th><th>Bought</th><th></th></tr>' + lim.join('') + '</table></div>';

    var done = S.trades.filter(function (x) { return x.status === 'done'; }).sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });
    var today = new Date().toDateString(), sums = { d: 0, w: 0, a: 0 };
    done.forEach(function (x) {
      var p = G.realized(x) || 0; sums.a += p;
      if (t - x.doneAt < 7 * 86400) sums.w += p;
      if (new Date(x.doneAt * 1000).toDateString() === today) sums.d += p;
    });
    h += '<div class="sec"><h2>Results</h2><span>profit after tax</span></div><div class="stat3">' + stat('Today', sums.d) + stat('7 days', sums.w) + stat('All time', sums.a) + '</div>';
    if (done.length) h += '<div class="list" style="margin-top:10px">' + done.slice(0, 50).map(function (x) {
      var p = G.realized(x);
      return '<button class="item" data-act="tradeinfo" data-id="' + x.id + '">' + icon(S.items[x.itemId]) + '<span><div class="n">' + esc(x.name) + '</div><div class="s">' + ex(x.qty) + ' × ' + ex(x.buyPrice) + (x.kind === 'alch' ? ' → alched' : ' → ' + ex(x.soldPrice)) + ' · ' + ago(x.doneAt) + '</div></span><span class="r"><b class="' + (p < 0 ? 'neg' : '') + '">' + (p >= 0 ? '+' : '') + gp(p) + '</b>' + (x.pred ? '<span class="c-muted">expected ' + gp(x.pred.profit) + '</span>' : '') + '</span></button>';
    }).join('') + '</div>';
    else h += '<p class="count">Finished trades appear here.</p>';
    return h;
  }
  function stat(label, v) { return '<div class="stat"><span>' + label + '</span><b class="' + (v > 0 ? 'pos' : v < 0 ? 'neg' : '') + '">' + (v > 0 ? '+' : '') + gp(v) + '</b></div>'; }

  function viewMore() {
    function row(sheet, title, sub) { return '<button class="item" style="grid-template-columns:1fr auto" data-act="open" data-sheet="' + sheet + '"><span><div class="n">' + title + '</div><div class="s">' + sub + '</div></span><span class="r c-muted">›</span></button>'; }
    return '<div class="sec"><h2>More</h2></div><div class="list">' +
      row('guide', 'How this works', 'Flipping, tax, buy limits and how to read a card') +
      row('settings', 'Settings', 'Your gold, membership, alching, risk per item') +
      row('accuracy', 'Accuracy', 'Are the chances it shows honest? Check here') +
      row('feed', 'Data feed', 'Where prices come from and whether they are flowing') +
      row('backup', 'Backup and restore', 'Move your trades to another phone or browser') +
      '</div><p class="count">Prices come from the OSRS Wiki real-time prices project. Your trades and settings are stored only in this browser. This tool reads public prices and never touches your game account.</p>';
  }

  /* ---------- sheets ---------- */
  function sheetWrap(title, body, full) {
    return '<div class="sheet-in' + (full ? ' full' : '') + '" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="sheet-h"><h2>' + esc(title) + '</h2><button class="x" data-act="close" aria-label="Close">×</button></div>' + body + '</div>';
  }
  function chart(data) {
    var pts = (data || []).filter(function (w) { return w.avgHighPrice != null || w.avgLowPrice != null; });
    if (pts.length < 2) return '<p class="muted">No price history for this range.</p>';
    var W = 640, H = 250, L = 8, R = 8, T = 10, VB = 44, PB = H - VB - 22, lo = Infinity, hi = -Infinity, vmax = 0;
    pts.forEach(function (w) {
      [w.avgHighPrice, w.avgLowPrice].forEach(function (p) { if (p != null) { lo = Math.min(lo, p); hi = Math.max(hi, p); } });
      vmax = Math.max(vmax, (w.highPriceVolume || 0) + (w.lowPriceVolume || 0));
    });
    if (hi === lo) { hi += 1; lo -= 1; }
    var t0 = pts[0].timestamp, t1 = pts[pts.length - 1].timestamp, span = Math.max(1, t1 - t0);
    function x(t) { return L + (t - t0) / span * (W - L - R); }
    function y(p) { return T + (hi - p) / (hi - lo) * (PB - T); }
    function line(k) { var d = '', pen = false; pts.forEach(function (w) { if (w[k] == null) return; d += (pen ? 'L' : 'M') + x(w.timestamp).toFixed(1) + ' ' + y(w[k]).toFixed(1); pen = true; }); return d; }
    var bw = Math.max(1, (W - L - R) / pts.length - 0.6), bars = '';
    if (vmax > 0) pts.forEach(function (w) { var v = (w.highPriceVolume || 0) + (w.lowPriceVolume || 0); if (!v) return; var bh = v / vmax * VB; bars += '<rect x="' + (x(w.timestamp) - bw / 2).toFixed(1) + '" y="' + (PB + 8 + VB - bh).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '"/>'; });
    function dlabel(t) { var d = new Date(t * 1000); return span < 3 * 86400 ? d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }); }
    return '<div class="chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Price history chart"><line x1="' + L + '" x2="' + (W - R) + '" y1="' + T + '" y2="' + T + '" stroke="#2c313c"/><line x1="' + L + '" x2="' + (W - R) + '" y1="' + PB + '" y2="' + PB + '" stroke="#2c313c"/>' +
      '<g fill="#3a4150">' + bars + '</g><path d="' + line('avgLowPrice') + '" fill="none" stroke="#6aa9ff" stroke-width="2" stroke-linejoin="round"/><path d="' + line('avgHighPrice') + '" fill="none" stroke="#e6b93f" stroke-width="2" stroke-linejoin="round"/>' +
      '<g fill="#9da3ae" font-size="13"><text x="' + (L + 2) + '" y="' + (T + 15) + '">' + gp(hi) + '</text><text x="' + (L + 2) + '" y="' + (PB - 5) + '">' + gp(lo) + '</text><text x="' + L + '" y="' + (H - 4) + '">' + esc(dlabel(t0)) + '</text><text x="' + (W - R) + '" y="' + (H - 4) + '" text-anchor="end">' + esc(dlabel(t1)) + '</text></g></svg>' +
      '<div class="legend"><span><i style="background:#e6b93f"></i>People buy at (you sell here)</span><span><i style="background:#6aa9ff"></i>People sell at (you buy here)</span><span><i style="background:#3a4150;height:8px"></i>Amount traded</span></div></div>';
  }
  var RANGES = { '1D': ['5m', 288], '1W': ['1h', 168], '1M': ['6h', 120], '1Y': ['24h', 365] };
  function sheetItem(sh) {
    var it = S.items[sh.id];
    if (!it) return sheetWrap('Item', '<p class="muted">Item not found.</p>', true);
    var canAlch = S.settings.canAlch && it.highalch > 0, mode = sh.mode, c = S.calc;
    var q = c ? quoteFor(it.id, mode) : null, l = S.mkt.latest[it.id] || {}, h1 = S.mkt.h1[it.id] || {}, d1 = S.mkt.d1[it.id] || {};
    if (q) wantSeries(it.id, mode === 'overnight' ? '1h' : '5m', true);
    var h = '<div class="seg" style="margin-bottom:12px"><button data-act="imode" data-v="active" class="' + (mode === 'active' ? 'on' : '') + '">Flip now</button><button data-act="imode" data-v="overnight" class="' + (mode === 'overnight' ? 'on' : '') + '">Overnight</button>' + (canAlch ? '<button data-act="imode" data-v="alch" class="' + (mode === 'alch' ? 'on' : '') + '">Alch</button>' : '') + '</div>';
    if (q && q.qty >= 1) {
      var isOpenItem = c.openIds[it.id];
      h += '<div class="panel"><div class="card-h" style="margin-bottom:8px"><h3 style="margin:0">The plan</h3><span class="verdict ' + q.v.cls + '">' + q.v.word + '</span></div>' + stepsHtml(q) + '<div class="facts">' + profitLine(q) + chanceLine(q) + '</div>' +
        (isOpenItem ? '<p class="reason">You already have an open trade in this item.</p>' : c.freeSlots < 1 ? '<p class="reason">No free slot right now.</p>' : '<div class="row" style="margin-top:12px"><button class="btn primary block" data-act="place" data-id="' + q.id + '" data-mode="' + q.mode + '" data-qty="' + q.qty + '" data-buy="' + q.buyAt + '">I placed this</button></div>') + '</div>';
    } else if (q) {
      h += '<div class="panel"><h3>The plan</h3><p class="muted">There is a gap of ' + gp(q.per) + ' gp each (buy ' + ex(q.buyAt) + (q.kind === 'alch' ? ', alch for ' + ex(q.alchValue) : ', sell ' + ex(q.sellAt)) + '), but you cannot trade it right now: ' + (q.limitLeft === 0 ? 'you have used your buy limit.' : (S.calc.perItem < q.buyAt ? 'it costs more than your cash for one item.' : 'too little of it is traded.')) + '</p></div>';
    } else {
      h += '<div class="panel"><h3>The plan</h3><p class="muted">' + (mode === 'alch' ? 'Not profitable to alch at the current price.' : 'No profit after tax at current prices' + (mode === 'overnight' ? ' (24 hour averages).' : ' (live and 1 hour averages).')) + '</p></div>';
    }
    if (q) h += '<div class="panel"><h3>Checks</h3><ul class="checks">' + q.checks.map(function (k) { return '<li class="' + k.level + '"><i>' + (k.level === 'pass' ? '✓' : k.level === 'warn' ? '!' : '✕') + '</i><span>' + esc(k.text) + '</span></li>'; }).join('') + '</ul></div>';
    if (q && q.bt && q.kind !== 'alch' && q.bt.n > 0) {
      var bt = q.bt, tot = bt.n;
      h += '<div class="panel"><h3>Test against real past prices</h3><div class="bar"><i style="width:' + (bt.wins / tot * 100) + '%;background:var(--good)"></i><i style="width:' + (bt.nofill / tot * 100) + '%;background:var(--faint)"></i><i style="width:' + (bt.stuck / tot * 100) + '%;background:var(--bad)"></i></div>' +
        '<ul class="checks"><li class="pass"><i>●</i><span>Bought and sold in time: <b>' + bt.wins + '</b> of ' + tot + (bt.medianMinutes ? ' (usually about ' + G.fmtAge(bt.medianMinutes) + ')' : '') + '</span></li>' +
        '<li><i style="color:var(--faint)">●</i><span>Did not fill fully, no loss: <b>' + bt.nofill + '</b></span></li>' +
        '<li class="fail"><i>●</i><span>Bought but did not sell in time: <b>' + bt.stuck + '</b>' + (bt.stuck ? ' (on average ' + gp(Math.round(bt.stuckAvgPer)) + ' gp each if sold straight away)' : '') + '</span></li></ul>' +
        '<p class="reason">The same plan replayed over ' + spanDays(bt) + ', using only prices known at each moment. ' + (bt.enough ? '' : 'Too few cases to give a chance.') + '</p></div>';
    }
    h += '<div class="panel"><h3>Right now</h3><dl class="kv"><dt>People buy at</dt><dd>' + (l.high != null ? ex(l.high) + ' gp · ' + ago(l.highTime) : 'no trades') + '</dd><dt>People sell at</dt><dd>' + (l.low != null ? ex(l.low) + ' gp · ' + ago(l.lowTime) : 'no trades') + '</dd>' +
      '<dt>Last hour average</dt><dd>' + (h1.avgHighPrice != null ? ex(h1.avgHighPrice) : '–') + ' / ' + (h1.avgLowPrice != null ? ex(h1.avgLowPrice) : '–') + '</dd>' +
      '<dt>Traded last hour</dt><dd>' + ex((h1.highPriceVolume || 0) + (h1.lowPriceVolume || 0)) + '</dd><dt>Traded last 24 hours</dt><dd>' + (S.feed.d1.at ? ex((d1.highPriceVolume || 0) + (d1.lowPriceVolume || 0)) : 'not loaded') + '</dd>' +
      '<dt>Buy limit per 4 hours</dt><dd>' + (it.limit ? ex(it.limit) : 'unknown') + '</dd>' + (it.highalch ? '<dt>High alch value</dt><dd>' + ex(it.highalch) + ' gp</dd>' : '') + '</dl></div>';
    var rg = RANGES[sh.range], ser = wantSeries(it.id, rg[0], true);
    h += '<div class="panel"><h3>Price history</h3><div class="seg" style="margin-bottom:10px">' + Object.keys(RANGES).map(function (k) { return '<button data-act="range" data-v="' + k + '" class="' + (sh.range === k ? 'on' : '') + '">' + k + '</button>'; }).join('') + '</div>' +
      (ser.data ? chart(ser.data.slice(-rg[1])) : ser.err ? '<p class="muted">History did not load: ' + esc(ser.err) + '.</p>' : '<div class="skeleton" style="height:120px"></div>') + '</div>';
    h += '<div class="row"><button class="btn grow" data-act="star" data-id="' + it.id + '">' + (S.stars[it.id] ? '★ Starred' : '☆ Star this item') + '</button><a class="btn grow" style="display:grid;place-items:center;text-decoration:none;color:inherit" href="https://prices.runescape.wiki/osrs/item/' + it.id + '" target="_blank" rel="noopener">Open on the Wiki</a></div>';
    return sheetWrap(it.name, h, true);
  }
  function sheetPlan() {
    var c = S.calc;
    if (!c) return sheetWrap('Fill my slots', loadingOrError());
    var p = buildPlan();
    if (!p.list.length) return sheetWrap('Fill my slots', emptyBox('Nothing worth doing right now', 'No item passes every check at your cash size. Check back in a bit.'));
    var testing = p.list.some(function (q) { return q.loading; });
    return sheetWrap('Fill my slots', '<p class="lead">Your ' + gp(c.free) + ' spread over ' + p.list.length + ' of your ' + c.freeSlots + ' free slots, best first. Uses <b>' + gp(p.used) + '</b>; profit if all of them work: <b>about ' + gp(p.profit) + '</b>.' + (testing ? ' Still testing some of these.' : '') + '</p>' + p.list.map(function (q) { return card(q, true); }).join(''), true);
  }
  function tradeForm(kind, tr, price) {
    var isBuy = kind === 'bought';
    var d = S.sheet.draft || (S.sheet.draft = { qty: String(tr.qty), price: String(isBuy ? tr.buyPrice : (price || tr.targetSell)) });
    return sheetWrap(isBuy ? 'It bought' : 'It sold', '<form class="form" data-form="' + kind + '"><p class="lead" style="margin:0">' + esc(tr.name) + '</p>' +
      '<label>How many ' + (isBuy ? 'did you get' : 'sold') + '?<input class="field" name="qty" inputmode="numeric" value="' + esc(d.qty) + '"></label>' +
      '<label>Price each<small>' + (isBuy ? 'Tip: the GE sometimes fills cheaper than your offer. Enter what you really paid.' : 'What each one actually sold for, before tax.') + '</small><input class="field" name="price" inputmode="text" value="' + esc(d.price) + '"></label>' +
      (d.err ? '<div class="warnbox">' + esc(d.err) + '</div>' : '') +
      '<button class="btn primary block" type="submit">' + (d.confirm ? 'Yes, save it anyway' : 'Save') + '</button></form>');
  }
  function sheetManual() {
    var d = S.sheet.draft || (S.sheet.draft = { name: '', itemId: null, qty: '', price: '', sell: '', bought: false, kind: 'flip' });
    var sug = '';
    if (d.name && !d.itemId) {
      var q = d.name.toLowerCase(), m = S.itemList.filter(function (x) { return x.name.toLowerCase().indexOf(q) >= 0; }).sort(function (a, b) { return a.name.length - b.name.length; }).slice(0, 6);
      sug = m.length ? '<div class="list">' + m.map(function (x) { return '<button type="button" class="item" data-act="pick" data-id="' + x.id + '">' + icon(x) + '<span class="n">' + esc(x.name) + '</span><span></span></button>'; }).join('') + '</div>' : '<p class="hint">No item with that name.</p>';
    }
    var it = d.itemId ? S.items[d.itemId] : null;
    return sheetWrap('Add a trade by hand', '<form class="form" data-form="manual"><label>Item<input class="field" id="man-name" name="name" autocomplete="off" placeholder="Start typing a name" value="' + esc(d.name) + '"></label><div id="man-sug">' + sug + '</div>' +
      (it && S.settings.canAlch && it.highalch > 0 ? '<div><label>What will you do with it?</label><div class="yn" style="margin-top:6px"><button type="button" data-act="mkind" data-v="flip" class="' + (d.kind === 'flip' ? 'on' : '') + '">Sell it</button><button type="button" data-act="mkind" data-v="alch" class="' + (d.kind === 'alch' ? 'on' : '') + '">Alch it</button></div></div>' : '') +
      '<label>How many?<input class="field" name="qty" inputmode="numeric" value="' + esc(d.qty) + '"></label>' +
      '<label>Buy price each<input class="field" name="price" inputmode="text" placeholder="like 1245 or 1.2m" value="' + esc(d.price) + '"></label>' +
      (d.kind === 'flip' ? '<label>Sell price each<small>Leave empty to use the current market price.</small><input class="field" name="sell" inputmode="text" value="' + esc(d.sell) + '"></label>' : '') +
      '<div><label>Has it bought yet?</label><div class="yn" style="margin-top:6px"><button type="button" data-act="mbought" data-v="1" class="' + (d.bought ? 'on' : '') + '">Yes</button><button type="button" data-act="mbought" data-v="0" class="' + (!d.bought ? 'on' : '') + '">Not yet</button></div></div>' +
      (d.err ? '<div class="warnbox">' + esc(d.err) + '</div>' : '') + '<button class="btn primary block" type="submit">' + (d.confirm ? 'Yes, save it anyway' : 'Add trade') + '</button></form>', true);
  }
  function sheetCash() {
    var d = S.sheet.draft || (S.sheet.draft = { cash: gp(S.settings.cash).toLowerCase() });
    return sheetWrap('Your gold', '<form class="form" data-form="cash"><label>Total gold you trade with<small>Include gold tied up in open trades. Type it like 10m, 250k or 1.2b.</small><input class="field" name="cash" inputmode="text" autocomplete="off" value="' + esc(d.cash) + '"></label>' + (d.err ? '<div class="warnbox">' + esc(d.err) + '</div>' : '') + '<button class="btn primary block" type="submit">Save</button></form>');
  }
  function sheetSettings() {
    var st = S.settings, d = S.sheet.draft || (S.sheet.draft = { cash: gp(st.cash).toLowerCase(), members: st.members, canAlch: st.canAlch, fireStaff: st.fireStaff, maxPct: st.maxPct, cards: st.cards });
    function opts(name, vals, cur, suffix) { return '<div class="seg">' + vals.map(function (v) { return '<button type="button" data-act="sopt" data-name="' + name + '" data-val="' + v + '" class="' + (cur === v ? 'on' : '') + '">' + v + suffix + '</button>'; }).join('') + '</div>'; }
    return sheetWrap('Settings', '<form class="form" data-form="settings"><label>Total gold you trade with<small>Type it like 10m, 250k or 1.2b.</small><input class="field" name="cash" inputmode="text" autocomplete="off" value="' + esc(d.cash) + '"></label>' +
      yn('members', 'Are you a member?', 'Members: 8 slots. Free players: 3 slots and free items only.', d.members) + yn('canAlch', 'Can you cast High Level Alchemy?', 'Needs 55 Magic.', d.canAlch) + (d.canAlch ? yn('fireStaff', 'Do you alch with a fire staff?', 'If not, five fire runes per cast are added to the cost.', d.fireStaff) : '') +
      '<div><label>Most gold to put in one item<small>Lower is safer: one bad flip hurts less.</small></label><div style="margin-top:6px">' + opts('maxPct', [10, 25, 50, 100], d.maxPct, '%') + '</div></div>' +
      '<div><label>Cards per list on the first screen</label><div style="margin-top:6px">' + opts('cards', [3, 5, 8], d.cards, '') + '</div></div>' +
      (d.err ? '<div class="warnbox">' + esc(d.err) + '</div>' : '') + '<button class="btn primary block" type="submit">Save settings</button></form>', true);
  }
  function sheetAccuracy() {
    var buckets = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]].map(function (b) { return { lo: b[0], hi: b[1], n: 0, wins: 0, items: 0 }; }), any = 0;
    Object.keys(S.wf).forEach(function (k) {
      var w = S.wf[k];
      buckets.forEach(function (b) { if (w.predicted >= b.lo && w.predicted < b.hi) { b.n += w.n; b.wins += w.wins; b.items++; any++; } });
    });
    var h = '<div class="panel"><h3>Does a rating of 80% really mean 80%?</h3><p class="reason" style="margin:0 0 10px">For every item tested since you opened the app, the tool rated the flip using only the older 60% of its price history, then counted what the newer 40% actually did. If the right-hand column is close to the left, the ratings are honest.</p>';
    if (!any) h += '<p class="muted">Nothing tested yet. Open the first screen and wait a minute while it tests its recommendations.</p>';
    else h += '<table class="t"><tr><th>Rated</th><th>Items</th><th>Tests</th><th>Actually worked</th></tr>' + buckets.filter(function (b) { return b.n; }).map(function (b) { return '<tr><td>' + Math.round(b.lo * 100) + '–' + Math.min(100, Math.round(b.hi * 100)) + '%</td><td>' + b.items + '</td><td>' + b.n + '</td><td>' + Math.round(b.wins / b.n * 100) + '% (' + b.wins + ')</td></tr>'; }).join('') + '</table>';
    h += '</div>';
    var done = S.trades.filter(function (x) { return x.status === 'done' && x.pred; }), expd = 0, act = 0, won = 0;
    done.forEach(function (x) { var p = G.realized(x); expd += x.pred.profit; act += p; if (p > 0) won++; });
    h += '<div class="panel"><h3>Your own trades</h3>' + (done.length ? '<dl class="kv"><dt>Finished trades from recommendations</dt><dd>' + done.length + '</dd><dt>Ended in profit</dt><dd>' + won + ' of ' + done.length + '</dd><dt>Profit the cards expected</dt><dd>' + gp(expd) + '</dd><dt>Profit you actually made</dt><dd class="' + (act >= 0 ? 'pos' : 'neg') + '">' + gp(act) + '</dd></dl>' : '<p class="muted">Finish a few recommended trades and this compares what the cards promised with what you made.</p>') + '</div>';
    return sheetWrap('Accuracy', h, true);
  }
  function sheetFeed() {
    var rows = [['latest', 'Live prices', 'every minute'], ['m5', '5 minute averages', 'every 5 minutes'], ['h1', '1 hour averages', 'every 10 minutes'], ['d1', '24 hour averages', 'every 30 minutes'], ['mapping', 'Item list and buy limits', 'daily'], ['series', 'Price history', 'when needed']];
    return sheetWrap('Data feed', '<div class="panel"><table class="t"><tr><th>Feed</th><th>Status</th><th>Last update</th></tr>' + rows.map(function (r) {
      var f = S.feed[r[0]] || {};
      var status = f.ok === true ? '<span class="c-strong">Working</span>' : f.ok === false ? '<span class="c-risky">Failing</span>' : '<span class="c-muted">Waiting</span>';
      return '<tr><td>' + r[1] + '<div class="s muted" style="font-size:12px">' + r[2] + (f.n ? ' · ' + ex(f.n) + ' items' : '') + (f.ok === false ? ' · ' + esc(f.err) : '') + '</div></td><td>' + status + '</td><td>' + (f.at ? ago(f.at) : '–') + '</td></tr>';
    }).join('') + '</table></div><p class="count">Source: the <a href="https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices" target="_blank" rel="noopener">OSRS Wiki real-time prices</a> project, built from trades reported by RuneLite players. Prices reach the feed within about a minute of a trade. A price can be wrong if only one odd trade happened, which is why the checks compare several time windows.</p><div class="row"><button class="btn block" data-act="reload">Refresh everything now</button></div>', true);
  }
  function sheetBackup() {
    var d = S.sheet.draft || (S.sheet.draft = { code: '' });
    return sheetWrap('Backup and restore', '<div class="form"><p class="lead" style="margin:0">Your trades and settings live only in this browser. Clearing browser data deletes them. Copy a backup code now and then, and paste it on another phone or browser to move everything.</p><button class="btn block" data-act="copybackup">Copy my backup code</button>' +
      '<form class="form" data-form="restore"><label>Restore from a backup code<textarea class="field" name="code" placeholder="Paste a backup code here">' + esc(d.code) + '</textarea></label>' + (d.err ? '<div class="warnbox">' + esc(d.err) + '</div>' : '') + '<button class="btn block" type="submit">' + (d.confirm ? 'Yes, replace everything on this phone' : 'Restore') + '</button></form>' +
      '<button class="btn danger block" data-act="wipe">' + (d.wipe ? 'Tap again to erase everything' : 'Erase all my data on this phone') + '</button></div>', true);
  }
  function sheetTradeInfo(tr) {
    var p = G.realized(tr);
    return sheetWrap(tr.name, '<dl class="kv"><dt>Quantity</dt><dd>' + ex(tr.qty) + '</dd><dt>Bought at</dt><dd>' + ex(tr.buyPrice) + ' gp</dd>' + (tr.kind === 'alch' ? '<dt>Alched for</dt><dd>' + ex(tr.alchValue) + ' gp</dd><dt>Runes per cast</dt><dd>' + ex(tr.runeCost || 0) + ' gp</dd>' : '<dt>Sold at</dt><dd>' + ex(tr.soldPrice) + ' gp</dd><dt>Tax paid</dt><dd>' + gp(G.tax(tr.soldPrice) * tr.qty) + '</dd>') +
      '<dt>Profit</dt><dd class="' + (p >= 0 ? 'pos' : 'neg') + '">' + gp(p) + '</dd>' + (tr.pred ? '<dt>The card expected</dt><dd>' + gp(tr.pred.profit) + (tr.pred.chance != null ? ' at ' + Math.round(tr.pred.chance * 100) + '%' : '') + '</dd>' : '') + '<dt>Finished</dt><dd>' + new Date(tr.doneAt * 1000).toLocaleString() + '</dd></dl><div class="row" style="margin-top:16px"><button class="btn danger block" data-act="deltrade" data-id="' + tr.id + '">Delete this trade</button></div>');
  }
  function sheetGuide() {
    return sheetWrap('How this works', '<div class="guide">' +
      '<h3>The 30 second version</h3><ol><li>Open the first screen. Each card is a complete instruction.</li><li>Put the buy offer in the Grand Exchange exactly as the card says, then tap <b>I placed this</b>.</li><li>Under <b>My trades</b>, tap <b>It bought</b> when it fills, put in the sell offer it shows, and tap <b>It sold</b> when that fills.</li></ol>' +
      '<h3>What flipping is</h3><p>At any moment some players sell an item instantly for a low price and others buy it instantly for a higher price. A flip is buying at the low price and selling at the high one. The gap, minus tax, is your profit.</p>' +
      '<h3>The tax</h3><p>The Grand Exchange keeps 2% of every sale (rounded down, at most 5M per item, nothing on sales under 50 gp). Every profit in this app is already after tax. A handful of cheap starter items are tax-free in the game; the app taxes them anyway, so their real profit is slightly better than shown.</p>' +
      '<h3>Buy limits</h3><p>The game lets you buy only a set number of each item per 4 hours. Cards never ask for more than your limit, and My trades shows when each limit resets.</p>' +
      '<h3>Reading a card</h3><ul><li><b>Strong</b>: passes every check and worked at least 3 times in 4 when replayed on real past prices.</li><li><b>OK</b>: passes the checks, worked more often than not, or has too little history to say.</li><li><b>Risky</b>: fails a check or loses on balance. Risky items never appear on the first screen; you only meet them in the Screener.</li><li><b>Chance it works</b>: the share of past test runs where both the buy and the sell filled in time, with the count shown. It is a record of the past, never a promise.</li></ul>' +
      '<h3>Flip now or Set and forget</h3><p>Flip now uses live prices and expects to finish inside two hours. Set and forget prices both offers at the 24 hour averages and expects to finish within about 16 hours, so place them before you log off.</p>' +
      '<h3>High alch</h3><p>Some items cost less than the gold High Level Alchemy gives for them. The Alch list shows the profit per cast after the item and rune cost. Never pay more than the “never pay more than” price on the card.</p>' +
      '<h3>When things go wrong</h3><p>Prices move. My trades watches every open offer and tells you to hold, lower your price, or sell to limit a loss, with the reason. If the banner at the top says prices stopped updating, do not trade until it goes away.</p>' +
      '<h3>Put it on your home screen</h3><p>iPhone: tap Share, then Add to Home Screen. Android: tap the menu, then Add to Home screen. It then opens like an app.</p>' +
      '<h3>Limits to know</h3><p>The app only updates while it is open. Chances for Flip now use about 30 hours of history and Set and forget about 15 days. It cannot see game updates or price crashes coming.</p></div>', true);
  }
  function renderSheet() {
    var el = $('sheet'), sh = S.sheet;
    el.hidden = !sh;
    document.body.style.overflow = sh ? 'hidden' : '';
    if (!sh) { el.innerHTML = ''; return; }
    var keep = el.firstChild ? el.firstChild.scrollTop : 0, tr = sh.tradeId ? S.trades.filter(function (x) { return x.id === sh.tradeId; })[0] : null;
    var html = sh.type === 'item' ? sheetItem(sh) : sh.type === 'plan' ? sheetPlan() : sh.type === 'bought' || sh.type === 'sold' ? tradeForm(sh.type, tr, sh.price) :
      sh.type === 'manual' ? sheetManual() : sh.type === 'cash' ? sheetCash() : sh.type === 'settings' ? sheetSettings() : sh.type === 'accuracy' ? sheetAccuracy() :
      sh.type === 'feed' ? sheetFeed() : sh.type === 'backup' ? sheetBackup() : sh.type === 'tradeinfo' ? sheetTradeInfo(tr) : sheetGuide();
    el.innerHTML = html;
    if (el.firstChild) el.firstChild.scrollTop = keep;
  }
  var LIVE_SHEETS = { item: 1, plan: 1, accuracy: 1, feed: 1 };

  /* ---------- render loop ---------- */
  function renderView() {
    var v = $('view');
    if (!S.settings) { v.innerHTML = viewSetup(); return; }
    v.innerHTML = S.tab === 'home' ? viewHome() : S.tab === 'screener' ? viewScreener() : S.tab === 'alch' ? viewAlch() : S.tab === 'trades' ? viewTrades() : viewMore();
  }
  function typing() { var a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); }
  var raf = 0;
  function refresh() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; compute(); draw(false); }); }
  function draw(force) {
    renderTop(); renderBanner(); renderTabs();
    if (force || !typing()) {
      if (!S.sheet || force) renderView();
      if (S.sheet && (force || LIVE_SHEETS[S.sheet.type])) renderSheet();
    } else if (S.tab === 'screener' && !S.sheet && $('scr-list')) $('scr-list').innerHTML = screenerList();
  }
  function redraw() { compute(); draw(true); }
  function openSheet(sh) { S.sheet = sh; renderSheet(); }
  function closeSheet() { S.sheet = null; renderSheet(); redraw(); }

  var toastTimer = 0;
  function toast(msg, undo) {
    var t = $('toast'); S.undo = undo || null;
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (undo ? '<button data-act="undo">Undo</button>' : '');
    t.hidden = false; clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; S.undo = null; }, undo ? 7000 : 5000);
  }
  function snapshot() { var copy = JSON.stringify(S.trades); return function () { S.trades = JSON.parse(copy); saveTrades(); redraw(); }; }
  function findTrade(id) { return S.trades.filter(function (x) { return x.id === id; })[0]; }
  function newId() { return 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36); }

  /* ---------- actions ---------- */
  var ACT = {
    tab: function (d) { location.hash = d.tab === 'home' ? '' : d.tab; setTab(d.tab); },
    tip: function (d) { toast(d.tip); },
    undo: function () { var u = S.undo; $('toast').hidden = true; S.undo = null; if (u) u(); },
    close: function () { closeSheet(); },
    open: function (d) { openSheet({ type: d.sheet }); },
    cash: function () { openSheet({ type: 'cash' }); },
    plan: function () { openSheet({ type: 'plan' }); },
    why: function (d) { openSheet({ type: 'item', id: +d.id, mode: d.mode, range: d.mode === 'overnight' ? '1W' : '1D' }); },
    imode: function (d) { S.sheet.mode = d.v; if (d.v === 'overnight' && S.sheet.range === '1D') S.sheet.range = '1W'; renderSheet(); },
    range: function (d) { S.sheet.range = d.v; renderSheet(); },
    star: function (d) { if (S.stars[d.id]) delete S.stars[d.id]; else S.stars[d.id] = 1; store.set('ge.stars', S.stars); renderSheet(); },
    scr: function (d) { var s = S.scr; if (d.k === 'mode') s.mode = d.v; else s[d.k] = !s[d.k]; draw(true); },
    alcsort: function (d) { S.alc.sort = d.v; draw(true); },
    yn: function (d) { var t = S.sheet ? S.sheet.draft : S.draft; readDraft(); t[d.name] = d.val === '1'; S.sheet ? renderSheet() : renderView(); },
    sopt: function (d) { readDraft(); S.sheet.draft[d.name] = +d.val; renderSheet(); },
    mkind: function (d) { readDraft(); S.sheet.draft.kind = d.v; renderSheet(); },
    mbought: function (d) { readDraft(); S.sheet.draft.bought = d.v === '1'; renderSheet(); },
    pick: function (d) { readDraft(); var it = S.items[d.id], dr = S.sheet.draft; dr.itemId = it.id; dr.name = it.name; if (!(it.highalch > 0)) dr.kind = 'flip'; var l = S.mkt.latest[it.id]; if (l && !dr.price && l.low != null) dr.price = String(l.low); renderSheet(); },
    reload: function () { toast('Refreshing prices…'); loadAll(true); },
    place: function (d) {
      var c = S.calc;
      if (!c) return;
      if (c.freeSlots < 1) return toast('No free slot. Finish a trade under My trades first.');
      if (c.openIds[d.id]) return toast('You already have an open trade in this item.');
      var each = +d.buy + (d.mode === 'alch' ? (G.runeCost(S.mkt, S.settings) || 0) : 0);
      var q = quoteFor(+d.id, d.mode, Math.min(c.free, (+d.qty) * each + each - 1)); // same size as the card that was tapped
      if (!q || q.qty < 1) return toast('That deal just disappeared: prices moved. Nothing was saved.');
      var undo = snapshot();
      S.trades.push({ id: newId(), itemId: q.id, name: q.name, kind: q.kind, mode: q.mode, qty: q.qty, buyPrice: q.buyAt, targetSell: q.sellAt || null, alchValue: q.alchValue || null, runeCost: q.runeCost || null, maxPay: q.maxPay || null, placedAt: now(), status: 'buying', pred: { profit: q.profit, chance: q.bt && q.bt.enough ? q.bt.chance : null, n: q.bt ? q.bt.n : 0, minutes: q.bt ? q.bt.medianMinutes || null : null } });
      saveTrades(); if (S.sheet && S.sheet.type === 'item') S.sheet = null;
      renderSheet(); redraw();
      toast('Saved: buy ' + ex(q.qty) + ' ' + q.name + ' at ' + ex(q.buyAt) + ' gp. Find it under My trades.', undo);
    },
    bought: function (d) { openSheet({ type: 'bought', tradeId: d.id }); },
    sold: function (d) { openSheet({ type: 'sold', tradeId: d.id, price: d.price ? +d.price : null }); },
    alched: function (d) { var tr = findTrade(d.id); if (!tr) return; var undo = snapshot(); tr.status = 'done'; tr.doneAt = now(); saveTrades(); redraw(); toast('Nice. ' + gp(G.realized(tr)) + ' gp profit logged.', undo); },
    cancel: function (d) { var tr = findTrade(d.id); if (!tr) return; var undo = snapshot(); tr.status = 'cancelled'; tr.doneAt = now(); saveTrades(); redraw(); toast('Removed ' + tr.name + ' from your open trades.', undo); },
    tradeinfo: function (d) { openSheet({ type: 'tradeinfo', tradeId: d.id }); },
    deltrade: function (d) { var undo = snapshot(); S.trades = S.trades.filter(function (x) { return x.id !== d.id; }); saveTrades(); S.sheet = null; renderSheet(); redraw(); toast('Trade deleted.', undo); },
    copybackup: function () {
      var code = btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, settings: S.settings, trades: S.trades, stars: S.stars }))));
      var done = function () { toast('Backup code copied. Paste it somewhere safe, like your notes.'); };
      var fail = function () { S.sheet.draft.code = code; renderSheet(); toast('Could not copy automatically. The code is in the box: select it and copy.'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, fail); else fail();
    },
    wipe: function () {
      var d = S.sheet.draft;
      if (!d.wipe) { d.wipe = true; return renderSheet(); }
      ['ge.settings', 'ge.trades', 'ge.stars'].forEach(function (k) { delete mem[k]; try { localStorage.removeItem(k); } catch (e) { /* nothing stored */ } });
      S.settings = null; S.trades = []; S.stars = {}; S.sheet = null; S.draft = null; renderSheet(); redraw();
    }
  };
  function readDraft() {
    var form = document.querySelector('[data-form]'), d = S.sheet ? S.sheet.draft : S.draft;
    if (!form || !d) return;
    Array.prototype.forEach.call(form.querySelectorAll('input[name],textarea[name]'), function (el) { d[el.name] = el.value; });
  }
  function farFromMarket(itemId, price, side) {
    var l = S.mkt.latest[itemId]; if (!l) return null;
    var ref = side === 'sell' ? l.high : l.low; if (!(ref > 0)) return null;
    return Math.abs(price - ref) / ref > 0.25 ? ref : null;
  }
  var FORMS = {
    setup: function (d) {
      var cash = G.parseGp(d.cash);
      if (cash == null || cash < 1000) { d.err = 'Type how much gold you have, like 10m or 250k (at least 1k).'; return renderView(); }
      S.settings = { cash: cash, members: !!d.members, canAlch: !!d.canAlch, fireStaff: !!d.fireStaff, maxPct: 25, cards: 5 };
      store.set('ge.settings', S.settings); S.draft = null; redraw(); window.scrollTo(0, 0);
    },
    cash: function (d) {
      var cash = G.parseGp(d.cash);
      if (cash == null || cash < 1000) { d.err = 'Type an amount like 10m or 250k (at least 1k).'; return renderSheet(); }
      S.settings.cash = cash; store.set('ge.settings', S.settings); closeSheet(); toast('Recommendations resized to ' + gp(cash) + '.');
    },
    settings: function (d) {
      var cash = G.parseGp(d.cash);
      if (cash == null || cash < 1000) { d.err = 'Type an amount like 10m or 250k (at least 1k).'; return renderSheet(); }
      S.settings = { cash: cash, members: !!d.members, canAlch: !!d.canAlch, fireStaff: !!d.fireStaff, maxPct: d.maxPct, cards: d.cards };
      store.set('ge.settings', S.settings); closeSheet(); toast('Settings saved.');
    },
    bought: function (d) {
      var tr = findTrade(S.sheet.tradeId), qty = G.parseGp(d.qty), price = G.parseGp(d.price);
      if (!qty || qty < 1 || !price || price < 1) { d.err = 'Enter how many you got and the price each, as numbers.'; d.confirm = false; return renderSheet(); }
      var far = farFromMarket(tr.itemId, price, 'buy');
      if (far && !d.confirm) { d.err = 'That price is far from the market (about ' + ex(far) + ' gp). Check for a typo, or tap again to save it.'; d.confirm = true; return renderSheet(); }
      var undo = snapshot();
      tr.qty = qty; tr.buyPrice = price; tr.status = 'holding'; tr.boughtAt = now(); saveTrades(); closeSheet();
      toast(tr.kind === 'alch' ? 'Now alch them all.' : 'Now put in a sell offer at ' + ex(tr.targetSell) + ' gp each.', undo);
    },
    sold: function (d) {
      var tr = findTrade(S.sheet.tradeId), qty = G.parseGp(d.qty), price = G.parseGp(d.price);
      if (!qty || qty < 1 || !price || price < 1) { d.err = 'Enter how many sold and the price each, as numbers.'; d.confirm = false; return renderSheet(); }
      if (qty > tr.qty) { d.err = 'You only hold ' + ex(tr.qty) + ' of these.'; d.confirm = false; return renderSheet(); }
      var far = farFromMarket(tr.itemId, price, 'sell');
      if (far && !d.confirm) { d.err = 'That price is far from the market (about ' + ex(far) + ' gp). Check for a typo, or tap again to save it.'; d.confirm = true; return renderSheet(); }
      var undo = snapshot(), part = qty < tr.qty, doneTr = tr;
      if (part) {
        doneTr = JSON.parse(JSON.stringify(tr)); doneTr.id = newId(); doneTr.qty = qty;
        if (doneTr.pred) doneTr.pred.profit = Math.round(doneTr.pred.profit * qty / tr.qty);
        if (tr.pred) tr.pred.profit -= doneTr.pred.profit;
        tr.qty -= qty; S.trades.push(doneTr);
      }
      doneTr.status = 'done'; doneTr.soldPrice = price; doneTr.doneAt = now(); saveTrades(); closeSheet();
      var p = G.realized(doneTr);
      toast((p >= 0 ? 'Profit logged: +' : 'Loss logged: ') + gp(p) + ' gp after tax.' + (part ? ' The rest stays open.' : ''), undo);
    },
    manual: function (d) {
      var it = d.itemId ? S.items[d.itemId] : null, qty = G.parseGp(d.qty), price = G.parseGp(d.price), sell = d.sell ? G.parseGp(d.sell) : null;
      if (!it) { d.err = 'Pick an item from the list that appears while you type.'; return renderSheet(); }
      if (!qty || qty < 1 || !price || price < 1) { d.err = 'Enter how many and the buy price each, as numbers.'; d.confirm = false; return renderSheet(); }
      if (d.sell && !sell) { d.err = 'The sell price is not a number. Type it like 1310 or 1.3m, or leave it empty.'; d.confirm = false; return renderSheet(); }
      var warn = [], far = farFromMarket(it.id, price, 'buy');
      if (far) warn.push('the buy price is far from the market (about ' + ex(far) + ' gp)');
      if (it.limit && qty > it.limit) warn.push('the quantity is above the buy limit of ' + ex(it.limit));
      if (d.kind === 'flip' && sell && sell <= price) warn.push('the sell price is not above the buy price');
      if (warn.length && !d.confirm) { d.err = 'Check this: ' + warn.join(', and ') + '. Tap again to save it anyway.'; d.confirm = true; return renderSheet(); }
      var l = S.mkt.latest[it.id] || {}, st = S.settings, undo = snapshot(), tr = { id: newId(), itemId: it.id, name: it.name, kind: d.kind, mode: 'active', qty: qty, buyPrice: price, placedAt: now(), status: d.bought ? 'holding' : 'buying', pred: null };
      if (d.bought) tr.boughtAt = now();
      if (d.kind === 'alch') { tr.mode = 'alch'; tr.alchValue = it.highalch; tr.runeCost = G.runeCost(S.mkt, st) || 0; tr.maxPay = it.highalch - tr.runeCost - 1; }
      else tr.targetSell = sell || (l.high != null && l.high > price ? l.high : G.breakEvenSell(price));
      S.trades.push(tr); saveTrades(); closeSheet(); toast('Trade added.', undo);
    },
    restore: function (d) {
      var data;
      try { data = JSON.parse(decodeURIComponent(escape(atob(String(d.code).trim())))); } catch (e) { data = null; }
      if (!data || !data.settings || !Array.isArray(data.trades) || !(data.settings.cash > 0)) { d.err = 'That is not a valid backup code. Copy the whole code and paste it again.'; d.confirm = false; return renderSheet(); }
      if (!d.confirm) { d.err = 'This replaces the ' + S.trades.length + ' trades and the settings on this phone with the backup (' + data.trades.length + ' trades). Tap again to go ahead.'; d.confirm = true; return renderSheet(); }
      S.settings = data.settings; S.trades = data.trades; S.stars = data.stars || {};
      store.set('ge.settings', S.settings); saveTrades(); store.set('ge.stars', S.stars); closeSheet(); toast('Backup restored.');
    }
  };

  document.addEventListener('click', function (e) {
    if (e.target.id === 'sheet') return closeSheet();
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) return;
    var fn = ACT[el.dataset.act];
    if (fn) { if (el.tagName !== 'A') e.preventDefault(); fn(el.dataset, el); }
  });
  document.addEventListener('submit', function (e) {
    var f = e.target.getAttribute('data-form');
    if (!f || !FORMS[f]) return;
    e.preventDefault(); readDraft();
    var d = S.sheet ? S.sheet.draft : S.draft;
    if (d) d.err = null;
    FORMS[f](d);
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'scr-q') { S.scr.q = t.value; $('scr-list').innerHTML = screenerList(); }
    else if (t.id === 'man-name') {
      var d = S.sheet.draft; d.name = t.value; d.itemId = null;
      var q = t.value.toLowerCase(), m = q ? S.itemList.filter(function (x) { return x.name.toLowerCase().indexOf(q) >= 0; }).sort(function (a, b) { return a.name.length - b.name.length; }).slice(0, 6) : [];
      $('man-sug').innerHTML = m.length ? '<div class="list">' + m.map(function (x) { return '<button type="button" class="item" data-act="pick" data-id="' + x.id + '">' + icon(x) + '<span class="n">' + esc(x.name) + '</span><span></span></button>'; }).join('') + '</div>' : (q ? '<p class="hint">No item with that name.</p>' : '');
    } else if (t.name && (S.sheet ? S.sheet.draft : S.draft)) { var dr = S.sheet ? S.sheet.draft : S.draft; dr[t.name] = t.value; dr.confirm = false; }
  });
  document.addEventListener('change', function (e) { if (e.target.id === 'scr-sort') { S.scr.sort = e.target.value; e.target.blur(); draw(true); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.sheet) closeSheet(); });

  function setTab(t) { if (TABS.indexOf(t) < 0) t = 'home'; if (S.tab !== t) { S.tab = t; window.scrollTo(0, 0); } S.sheet = null; renderSheet(); redraw(); }
  window.addEventListener('hashchange', function () { setTab(location.hash.replace('#', '') || 'home'); });

  /* ---------- polling ---------- */
  var tick = 0;
  function loadAll(force) {
    var jobs = [loadLatest()];
    if (force || tick % 5 === 0) jobs.push(loadM5());
    if (force || tick % 10 === 0) jobs.push(loadH1());
    if (force || tick % 30 === 0) jobs.push(loadD1());
    if (!S.itemList.length || force) jobs.push(loadMapping());
    tick++;
    return Promise.all(jobs).then(refresh);
  }
  setInterval(function () { if (!document.hidden) loadAll(false); }, 60000);
  setInterval(function () { if (!document.hidden) { renderTop(); renderBanner(); } }, 10000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    pump();
    if (!S.feed.latest.at || now() - S.feed.latest.at > 55) loadAll(now() - (S.feed.latest.at || 0) > 600);
  });
  window.addEventListener('online', function () { loadAll(true); });
  window.addEventListener('offline', function () { renderBanner(); });

  S.tab = TABS.indexOf(location.hash.replace('#', '')) >= 0 ? location.hash.replace('#', '') : 'home';
  draw(true);
  loadMapping().then(function () { refresh(); return loadAll(true); });
})();
