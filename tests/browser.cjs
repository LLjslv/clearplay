const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const fixture = '<!doctype html><html><body><main><div id="player"><video id="main-video"></video><div id="controls"><button>播放</button><span>字幕</span></div><div id="pause-ad" class="txp_ad" data-role="txpad-interact-pause" style="display:block!important">广告</div><div id="other-ad" class="txp_ad" data-role="txpad-interact-pre">前贴片</div><div id="recommendation">暂停时推荐</div></div></main></body></html>';
let count = 0;
function passed(label) { count++; console.log("PASS " + label); }

(async () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.deepEqual(manifest.permissions, ["storage", "scripting"]);
  assert.deepEqual(manifest.host_permissions, ["https://v.qq.com/*", "https://www.iqiyi.com/*", "https://iqiyi.com/*"]);
  for (const script of manifest.content_scripts) {
    assert.deepEqual(script.matches, ["https://v.qq.com/*", "https://www.iqiyi.com/*", "https://iqiyi.com/*"]);
    for (const file of script.js) assert.ok(fs.existsSync(path.join(root, file)));
  }
  passed("manifest limits host access to supported video sites");
  const context = await chromium.launchPersistentContext("", {
    headless: true,
    ...(process.env.CLEARPLAY_BROWSER_PATH
      ? { executablePath: process.env.CLEARPLAY_BROWSER_PATH } : { channel: "chromium" }),
    args: ["--disable-extensions-except=" + root, "--load-extension=" + root, "--autoplay-policy=no-user-gesture-required"]
  });
  try {
    await context.route("https://v.qq.com/**", route => route.fulfill({
      contentType: "text/html; charset=utf-8", body: fixture
    }));
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10000 });
    const extensionId = new URL(worker.url()).host;

    await context.route('https://v.qq.com/carousel-test', route => route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><div class="video-focus"><a id="poster" href="https://example.com">游戏广告</a><div class="close-btn close-btn-web" data-v-c9e412c6><span>关闭广告</span></div></div><button class="close-btn close-btn-web" id="unrelated">普通关闭</button><script>window.adClicks=0;window.carouselClosed=0;document.getElementById("poster").onclick=e=>{e.preventDefault();adClicks++};document.querySelector("[data-v-c9e412c6]").onclick=e=>{window.carouselClosed++;e.currentTarget.remove();document.getElementById("poster").textContent="正常影视推荐"};</script>'}));
    const carousel = await context.newPage();
    await carousel.goto('https://v.qq.com/carousel-test');
    await carousel.waitForFunction(() => window.carouselClosed===1);
    assert.equal(await carousel.locator('#poster').textContent(),'正常影视推荐');
    assert.equal(await carousel.evaluate(()=>window.adClicks),0);
    assert.equal(await carousel.locator('#unrelated').isVisible(),true);
    passed('Tencent carousel ad closes through native handler without clicking the poster or hiding normal focus');
    await worker.evaluate(()=>chrome.storage.local.set({pauseAdsEnabled:false}));
    await carousel.reload();
    await carousel.waitForTimeout(350);
    assert.equal(await carousel.evaluate(()=>window.carouselClosed),0);
    await worker.evaluate(()=>chrome.storage.local.set({pauseAdsEnabled:true}));
    await carousel.waitForFunction(()=>window.carouselClosed===1);
    await carousel.evaluate(()=>{
      const button=document.createElement('div');button.className='close-btn close-btn-web';button.setAttribute('data-v-c9e412c6','');button.textContent='关闭广告';document.querySelector('.video-focus').append(button);
      setTimeout(()=>{button.onclick=()=>{window.carouselClosed++;button.remove()}},100);
    });
    await carousel.waitForFunction(()=>window.carouselClosed===2);
    passed('Tencent carousel handles stored switch and late native handlers without popup');
    await carousel.close();
    // These checks never open the popup, click the toolbar, or inject scripts.
    // Force the old background-only CSS path to fail to exercise autonomous fallback.
    await worker.evaluate(() => {
      globalThis.originalInsertCSS = chrome.scripting.insertCSS;
      chrome.scripting.insertCSS = async () => { throw new Error("Simulated background CSS failure"); };
    });
    const autoIq = '<!doctype html><html><body><div class="iqp-player"><video id="main"></video><div id="auto-ad" class="common-pause ad-clickable" style="display:block!important">暂停广告</div><button id="control">播放</button></div></body></html>';
    await context.route("https://www.iqiyi.com/v_auto**", r => r.fulfill({ contentType: "text/html", body: autoIq }));
    for (const site of [
      { url: "https://v.qq.com/auto-first", next: "https://v.qq.com/auto-next", id: "pause-ad", html: fixture },
      { url: "https://www.iqiyi.com/v_auto_first.html", next: "https://www.iqiyi.com/v_auto_next.html", id: "auto-ad", html: autoIq }
    ]) {
      let autoPage = await context.newPage();
      const hidden = () => autoPage.waitForFunction(id => getComputedStyle(document.getElementById(id)).display === "none", site.id);
      await autoPage.goto(site.url);
      await hidden();
      passed("automatic initial visit without popup or background CSS: " + new URL(site.url).hostname);
      await autoPage.goto(site.next);
      await hidden();
      passed("automatic full navigation to another video: " + new URL(site.url).hostname);
      await autoPage.evaluate(({ html }) => {
        history.pushState({}, "", "?episode=next");
        const doc = new DOMParser().parseFromString(html, "text/html");
        document.body.replaceWith(doc.body);
      }, site);
      await hidden();
      passed("automatic SPA player replacement: " + new URL(site.url).hostname);
      await autoPage.evaluate(id => {
        document.documentElement.removeAttribute("data-clearplay-site");
        document.documentElement.removeAttribute("data-clearplay-pause-ads");
        document.getElementById(id).style.setProperty("display", "flex", "important");
      }, site.id);
      await hidden();
      assert.equal(await autoPage.locator("html").getAttribute("data-clearplay-pause-ads"), "on");
      passed("automatic recovery from site attribute and inline-style changes: " + new URL(site.url).hostname);
      await autoPage.close();
      autoPage = await context.newPage();
      await autoPage.goto(site.url);
      await hidden();
      passed("automatic return after closing the video tab: " + new URL(site.url).hostname);
      await autoPage.reload();
      await hidden();
      passed("automatic refresh without toolbar activation: " + new URL(site.url).hostname);
      await autoPage.close();
    }
    await worker.evaluate(() => { chrome.scripting.insertCSS = globalThis.originalInsertCSS; });

    const page = await context.newPage();
    const feed = await context.newPage();
    await feed.goto("https://v.qq.com/channel/choice");
    await feed.evaluate(() => {
      document.body.innerHTML = '<div id="feed"><div id="card" class="video-card-wrap flow-card--web" style="display:flex!important"><video muted></video><div class="ad-flag" title="关闭广告">广告</div></div><div id="normal" class="video-card-wrap flow-card--web">传奇游戏介绍 了解详情</div></div>';
      window.clicks = 0;
      document.body.addEventListener("click", () => window.clicks++);
    });
    await feed.waitForFunction(() => getComputedStyle(document.querySelector('#card')).display === 'none');
    assert.notEqual(await feed.locator('#normal').evaluate(e => getComputedStyle(e).display), 'none');
    passed('feed advertising card hidden without hiding normal recommendations');
    await feed.evaluate(async () => {
      const canvas = document.createElement('canvas');
      const video = document.querySelector('#card video');
      video.srcObject = canvas.captureStream();
      await video.play().catch(error => { if (error.name !== 'AbortError') throw error; });
    });
    await feed.waitForFunction(() => document.querySelector('#card video').paused);
    assert.equal(await feed.evaluate(() => window.clicks), 0);
    passed('feed ad media stops without clicking promotion links');
    await worker.evaluate(() => chrome.storage.local.set({ pauseAdsEnabled: false }));
    await feed.waitForFunction(() => getComputedStyle(document.querySelector('#card')).display === 'flex');
    await worker.evaluate(() => chrome.storage.local.set({ pauseAdsEnabled: true }));
    await feed.waitForFunction(() => getComputedStyle(document.querySelector('#card')).display === 'none');
    passed('feed card respects stored switch and restores original layout');
    await feed.evaluate(() => document.querySelector('.ad-flag').remove());
    await feed.waitForFunction(() => getComputedStyle(document.querySelector('#card')).display === 'flex');
    await feed.evaluate(() => document.querySelector('#card').insertAdjacentHTML('beforeend', '<div class="ad-flag" title="普通标记"></div>'));
    await feed.evaluate(() => document.querySelector('.ad-flag').title = '关闭广告');
    await feed.waitForFunction(() => getComputedStyle(document.querySelector('#card')).display === 'none');
    passed('recycled cards restore and delayed ad markers trigger filtering');
    await feed.evaluate(() => {
      history.pushState({}, '', '?category=next');
      document.querySelector('#feed').insertAdjacentHTML('beforeend', '<div id="late" class="video-card-wrap flow-card--web"><div class="ad-flag" title="关闭广告"></div></div>');
    });
    await feed.waitForFunction(() => getComputedStyle(document.querySelector('#late')).display === 'none');
    await feed.close();
    passed('new feed cards are filtered after in-page navigation without popup');
    const iqFeed = await context.newPage();
    const iqFeedHtml = '<div id="list"><div id="ad" class="filmFeed_filmFeed__FD2Yx" style="display:flex!important"><video muted></video><a><div class="filmFeed_imgwrap__Dq5ea"><div id="badge" class="filmFeed_adBadge__lGCNW">广告</div></div></a><button class="pause-close">了解详情</button></div><div id="normal" class="filmFeed_filmFeed__other">传奇游戏介绍 广告 <video muted></video></div></div>';
    await context.route('https://www.iqiyi.com/clearplay-feed**', r => r.fulfill({contentType:'text/html', body:iqFeedHtml}));
    await iqFeed.goto('https://www.iqiyi.com/clearplay-feed');
    const iqDisplay = (id, value) => iqFeed.waitForFunction(({id,value}) => getComputedStyle(document.getElementById(id)).display === value, {id,value});
    await iqDisplay('ad', 'none');
    await iqDisplay('normal', 'block');
    passed('iQiyi feed ad hidden automatically while ordinary cards and ad-related titles remain');
    await iqFeed.evaluate(async () => {
      window.clicks=0;
      document.body.addEventListener('click', () => window.clicks++);
      for (const video of document.querySelectorAll('video')) {
        const canvas=document.createElement('canvas');
        canvas.getContext('2d').fillRect(0,0,16,16);
        video.srcObject=canvas.captureStream(10);
        await video.play().catch(e => {if(e.name!=='AbortError')throw e;});
      }
    });
    await iqFeed.waitForFunction(() => document.querySelector('#ad video').paused && !document.querySelector('#normal video').paused);
    await iqFeed.waitForTimeout(300);
    assert.equal(await iqFeed.evaluate(() => window.clicks),0);
    passed('iQiyi feed media stops without pausing normal previews or clicking links');
    await worker.evaluate(() => chrome.storage.local.set({pauseAdsEnabled:false}));
    await iqDisplay('ad','flex');
    await iqFeed.reload();
    await iqDisplay('ad','flex');
    await worker.evaluate(() => chrome.storage.local.set({pauseAdsEnabled:true}));
    await iqDisplay('ad','none');
    passed('iQiyi feed switch persists and restores original display');
    await iqFeed.evaluate(() => document.querySelector('#badge').className='ordinary-badge');
    await iqDisplay('ad','flex');
    await iqFeed.evaluate(() => document.querySelector('#badge').className='filmFeed_adBadge__newhash');
    await iqDisplay('ad','none');
    await iqFeed.evaluate(() => document.querySelector('#badge').remove());
    await iqDisplay('ad','flex');
    passed('iQiyi recycled cards recover when ad markers change or disappear');
    await iqFeed.evaluate(() => {
      history.pushState({},'', '?next');
      document.querySelector('#ad').insertAdjacentHTML('beforeend','<div class="filmFeed_adBadge__dynamic">广告</div>');
    });
    await iqDisplay('ad','none');
    await iqFeed.reload();
    await iqDisplay('ad','none');
    await iqFeed.evaluate(() => {
      document.body.innerHTML = '<div id="list" class="compFuncs_simpleWrap__x"><div id="game" class="filmFeed_filmFeed__x" style="display:flex!important"><video muted></video><div class="filmFeed_gameBtn__x">开始游戏</div></div><div id="banner"><a><div class="videoListAdPic_container__x"><img></div></a></div><div id="small-row"><a><div id="small" class="adTheater_container__x"><img><img class="compFuncs_adBadge__x"></div></a></div><div id="normal" class="filmFeed_filmFeed__x">游戏介绍 开始游戏 广告</div></div>';
      window.clicks=0;
      document.body.onclick=()=>window.clicks++;
    });
    for (const id of ['game','banner','small']) await iqDisplay(id,'none');
    await iqDisplay('list','block');
    await iqDisplay('normal','block');
    passed('iQiyi game cards, picture ads and theater mini cards hide without hiding the shared video list');
    await worker.evaluate(() => chrome.storage.local.set({pauseAdsEnabled:false}));
    await iqDisplay('game','flex');
    await iqDisplay('banner','block');
    await iqDisplay('small','block');
    await worker.evaluate(() => chrome.storage.local.set({pauseAdsEnabled:true}));
    for (const id of ['game','banner','small']) await iqDisplay(id,'none');
    passed('new iQiyi promotion templates restore on disable and hide again on enable');
    await iqFeed.evaluate(() => document.querySelector('[class*="filmFeed_gameBtn__"]').remove());
    await iqDisplay('game','flex');
    await iqFeed.evaluate(() => document.querySelector('#small-row').insertAdjacentHTML('beforeend','<div id="late-small" class="adTheater_container__newhash">广告</div>'));
    await iqDisplay('late-small','none');
    assert.equal(await iqFeed.evaluate(()=>window.clicks),0);
    passed('reused game cards restore and late mini ads hide without promotion clicks');
    // Live-observed generic image/text row: only its explicit ad image is decisive.
    await iqFeed.evaluate(() => {
      document.body.innerHTML = '<section id="mixed-row">' + ['row-ad','row-normal','row-late'].map(id => '<div class="videoListItem_imageTitleInRow__wyUph" id="'+id+'" style="display:flex!important"><div class="videoListItem_imageZoneHover__r2r8-"><a><div class="videoListItem_imageContainer__GeagJ"><img '+(id==='row-ad'?'data-ai-entity="广告配图"':'data-ai-entity="视频配图"')+'><div class="marks_container__VCo-S"><img class="marks_mark__hrsdg"></div></div></a></div><a class="videoListItem_inLineTitleAlinkCon__nQdvv">广告题材的普通剧集也要保留</a></div>').join('')+'</section>';
    });
    await iqDisplay('row-ad','none');
    await iqDisplay('row-normal','flex');
    await iqDisplay('mixed-row','block');
    passed('observed generic horizontal ad hides while adjacent unmarked programme stays');
    await iqFeed.evaluate(() => document.querySelector('#row-late img').setAttribute('data-ai-entity','广告配图'));
    await iqDisplay('row-late','none');
    passed('late ad-image metadata triggers filtering without opening popup');
    await worker.evaluate(() => chrome.storage.local.set({pauseAdsEnabled:false}));
    await iqDisplay('row-ad','flex');
    await worker.evaluate(() => chrome.storage.local.set({pauseAdsEnabled:true}));
    await iqDisplay('row-ad','none');
    await iqFeed.evaluate(() => document.querySelector('#row-ad img').setAttribute('data-ai-entity','视频配图'));
    await iqDisplay('row-ad','flex');
    passed('generic horizontal cards restore on disable and when reused for normal content');
    await iqFeed.evaluate(() => {
      document.body.innerHTML = '<div id="packed" class="compFuncs_simpleWrap__fixture" style="display:flex;flex-wrap:wrap;width:330px;gap:10px">'+
      '<a id="first" style="width:100px;height:50px" href="#first">First</a>'+
      '<div id="empty-slot" style="width:100px;height:50px;display:block!important"><a><div class="filmFeed_filmFeed__ad"><span class="filmFeed_adBadge__x"></span></div></a></div>'+
      '<a id="second" style="width:100px;height:50px" href="#second">Second</a><a id="third" style="width:100px;height:50px">Third</a></div>'+
      '<div class="list_list__fixture"><div id="mixed-slot-row" style="display:flex"><div id="horizontal-slot" style="min-width:320px"><div><div class="videoListItem_imageTitleInRow__x"><img data-ai-entity="广告配图"></div></div></div><div id="ordinary-slot">Normal</div></div></div>'+
      '<div class="list_list__fixture"><div id="all-ads-row" style="margin-bottom:40px"><div><div class="videoListItem_imageTitleInRow__x"><img data-ai-entity="广告配图"></div></div></div></div>';
      window.originalSecond = document.getElementById('second');
    });
    await iqDisplay('empty-slot','none');
    await iqDisplay('horizontal-slot','none');
    await iqDisplay('all-ads-row','none');
    await iqDisplay('ordinary-slot','block');
    assert.equal(await iqFeed.evaluate(() => document.getElementById('first').offsetTop === document.getElementById('third').offsetTop),true);
    assert.equal(await iqFeed.evaluate(() => window.originalSecond === document.getElementById('second')),true);
    passed('ad-only wrappers collapse and normal cards fill the same row without replacing nodes');
    await worker.evaluate(() => chrome.storage.local.set({pauseAdsEnabled:false}));
    await iqDisplay('empty-slot','block');
    await iqDisplay('horizontal-slot','block');
    assert.equal(await iqFeed.evaluate(() => document.getElementById('first').offsetTop < document.getElementById('third').offsetTop),true);
    await worker.evaluate(() => chrome.storage.local.set({pauseAdsEnabled:true}));
    await iqDisplay('empty-slot','none');
    await iqFeed.evaluate(() => document.getElementById('empty-slot').insertAdjacentHTML('beforeend','<button>Normal action</button>'));
    await iqDisplay('empty-slot','block');
    passed('compaction restores layout on disable and keeps a reused slot containing normal controls');
    // The horizontal ad family has an image AND a text region inside each item.
    // Its whole row must collapse without touching recommendations above or below.
    await iqFeed.evaluate(() => {
      document.body.innerHTML = '<main id="tonglan-list"><div id="above" class="filmFeed_filmFeed__normal">普通视频 广告介绍<video id="normal-preview" muted></video></div><div id="tonglan" class="adTonglan_wrap__aM0IC" style="display:flex!important">' +
        [1,2,3].map(n => '<a id="tonglan-item-' + n + '" class="adTonglan_itemWrap__R80Nx" style="display:flex!important"><div class="adTonglan_imgWrap__fixture"><img><video muted></video></div><div class="adTonglan_textWrap__fixture">游戏推广 ' + n + '</div></a>').join('') +
        '</div><div id="below" class="filmFeed_filmFeed__normal">猜你喜欢 普通推荐</div></main>';
      window.tonglanClicks = 0;
      document.body.onclick = () => window.tonglanClicks++;
    });
    await iqDisplay('tonglan','none');
    for (const id of ['tonglan-list','above','below']) await iqDisplay(id,'block');
    for (const n of [1,2,3]) await iqDisplay('tonglan-item-' + n,'none');
    passed('iQiyi horizontal image-and-text ad row collapses while surrounding recommendations remain');
    await worker.evaluate(() => chrome.storage.local.set({pauseAdsEnabled:false}));
    await iqDisplay('tonglan','flex');
    for (const n of [1,2,3]) await iqDisplay('tonglan-item-' + n,'flex');
    await iqFeed.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.getContext('2d').fillRect(0,0,16,16);
      window.tonglanStream = canvas.captureStream(10);
      for (const video of document.querySelectorAll('#tonglan-list video')) {
        video.srcObject = window.tonglanStream;
        await video.play();
      }
    });
    await worker.evaluate(() => chrome.storage.local.set({pauseAdsEnabled:true}));
    await iqDisplay('tonglan','none');
    await iqFeed.waitForFunction(() => [...document.querySelectorAll('#tonglan video')].every(v => v.paused) && !document.querySelector('#normal-preview').paused);
    assert.equal(await iqFeed.evaluate(() => window.tonglanClicks),0);
    passed('horizontal ad switch restores original flex layout and stops only ad media without clicking');
    await iqFeed.evaluate(() => {
      document.querySelector('#tonglan').className = 'ordinary-row';
      document.querySelectorAll('#tonglan > a').forEach(item => item.className = 'ordinary-item');
    });
    await iqDisplay('tonglan','flex');
    for (const n of [1,2,3]) await iqDisplay('tonglan-item-' + n,'flex');
    await iqFeed.evaluate(() => document.querySelector('#tonglan').className = 'adTonglan_wrap__newhash');
    await iqDisplay('tonglan','none');
    passed('recycled horizontal ad containers restore when classes change and re-hide with a new template hash');
    await iqFeed.evaluate(() => {
      document.querySelector('#tonglan-list').insertAdjacentHTML('beforeend','<section id="late-host"><div id="late-tonglan" class="adTonglan_wrap__late" style="display:grid!important"><a class="adTonglan_itemWrap__late"><div class="adTonglan_imgWrap__late"><img></div><div class="adTonglan_textWrap__late">延迟广告</div></a></div><a id="standalone-tonglan" class="adTonglan_itemWrap__late" style="display:flex!important">独立推广条</a><div id="late-normal">普通内容</div></section>');
    });
    await iqDisplay('late-tonglan','none');
    await iqDisplay('standalone-tonglan','none');
    for (const id of ['late-host','late-normal']) await iqDisplay(id,'block');
    assert.deepEqual(await iqFeed.locator('#late-tonglan').evaluate(el => [el.style.getPropertyValue('display'),el.style.getPropertyPriority('display')]), ['none','important']);
    assert.equal(await iqFeed.evaluate(() => window.tonglanClicks),0);
    await iqFeed.evaluate(() => window.tonglanStream.getTracks().forEach(track => track.stop()));
    await iqFeed.evaluate(() => {
      document.body.innerHTML = '<div class="compFuncs_simpleWrap__test"><div id="video-shell" style="display:flex!important"><a href="https://example.invalid/private?token=secret"><div id="video-ad" class="videoListAdVideo_container__test"><video muted></video><div>推广标题不应进入报告</div></div></a></div><div id="ordinary-video">普通推荐<video muted></video></div><div class="unrecognized-card"><span class="new-ad-label">广告</span><a href="https://example.invalid/private?token=secret">账号信息不应进入报告</a></div></div>';
      const canvas=document.createElement('canvas');
      canvas.getContext('2d').fillRect(0,0,16,16);
      window.videoTestStream=canvas.captureStream(10);
      document.querySelectorAll('video').forEach(v=>v.srcObject=window.videoTestStream);
    });
    await iqDisplay('video-shell','none');
    await iqDisplay('video-ad','none');
    await iqDisplay('ordinary-video','block');
    await iqFeed.evaluate(async () => {
      for(const v of document.querySelectorAll('video')) await v.play().catch(e=>{if(e.name!=='AbortError')throw e;});
    });
    await iqFeed.waitForFunction(()=>document.querySelector('#video-ad video').paused && !document.querySelector('#ordinary-video video').paused);
    passed('independent iQiyi video ad and its shell hide while normal preview plays');
    const feedTabId=await worker.evaluate(async()=> (await chrome.tabs.query({url:'https://www.iqiyi.com/clearplay-feed*'}))[0].id);
    const report=await worker.evaluate(id=>chrome.tabs.sendMessage(id,{type:'clearplay:diagnose'}),feedTabId);
    assert.equal(report.categories.length,6);
    assert.deepEqual(report.categories.find(c=>c.label==='独立视频广告'),{label:'独立视频广告',matched:1,rendered:0});
    assert.equal(report.diagnostics.candidateCount,1);
    assert.ok(JSON.stringify(report.diagnostics).includes('unrecognized-card'));
    for(const secret of ['example.invalid','secret','账号信息','推广标题']) assert.ok(!JSON.stringify(report).includes(secret));
    passed('six-category report identifies unknown visible markers without page text or URLs');
    await worker.evaluate(()=>chrome.storage.local.set({pauseAdsEnabled:false}));
    await iqDisplay('video-shell','flex');
    await iqDisplay('video-ad','block');
    await iqFeed.evaluate(()=>document.querySelector('#video-ad video').play());
    await worker.evaluate(()=>chrome.storage.local.set({pauseAdsEnabled:true}));
    await iqDisplay('video-shell','none');
    await iqFeed.waitForFunction(()=>document.querySelector('#video-ad video').paused);
    await iqFeed.evaluate(()=>document.querySelector('#video-ad').className='ordinary-video-component');
    await iqDisplay('video-shell','flex');
    await iqDisplay('video-ad','block');
    await iqFeed.evaluate(()=>window.videoTestStream.getTracks().forEach(t=>t.stop()));
    passed('independent video ads restore on disable and when repurposed for normal content');
    passed('late nested horizontal ads and standalone items hide despite inline important styles');
    await iqFeed.evaluate(() => {
      document.body.innerHTML = '<div id="focus"><a id="focus-ad" style="display:flex!important" href="https://example.invalid/play?order_plan_id=1&creative_id=2&impress_id=3"><div class="thumbnail_thumbnailItemWrap__fixture">推广</div></a><a id="focus-game" href="https://ads.game.iqiyi.com/nt/test.html"><div class="thumbnail_thumbnailItemWrap__fixture">游戏推广</div></a><a id="focus-normal" href="https://www.iqiyi.com/v_test.html"><div class="thumbnail_thumbnailItemWrap__fixture">传奇电视剧</div></a><a id="outside" href="https://ads.game.iqiyi.com/nt/test.html">游戏导航</a><a id="lookalike" href="https://ads.game.iqiyi.com.example.invalid/"><div class="thumbnail_thumbnailItemWrap__fixture">普通卡片</div></a></div>';
      window.focusClicks=0;
      document.body.onclick=()=>window.focusClicks++;
    });
    for (const id of ['focus-ad','focus-game']) await iqDisplay(id,'none');
    for (const id of ['focus-normal','outside','lookalike']) assert.notEqual(await iqFeed.locator('#'+id).evaluate(e=>getComputedStyle(e).display),'none');
    passed('focus ads hide by verified campaign links while programmes, navigation and lookalike hosts remain');
    await iqFeed.evaluate(()=>document.querySelector('#focus-ad').href='https://www.iqiyi.com/v_normal.html');
    await iqDisplay('focus-ad','flex');
    await iqFeed.evaluate(()=>document.querySelector('#focus-normal').href='https://ads.game.iqiyi.com/nt/new.html');
    await iqDisplay('focus-normal','none');
    assert.equal(await iqFeed.evaluate(()=>window.focusClicks),0);
    passed('focus thumbnail href reuse restores normal programmes and catches delayed ad links without clicks');
    await worker.evaluate(()=>chrome.storage.local.set({pauseAdsEnabled:false}));
    await iqDisplay('focus-game','inline');
    await worker.evaluate(()=>chrome.storage.local.set({pauseAdsEnabled:true}));
    await iqDisplay('focus-game','none');
    passed('focus thumbnail filtering follows the stored switch');
    await iqFeed.close();
    passed('iQiyi late feed markers and navigation require no popup');
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("https://v.qq.com/clearplay-test");
    const waitDisplay = (target, id, value) => target.waitForFunction(
      ({ id, value }) => getComputedStyle(document.getElementById(id)).display === value,
      { id, value }, { timeout: 10000 });
    const display = id => page.locator("#" + id).evaluate(el => getComputedStyle(el).display);
    await waitDisplay(page, "pause-ad", "none");
    passed("actual extension hides pause ad even with inline important style");
    for (const id of ["main-video", "controls", "other-ad", "recommendation"]) {
      assert.notEqual(await display(id), "none");
    }
    assert.equal(await page.locator("#main-video").evaluate(el => el.paused), true);
    passed("video stays paused; controls, subtitles and unrelated content remain");
    await page.evaluate(() => {
      const el = document.createElement("div");
      el.id = "dynamic-ad";
      el.className = "txp_ad";
      el.dataset.role = "txpad-interact-pause";
      document.getElementById("player").append(el);
    });
    assert.equal(await display("dynamic-ad"), "none");
    passed("dynamically inserted ad is hidden without polling");
    await page.evaluate(() => {
      document.getElementById("dynamic-ad").dataset.role = "txpad-interact-pre";
    });
    assert.notEqual(await display("dynamic-ad"), "none");
    passed("reused container is restored when its role changes");
    await page.evaluate(() => {
      for (const media of ["video", "audio"]) {
        const el = document.createElement("div");
        el.id = media + "-ad";
        el.className = "txp_ad";
        el.dataset.role = "txpad-interact-pause";
        el.append(document.createElement(media));
        document.getElementById("player").append(el);
      }
    });
    assert.equal(await display("video-ad"), "none");
    assert.equal(await display("audio-ad"), "none");
    passed("legacy pause containers with video and audio are hidden");

    await page.evaluate(() => {
      document.getElementById("video-ad").remove();
      document.getElementById("audio-ad").remove();
      const ad = document.createElement("div");
      ad.id = "new-pause-ad";
      ad.className = "txp_zt";
      ad.dataset.role = "creative-player-pause-container";
      ad.innerHTML = '<div data-role="creative-player-pause-mask">mask</div><div data-role="creative-player-pause-content"><video id="ad-movie" muted></video><span data-role="creative-player-pause-close">广告 ×</span></div>';
      document.getElementById("player").append(ad);
      const canvas = document.createElement("canvas");
      canvas.getContext("2d").fillRect(0, 0, 16, 16);
      window.testStream = canvas.captureStream(10);
      for (const id of ["main-video", "ad-movie"]) {
        const media = document.getElementById(id);
        media.srcObject = window.testStream;
        media.muted = true;
        media.addEventListener("play", () => {
          media.dataset.playCount = String(Number(media.dataset.playCount || 0) + 1);
        });
      }
    });
    await waitDisplay(page, "new-pause-ad", "none");
    passed("current Tencent txp_zt pause container, including mask and video, is hidden");
    await page.evaluate(() => {
      const split = document.createElement("div");
      split.id = "split-screen-ad";
      split.className = "split-screen-pause";
      split.innerHTML = '<div class="split-screen-pause-video-area">正片暂停画面</div><div class="split-screen-pause-ad-area">分屏广告</div><button class="split-screen-pause-close-button">关闭广告</button>';
      document.getElementById("player").append(split);
      window.splitCloseClicks = 0;
      setTimeout(() => {
        split.querySelector(".split-screen-pause-close-button").onclick = () => {
          window.splitCloseClicks++;
          document.getElementById("main-video").dataset.layout = "restored";
          split.remove();
        };
      }, 150);
    });
    await waitDisplay(page, "split-screen-ad", "none");
    await page.waitForFunction(() => document.getElementById("main-video").dataset.layout === "restored");
    assert.equal(await page.evaluate(() => window.splitCloseClicks), 1);
    assert.equal(await page.locator("#main-video").evaluate(el => el.paused), true);
    passed("Tencent split-screen pause ad is hidden immediately and its native close restores the paused layout");
    // Families confirmed in Tencent's 4.4.2 template renderer, including the
    // QR code + small main picture + large right-hand video layout in the report.
    for (const family of ["txp_full_screen_pause-active", "txp_full_screen_pause", "txp_full_screen_pause-bg", "txp_full_screen_pause-bg-v2", "wide-screen-pause"]) {
      await page.evaluate(family => {
        const root = document.createElement("div"); root.id = "full-ad"; root.className = family;
        const wide = family === "wide-screen-pause";
        root.innerHTML = '<div class="txp_full_screen_pause-active-player"><video id="main-preview" muted></video></div><div class="' + (wide ? 'wide-screen-pause-video-container' : 'txp_full_screen_pause-material-container') + '"><video id="full-ad-media" muted></video></div><button class="' + (wide ? 'wide-screen-pause-close' : 'txp_full_screen_pause-close') + '">关闭广告</button><button class="advert-action">立即购买</button>';
        window.allowFullClose = false; window.fullCloseClicks = 0; window.wrongAdClicks = 0;
        root.querySelector(".advert-action").onclick = () => window.wrongAdClicks++;
        root.querySelector(wide ? ".wide-screen-pause-close" : ".txp_full_screen_pause-close").onclick = () => {
          if (!window.allowFullClose) return;
          window.fullCloseClicks++;
          const preview = document.getElementById("main-preview");
          document.getElementById("player").append(preview);
          preview.dataset.layout = "restored";
          root.remove();
        };
        document.getElementById("player").append(root);
        for (const id of ["main-preview", "full-ad-media"]) {
          const v = document.getElementById(id); v.srcObject = window.testStream; v.muted = true;
          v.addEventListener("play", () => v.dataset.attempted = "yes");
        }
      }, family);
      await waitDisplay(page, "full-ad", "none");
      await page.evaluate(async () => {
        await document.getElementById("main-preview").play();
        await document.getElementById("full-ad-media").play().catch(() => {});
      });
      await page.waitForFunction(() => document.getElementById("full-ad-media").dataset.attempted === "yes" && document.getElementById("full-ad-media").paused);
      assert.equal(await page.locator("#main-preview").evaluate(v => v.paused), false);
      await page.evaluate(() => { document.getElementById("main-preview").pause(); window.allowFullClose = true; });
      await page.waitForFunction(() => document.getElementById("main-preview").dataset.layout === "restored");
      assert.equal(await page.locator("#main-preview").evaluate(v => v.paused), true);
      assert.equal(await page.evaluate(() => window.wrongAdClicks), 0);
      assert.equal(await page.evaluate(() => window.fullCloseClicks), 1);
      await page.locator("#main-preview").evaluate(v => v.remove());
      passed("Tencent " + family + " hides, stops only ad media and restores paused main picture via native close");
    }
    await page.evaluate(() => {
      const root = document.createElement("div"); root.id = "reused-full-ad"; root.className = "txp_full_screen_pause-active txp_none";
      root.innerHTML = '<button class="txp_full_screen_pause-close">关闭广告</button>';
      window.reusedCloses = 0;
      root.querySelector("button").onclick = () => { window.reusedCloses++; root.classList.add("txp_none"); };
      document.getElementById("player").append(root);
    });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.reusedCloses), 0);
    for (let n = 1; n <= 2; n++) {
      await page.locator("#reused-full-ad").evaluate(root => root.classList.remove("txp_none"));
      await page.waitForFunction(n => window.reusedCloses === n, n);
    }
    await page.locator("#reused-full-ad").evaluate(root => root.remove());
    passed("preloaded Tencent full-screen ad waits for activation and a reused container closes again");
    await page.evaluate(async () => {
      await document.getElementById("main-video").play();
      await document.getElementById("ad-movie").play().catch(() => {});
    });
    await page.waitForFunction(() => {
      const ad = document.getElementById("ad-movie");
      return Number(ad.dataset.playCount) >= 1 && ad.paused;
    });
    assert.equal(await page.locator("#main-video").evaluate(el => el.paused), false);
    passed("real ad media is stopped while main video playback continues");
    await page.evaluate(() => document.getElementById("ad-movie").play().catch(() => {}));
    await page.waitForFunction(() => {
      const ad = document.getElementById("ad-movie");
      return Number(ad.dataset.playCount) >= 2 && ad.paused;
    });
    passed("ad autoplay retries cannot keep hidden media playing");
    await worker.evaluate(() => chrome.storage.local.set({ pauseAdsEnabled: false }));
    await waitDisplay(page, "new-pause-ad", "block");
    await page.evaluate(() => document.getElementById("ad-movie").play());
    assert.equal(await page.locator("#ad-movie").evaluate(el => el.paused), false);
    passed("turning off restores new container and permits ad playback");
    await worker.evaluate(() => chrome.storage.local.set({ pauseAdsEnabled: true }));
    await waitDisplay(page, "new-pause-ad", "none");
    await page.waitForFunction(() => document.getElementById("ad-movie").paused);
    assert.equal(await page.locator("#main-video").evaluate(el => el.paused), false);
    passed("turning on stops an already-playing ad without pausing main video");
    await page.evaluate(async () => {
      const moved = document.createElement("video");
      moved.id = "moved-ad";
      moved.muted = true;
      moved.srcObject = window.testStream;
      document.getElementById("player").append(moved);
      await moved.play();
      window.wasPlayingBeforeMove = !moved.paused;
      document.getElementById("new-pause-ad").append(moved);
    });
    assert.equal(await page.evaluate(() => window.wasPlayingBeforeMove), true);
    await page.waitForFunction(() => document.getElementById("moved-ad").paused);
    passed("already-playing media moved into pause ad is stopped");
    await page.evaluate(() => {
      document.getElementById("new-pause-ad").remove();
      document.getElementById("main-video").pause();
      window.testStream.getTracks().forEach(track => track.stop());
    });

    const status = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "https://v.qq.com/clearplay-test" });
      return chrome.tabs.sendMessage(tab.id, { type: "clearplay:status" });
    });
    assert.equal(status.matched, 1);
    assert.equal(status.enabled, true);
    assert.equal(status.ready, true);
    passed("real extension messaging reports style readiness and eligible containers");

    const second = await context.newPage();
    await second.goto("https://v.qq.com/second-test");
    await waitDisplay(second, "pause-ad", "none");
    const popup = await context.newPage();
    popup.on("pageerror", error => errors.push(error.message));
    await popup.setViewportSize({ width: 360, height: 460 });
    await popup.goto("chrome-extension://" + extensionId + "/popup.html");
    await popup.waitForFunction(() => !document.getElementById("pause-ads").disabled);
    const initialTabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: "https://v.qq.com/clearplay-test" }))[0].id);
    await worker.evaluate(id => chrome.tabs.update(id, { active: true }), initialTabId);
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("status").textContent.includes("已连接"));
    assert.equal(await popup.locator("#pause-ads").isChecked(), true);
    await popup.locator("#pause-ads").uncheck();
    await popup.waitForFunction(() => document.getElementById("status").textContent.includes("已关闭"));
    await waitDisplay(page, "pause-ad", "block");
    await waitDisplay(second, "pause-ad", "block");
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get()).pauseAdsEnabled), false);
    passed("popup saves off setting and restores inline styles across existing tabs");
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.clearplayPauseAds === "off");
    assert.equal(await display("pause-ad"), "block");
    passed("saved off setting survives navigation");
    await popup.reload();
    await popup.waitForFunction(() => !document.getElementById("pause-ads").disabled);
    assert.equal(await popup.locator("#pause-ads").isChecked(), false);
    passed("popup reload preserves saved setting");
    await popup.locator("#pause-ads").check();
    await waitDisplay(page, "pause-ad", "none");
    await waitDisplay(second, "pause-ad", "none");
    passed("popup re-enables hiding in all matching tabs");
    const offsite = await context.newPage();
    await offsite.route("https://example.com/**", route => route.fulfill({
      contentType: "text/html", body: fixture
    }));
    await offsite.goto("https://example.com/");
    assert.equal(await offsite.locator("html").getAttribute("data-clearplay-pause-ads"), null);
    assert.equal(await offsite.locator("#pause-ad").evaluate(el => getComputedStyle(el).display), "block");
    passed("unrelated sites receive no script or hiding");

    // Test the real popup against a known active target tab in headless mode.
    const tabId = await worker.evaluate(async () =>
      (await chrome.tabs.query({ url: "https://v.qq.com/clearplay-test" }))[0].id);
    await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("status").textContent.includes("1 个"));

    // Simulate the missing receiver that occurs on already-open tabs.
    await worker.evaluate(async id => {
      await chrome.scripting.executeScript({ target: { tabId: id }, func: () => globalThis.__clearplayV17.dispose() });
    }, tabId);
    await waitDisplay(page, "pause-ad", "block");
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("status").textContent.includes("已连接"));
    await waitDisplay(page, "pause-ad", "none");
    passed("popup reconnects a missing receiver without refreshing the video page");
    await popup.locator("#repair").click();
    await popup.waitForFunction(() => !document.getElementById("repair").disabled);
    await waitDisplay(page, "pause-ad", "none");
    passed("repeated repair is idempotent");

    const iq = await context.newPage();
    await iq.route("https://www.iqiyi.com/**", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<!doctype html><html><body><div class="iqp-player"><video id="iq-main"></video><button id="iq-controls">暂停</button><div id="iq-normal" class="common-pause ad-clickable"><img class="pause-img"></div><div id="iq-max" class="flash-max1"><div class="pause-main maxPauseAd-container"><video id="iq-ad" data-player-hook="pausead-videolayer"></video></div></div><div id="iq-unrelated" class="common-overlay">其他推广</div></div><div id="iq-outside" class="common-pause ad-clickable">外部同名内容</div><div id="iq-tencent" data-role="creative-player-pause-container">其他标识</div></body></html>'
    }));
    await iq.goto("https://www.iqiyi.com/v_clearplay.html");
    await waitDisplay(iq, "iq-normal", "none");
    await waitDisplay(iq, "iq-max", "none");
    for (const id of ["iq-main", "iq-controls", "iq-unrelated", "iq-outside", "iq-tencent"]) {
      assert.notEqual(await iq.locator("#" + id).evaluate(el => getComputedStyle(el).display), "none");
    }
    passed("iQiyi normal and max pause ads hide while controls and unrelated elements remain");
    await iq.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.getContext("2d").fillRect(0, 0, 16, 16);
      window.iqStream = canvas.captureStream(10);
      const main = document.getElementById("iq-main"), ad = document.getElementById("iq-ad");
      for (const v of [main, ad]) { v.srcObject = window.iqStream; v.muted = true; }
      await main.play();
      ad.addEventListener("play", () => { ad.dataset.attempted = "yes"; });
      await ad.play().catch(() => {});
    });
    await iq.waitForFunction(() => {
      const ad = document.getElementById("iq-ad");
      return ad.dataset.attempted === "yes" && ad.paused;
    });
    assert.equal(await iq.locator("#iq-main").evaluate(el => el.paused), false);
    passed("iQiyi hidden ad media stops without interrupting main media");

    // The real max close handler is unavailable during its entrance animation.
    await iq.evaluate(() => {
      document.getElementById("iq-main").pause();
      window.closeAttempts = 0; window.wrongClicks = 0;
      const c = document.createElement("div");
      c.className = "flash-max1"; c.id = "iq-close-test";
      c.innerHTML = '<button class="pause-max-close-btn">关闭广告</button><button class="pause-max-play-btn">继续播放</button>';
      c.querySelector(".pause-max-play-btn").onclick = () => window.wrongClicks++;
      c.querySelector(".pause-max-close-btn").onclick = () => {
        window.closeAttempts++;
        if (window.closeAttempts >= 2) { c.remove(); document.getElementById("iq-main").dataset.layout = "restored"; }
      };
      document.querySelector(".iqp-player").append(c);
    });
    await iq.waitForFunction(() => document.getElementById("iq-main").dataset.layout === "restored");
    assert.equal(await iq.evaluate(() => window.wrongClicks), 0);
    assert.equal(await iq.locator("#iq-main").evaluate(el => el.paused), true);
    passed("native max-ad close retries during animation and preserves main pause");
    await iq.evaluate(() => {
      const c = document.createElement("div"); c.className = "common-pause ad-clickable"; c.id = "iq-close-normal";
      c.innerHTML = '<button class="pause-close">关闭</button>';
      c.querySelector("button").onclick = () => c.remove();
      document.querySelector(".iqp-player").append(c);
    });
    await iq.waitForFunction(() => !document.getElementById("iq-close-normal"));
    passed("native ordinary pause close handles dynamically added ads");

    await worker.evaluate(() => chrome.storage.local.set({ pauseAdsEnabled: false }));
    await waitDisplay(iq, "iq-normal", "block");
    await waitDisplay(iq, "iq-max", "block");
    await waitDisplay(page, "pause-ad", "block");
    await iq.evaluate(() => document.getElementById("iq-ad").play());
    assert.equal(await iq.locator("#iq-ad").evaluate(el => el.paused), false);
    passed("off switch restores fallback containers and permits media on both sites");
    await worker.evaluate(() => chrome.storage.local.set({ pauseAdsEnabled: true }));
    await waitDisplay(iq, "iq-normal", "none");
    await iq.waitForFunction(() => document.getElementById("iq-ad").paused);
    await waitDisplay(page, "pause-ad", "none");
    await iq.evaluate(() => window.iqStream.getTracks().forEach(t => t.stop()));
    passed("on switch re-enables Tencent and iQiyi together");

    const iqTab = await worker.evaluate(async () => (await chrome.tabs.query({ url: "https://www.iqiyi.com/v_clearplay.html" }))[0].id);
    await worker.evaluate(id => chrome.tabs.update(id, { active: true }), iqTab);
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("status").textContent.includes("2 个"));
    passed("popup connects and reports iQiyi containers");

    await offsite.bringToFront();

    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("status").textContent.includes("未连接"));
    assert.ok((await popup.locator("#diagnostic").innerText()).includes("腾讯视频或爱奇艺"));
    passed("unsupported pages show connection failure rather than a false active claim");
    await worker.evaluate(id => chrome.tabs.update(id, { active: true }), iqTab);
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById("status").textContent.includes("2 个"));

    assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    const output = path.join(root, "test-results");
    fs.mkdirSync(output, { recursive: true });
    await popup.screenshot({ path: path.join(output, "popup.png") });
    passed("popup shows matched count without overflow or uncaught errors");
    await popup.locator('summary').click();
    await popup.locator('#copy-report').click();
    await popup.waitForFunction(()=>document.getElementById('report').value.includes('extensionVersion'));
    const popupReport=JSON.parse(await popup.locator('#report').inputValue());
    assert.equal(popupReport.version, manifest.version);
    assert.equal(popupReport.categories.length,6);
    assert.ok(await popup.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    passed('popup exposes a copyable diagnostic report and per-category counts');
    const mismatch = await context.newPage();
    await mismatch.addInitScript(() => {
      const original = chrome.runtime.getManifest.bind(chrome.runtime);
      chrome.runtime.getManifest=()=>({...original(),version:'0.10.0'});
    });
    await mismatch.goto(`chrome-extension://${extensionId}/popup.html`);
    await mismatch.waitForFunction(()=>document.getElementById('version-warning').textContent.includes('版本未同步'));
    assert.equal(await mismatch.locator('.version').textContent(),'v0.10.0');
    await mismatch.close();
    passed('popup shows registered extension version and warns when on-disk scripts are newer');
    console.log("\n" + count + " checks passed using a loaded extension with real APIs. Tencent responses are local fixtures.");
  } finally {
    await context.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
