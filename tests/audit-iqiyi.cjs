// Live audit: real delivery varies; zero matches is NOT a passing ad test.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const types = {
  card: '[class*="filmFeed_filmFeed__"]:has([class*="filmFeed_adBadge__"])',
  game: '[class*="filmFeed_filmFeed__"]:has([class*="filmFeed_gameBtn__"]), a:is([href*="order_plan_id="][href*="creative_id="][href*="impress_id="], [href^="https://ads.game.iqiyi.com/"], [href^="//ads.game.iqiyi.com/"]):has(> [class*="thumbnail_thumbnailItemWrap__"])',
  picture: '[class*="videoListAdPic_container__"]',
  video: '[class*="videoListAdVideo_container__"]',
  mini: '[class*="adTheater_container__"]',
  horizontal: '[class*="adTonglan_wrap__"], [class*="videoListItem_imageTitleInRow__"]:has(img[data-ai-entity="广告配图"])'
};
(async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: true, viewport: { width: 1900, height: 1000 },
    ...(process.env.CLEARPLAY_BROWSER_PATH ? { executablePath: process.env.CLEARPLAY_BROWSER_PATH } : { channel: 'chromium' }),
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => chrome.storage.local.set({ pauseAdsEnabled: false }));
    const page = await context.newPage();
    await page.goto('https://www.iqiyi.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.mouse.move(1000, 650);
    for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 650); await page.waitForTimeout(300); }
    const sample = () => page.evaluate(types => {
      const rendered = el => {
        if (!el.getClientRects().length) return false;
        for (let n = el; n; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        }
        return true;
      };
      return {
        enabled: document.documentElement.getAttribute('data-clearplay-pause-ads'),
        categories: Object.fromEntries(Object.entries(types).map(([key, selector]) => {
          const els = [...document.querySelectorAll(selector)];
          return [key, { matched: els.length, rendered: els.filter(rendered).length,
            playing: els.flatMap(e => [...e.querySelectorAll('video,audio')]).filter(v => !v.paused).length }];
        })),
        normal: [...document.querySelectorAll('[class*="filmFeed_filmFeed__"]:not(:has([class*="filmFeed_adBadge__"],[class*="filmFeed_gameBtn__"]))')].filter(rendered).length,
        // Locate unclassified ad markers and game buttons without logging links or user data.
        unclassified: [...document.querySelectorAll('[class*="adBadge__"],[class*="gameBtn__"],[class*="adMark__"]')]
          .filter(e => rendered(e) && !e.closest(Object.values(types).join(',')))
          .map(e => ({ class: e.className, parent: e.parentElement?.className }))
      };
    }, types);
    const before = await sample();
    await worker.evaluate(() => chrome.storage.local.set({ pauseAdsEnabled: true }));
    await page.waitForTimeout(600);
    const after = await sample();
    await worker.evaluate(() => chrome.storage.local.set({ pauseAdsEnabled: false }));
    await page.waitForTimeout(300);
    const restored = await sample();
    await worker.evaluate(() => chrome.storage.local.set({ pauseAdsEnabled: true }));
    await page.waitForTimeout(300);
    const reenabled = await sample();
    const report = { version: JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).version, before, after, restored, reenabled };
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test-results', `iqiyi-live-audit-${report.version}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await context.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
