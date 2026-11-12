const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const fx = require('./fixtures.js');
const ROOT = path.join(__dirname, '..'), OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': types[path.extname(f)] || 'text/plain' }); res.end(b); });
});
(async () => {
  await new Promise(r => server.listen(8765, r));
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = []; let apiCalls = 0, fail = process.env.FAIL_FEED === '1';
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  await page.route('https://prices.runescape.wiki/**', route => {
    apiCalls++;
    if (fail) return route.abort();
    const body = fx.handle(route.request().url());
    if (body == null) return route.fulfill({ status: 404, body: 'nope' });
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await page.route('https://oldschool.runescape.wiki/**', r => r.abort());
  const shot = async (n, full) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: !!full });
  const log = (...a) => console.log(...a);
  const txt = async sel => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ');

  await page.goto('http://localhost:8765/');
  await page.waitForSelector('form[data-form=setup]');
  await shot('01-setup');
  await page.click('button[type=submit]');                      // empty cash -> error
  log('setup error:', await txt('.warnbox'));
  await page.fill('input[name=cash]', '10m');
  await page.click('button[type=submit]');
  await page.waitForSelector('.card');
  await page.waitForFunction(() => !document.querySelector('.pulse'), null, { timeout: 60000 });
  await shot('02-home', true);
  log('top:', await txt('#top'));
  const cards = await page.locator('#view .card').count();
  log('home cards:', cards);
  for (const c of await page.locator('#view .card').all()) log(' -', (await c.innerText()).replace(/\s+/g, ' ').slice(0, 260));
  log('home text has risky items?', /Stale relic|Illiquid idol|Falling knife|Too good ring|Old school bond/.test(await page.locator('#view').innerText()));

  await page.locator('#view .card [data-act=why]').first().click();
  await page.waitForSelector('.sheet-in .chart svg', { timeout: 20000 });
  await shot('03-item');
  await page.locator('.sheet-in').evaluate(e => e.scrollTo(0, 600)); await shot('03b-item-scrolled');
  await page.click('[data-act=range][data-v="1W"]'); await page.waitForSelector('.sheet-in .chart svg', { timeout: 20000 });
  await page.click('[data-act=close]');

  await page.click('[data-act=plan]'); await page.waitForSelector('.sheet-in .card');
  log('plan:', await txt('.sheet-in .lead')); await shot('04-plan');
  await page.click('[data-act=close]');

  const firstName = await page.locator('#view .card h3').first().innerText();
  await page.locator('#view .card [data-act=place]').first().click();
  log('toast after place:', await txt('#toast'));
  log('placed item still on home?', (await page.locator('#view').innerText()).includes(firstName));
  await page.click('.tab[data-tab=trades]'); await page.waitForSelector('.advice');
  await shot('05-trades', true);
  log('trade card:', await txt('#view .card'));
  await page.click('[data-act=bought]'); await page.waitForSelector('form[data-form=bought]');
  await page.fill('input[name=price]', '5'); await page.click('.sheet-in button[type=submit]');
  log('typo guard:', await txt('.sheet-in .warnbox'));
  const tr = await page.evaluate(() => JSON.parse(localStorage.getItem('ge.trades'))[0]);
  await page.fill('input[name=price]', String(tr.buyPrice)); await page.click('.sheet-in button[type=submit]');
  log('toast after bought:', await txt('#toast'));
  log('holding card:', await txt('#view .card'));
  await page.click('[data-act=sold]'); await page.waitForSelector('form[data-form=sold]'); await shot('06-sold-form');
  await page.click('.sheet-in button[type=submit]');
  log('toast after sold:', await txt('#toast'));
  await shot('07-trades-done', true);
  log('results:', await txt('.stat3'));
  const done = await page.evaluate(() => JSON.parse(localStorage.getItem('ge.trades'))[0]);
  log('stored trade:', JSON.stringify(done));

  await page.click('[data-act=open][data-sheet=manual]'); await page.fill('#man-name', 'shar'); await page.waitForSelector('#man-sug .item');
  await page.click('#man-sug .item'); await page.fill('input[name=qty]', '99999'); await page.click('.sheet-in button[type=submit]');
  log('manual guard:', await txt('.sheet-in .warnbox')); await shot('08-manual');
  await page.fill('input[name=qty]', '100'); await page.click('.sheet-in button[type=submit]');
  log('toast manual:', await txt('#toast'));
  await page.click('#toast [data-act=undo]');
  log('after undo open trades:', await page.evaluate(() => JSON.parse(localStorage.getItem('ge.trades')).filter(t => t.status === 'buying').length));

  await page.click('.tab[data-tab=screener]'); await page.waitForSelector('#scr-list .item'); await shot('09-screener');
  log('screener rows (passing):', await page.locator('#scr-list .item').count());
  await page.click('[data-act=scr][data-k=pass]');
  log('screener rows (all):', await page.locator('#scr-list .item').count());
  await page.fill('#scr-q', 'script'); log('search escaped row:', await txt('#scr-list .item'), '| injected script tags:', await page.locator('#scr-list script').count());
  await page.fill('#scr-q', 'falling'); await page.click('#scr-list .item'); await page.waitForSelector('.sheet-in .checks');
  log('falling knife checks:', await txt('.sheet-in .checks')); await shot('10-risky-item');
  await page.click('[data-act=close]');
  await page.click('.tab[data-tab=alch]'); await page.waitForSelector('#view .item'); await shot('11-alch');
  log('alch rows:', await page.locator('#view .item').count(), '|', await txt('#view .item'));
  await page.click('.tab[data-tab=more]');
  await page.click('[data-sheet=accuracy]'); log('accuracy:', (await txt('.sheet-in')).slice(0, 500)); await shot('12-accuracy'); await page.click('[data-act=close]');
  await page.click('[data-sheet=feed]'); log('feed:', (await txt('.sheet-in table')).slice(0, 400)); await shot('13-feed'); await page.click('[data-act=close]');
  await page.click('[data-sheet=guide]'); await shot('14-guide'); await page.click('[data-act=close]');
  await page.click('[data-sheet=settings]'); await shot('15-settings'); await page.click('[data-act=close]');
  await shot('16-more');

  // feed failure: banner must show, no fake data
  fail = true;
  await page.click('[data-sheet=feed]'); await page.click('[data-act=reload]'); await page.waitForTimeout(1500);
  log('feed while failing:', (await txt('.sheet-in table')).slice(0, 300));
  await page.click('[data-act=close]');
  // fresh visitor with dead feed
  const p2 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await p2.route('https://prices.runescape.wiki/**', r => r.abort()); await p2.route('https://oldschool.runescape.wiki/**', r => r.abort());
  await p2.goto('http://localhost:8765/'); await p2.fill('input[name=cash]', '250k'); await p2.click('button[type=submit]'); await p2.waitForTimeout(1200);
  log('dead feed banner:', (await p2.locator('#banner').innerText()).trim()); log('dead feed view:', (await p2.locator('#view').innerText()).replace(/\s+/g, ' ').slice(0, 200));
  await p2.screenshot({ path: path.join(OUT, '17-dead-feed.png') });

  log('api calls:', apiCalls); log('console errors:', errors.filter(e => !/ERR_FAILED|net::/.test(e)).length ? errors : 'none (ignoring blocked test requests)');
  await browser.close(); server.close();
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
