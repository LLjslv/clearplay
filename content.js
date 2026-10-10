(() => {
  "use strict";
  if (globalThis.__clearplayV17) return;
  globalThis.__clearplayV16?.dispose();
  globalThis.__clearplayV15?.dispose();
  globalThis.__clearplayV14?.dispose();
  globalThis.__clearplayV13?.dispose();
  globalThis.__clearplayV12?.dispose();
  const site = location.hostname === "v.qq.com" ? "tencent"
    : ["www.iqiyi.com", "iqiyi.com"].includes(location.hostname) ? "iqiyi" : null;
  if (!site) return;
  const key = "pauseAdsEnabled";
  const attribute = "data-clearplay-pause-ads";
  const fullScreenSelector = '.txp_full_screen_pause, .txp_full_screen_pause-active, .txp_full_screen_pause-bg, .txp_full_screen_pause-bg-v2';
  const layoutSelector = `${fullScreenSelector}, .split-screen-pause, .wide-screen-pause`;
  // Focus thumbnails share the normal programme layout. Require an actual ad
  // campaign link or the verified game-ad host, never a game title keyword.
  const focusGameSelector = 'a:is([href*="order_plan_id="][href*="creative_id="][href*="impress_id="], [href^="https://ads.game.iqiyi.com/"], [href^="//ads.game.iqiyi.com/"]):has(> [class*="thumbnail_thumbnailItemWrap__"])';
  const feedGroups = site === "tencent" ? [
    ['推荐广告', '.video-card-wrap.flow-card--web:has(> .ad-flag[title="关闭广告"])']
  ] : [
    ['普通广告卡片', '[class*="filmFeed_filmFeed__"]:has([class*="filmFeed_adBadge__"])'],
    ['游戏推广', `[class*="filmFeed_filmFeed__"]:has([class*="filmFeed_gameBtn__"]), ${focusGameSelector}`],
    ['图片广告', '[class*="videoListAdPic_container__"]'],
    ['独立视频广告', '[class*="videoListAdVideo_container__"]'],
    ['横排小卡片', '[class*="adTheater_container__"]'],
    ['图文横条', '[class*="adTonglan_wrap__"], [class*="adTonglan_itemWrap__"], [class*="videoListItem_imageTitleInRow__"]:has(img[data-ai-entity="广告配图"])']
  ];
  const feedSelector = feedGroups.map(([, rule]) => rule).join(', ') + (site === "iqiyi"
    ? ', [class*="compFuncs_simpleWrap__"] > div:has(> a > [class*="videoListAdPic_container__"], > a > [class*="videoListAdVideo_container__"])' : '');
  const selector = site === "tencent"
    ? `[data-role="creative-player-pause-container"], .txp_ad[data-role="txpad-interact-pause"], ${layoutSelector}, ${feedSelector}`
    : `.iqp-player .common-pause.ad-clickable, .iqp-player .flash-max1, ${feedSelector}`;
  let enabled = false, revision = 0, styleReady = true;
  let handled = new WeakSet();
  const timers = new Set();
  chrome.runtime.sendMessage({ type: "clearplay:install-style" })
    .then(result => { styleReady ||= result?.ok === true; }).catch(() => {});

  const hidden = new Map();
  function restore(container) {
    const saved = hidden.get(container);
    if (!saved) return;
    hidden.delete(container);
    if (container.style.getPropertyValue("display") === "none" && container.style.getPropertyPriority("display") === "important") {
      if (saved.value) container.style.setProperty("display", saved.value, saved.priority);
      else container.style.removeProperty("display");
    }
  }
  function hide(container) {
    if (!enabled || !container.matches(selector)) return;
    const value = container.style.getPropertyValue("display");
    const priority = container.style.getPropertyPriority("display");
    if (!hidden.has(container) || value !== "none" || priority !== "important") hidden.set(container, { value, priority });
    if (value !== "none" || priority !== "important") container.style.setProperty("display", "none", "important");
    if (container.matches(feedSelector)) container.querySelectorAll("video, audio").forEach(stopAdMedia);
    closeNativePauseAd(container);
  }
  // Collapse only wrappers whose entire content is already a confirmed feed ad.
  // Never remove/reparent React nodes or combine separate recommendation sections.
  const slots = new Map();
  function restoreSlot(el) {
    const saved = slots.get(el);
    if (!saved) return;
    slots.delete(el);
    if (el.style.getPropertyValue('display') === 'none' && el.style.getPropertyPriority('display') === 'important') {
      if (saved.value) el.style.setProperty('display', saved.value, saved.priority);
      else el.style.removeProperty('display');
    }
  }
  function compactFeed() {
    const desired = new Set();
    if (enabled && site === 'iqiyi') {
      const roots = document.querySelectorAll('[class*="compFuncs_simpleWrap__"], [class*="list_list__"]');
      for (const root of roots) {
        function adOnly(node) {
          if (node.nodeType === Node.TEXT_NODE) return !node.textContent.trim();
          if (!(node instanceof Element)) return true;
          if (node.matches(feedSelector)) return true;
          // Only structural wrappers; do not collapse headings, controls or media.
          if (!node.matches('div,a,section,li,ul') || !node.children.length) return false;
          return [...node.childNodes].every(adOnly);
        }
        for (const slot of root.children) {
          if (adOnly(slot)) desired.add(slot);
          else if (root.matches('[class*="list_list__"]')) {
            // This component has a row level followed by individual flex slots.
            for (const item of slot.children) if (adOnly(item)) desired.add(item);
          }
        }
      }
    }
    for (const el of slots.keys()) if (!desired.has(el) || !el.isConnected) restoreSlot(el);
    for (const el of desired) {
      // Existing ad containers are managed by the normal reversible hiding map.
      if (el.matches(feedSelector)) continue;
      const value = el.style.getPropertyValue('display');
      const priority = el.style.getPropertyPriority('display');
      if (!slots.has(el) || value !== 'none' || priority !== 'important') slots.set(el, {value, priority});
      if (value !== 'none' || priority !== 'important') el.style.setProperty('display','none','important');
    }
  }
  function repairRoot() {
    const root = document.documentElement;
    if (!root) return;
    if (root.getAttribute("data-clearplay-site") !== site) root.setAttribute("data-clearplay-site", site);
    const value = enabled ? "on" : "off";
    if (root.getAttribute(attribute) !== value) root.setAttribute(attribute, value);
  }
  function stopAdMedia(media) {
    if (!enabled || !(media instanceof HTMLMediaElement) || media.paused) return;
    const container = media.closest(selector);
    if (!container) return;
    // Tencent's layout-changing ads can surround the main picture. Only their
    // dedicated material area owns ad media; the main-video slot must be left alone.
    if (site === "tencent" && container.matches(layoutSelector)) {
      const material = media.closest('.txp_full_screen_pause-material-container, .split-screen-pause-media, .wide-screen-pause-video-container');
      if (!material || !container.contains(material)) return;
    }
    media.pause();
  }

  function closeNativePauseAd(container) {
    if (!enabled || handled.has(container) || container.matches(feedSelector)) return;
    if (site === "tencent" && !container.matches(layoutSelector)) return;
    if (container.classList.contains("txp_none")) return;
    handled.add(container);
    let attempts = 0;
    function attempt() {
      if (!enabled || !container.isConnected || !container.matches(selector) || container.classList.contains("txp_none")) {
        handled.delete(container);
        return;
      }
      // Native close handlers restore layouts that move or resize the main video.
      // Never click play masks, continue-play buttons, or advertising links.
      const button = site === "tencent"
        ? container.querySelector(container.matches(fullScreenSelector)
          ? ".txp_full_screen_pause-close"
          : container.matches(".wide-screen-pause") ? ".wide-screen-pause-close" : ".split-screen-pause-close-button")
        : container.querySelector(container.matches(".flash-max1")
          ? ".pause-max-close-btn" : ".pause-close");
      if (button) button.click();
      if (++attempts < 12 && container.isConnected) {
        const timer = setTimeout(() => { timers.delete(timer); attempt(); }, 250);
        timers.add(timer);
      } else handled.delete(container);
    }
    // Defer until the page has attached its handlers; retry while entrance animation runs.
    const timer = setTimeout(() => { timers.delete(timer); attempt(); }, 0);
    timers.add(timer);
  }

  // Tencent's verified carousel-only close component emits onClose, removing
  // the current ad via the site's own carousel state. Never click the poster/CTA.
  const carouselCloseSelector = '.video-focus .close-btn.close-btn-web[data-v-c9e412c6], .video-focus .close-btn.close-btn-web-mini[data-v-c9e412c6]';
  let carouselPending = new WeakSet();
  let carouselAttempts = new WeakMap();
  function closeCarouselAds() {
    if (!enabled || site !== 'tencent') return;
    for (const button of document.querySelectorAll(carouselCloseSelector)) {
      if (carouselPending.has(button) || (carouselAttempts.get(button) || 0) >= 12) continue;
      carouselPending.add(button);
      const timer = setTimeout(() => {
        timers.delete(timer); carouselPending.delete(button);
        if (!enabled || !button.isConnected || !button.matches(carouselCloseSelector) || !isRendered(button)) return;
        carouselAttempts.set(button, (carouselAttempts.get(button) || 0) + 1);
        button.click();
        closeCarouselAds();
      }, carouselAttempts.has(button) ? 250 : 0);
      timers.add(timer);
    }
  }
  function inspect(node) {
    if (!enabled) return;
    if (node instanceof HTMLMediaElement) stopAdMedia(node);
    if (node.querySelectorAll) node.querySelectorAll("video, audio").forEach(stopAdMedia);
    if (node instanceof Element) {
      // Nested ad items may arrive after their row. Apply the inline fallback to
      // every matching ad ancestor, including a row with author !important styles.
      for (let container = node.closest(selector); container; container = container.parentElement?.closest(selector)) hide(container);
    }
    if (node.querySelectorAll) node.querySelectorAll(selector).forEach(hide);
  }
  const onMediaPlay = event => stopAdMedia(event.target);
  const onMainPause = event => {
    if (enabled && event.target instanceof HTMLMediaElement && !event.target.closest(selector)) {
      timers.forEach(clearTimeout); timers.clear(); handled = new WeakSet();
      repairRoot(); inspect(document);
    }
  };
  document.addEventListener("play", onMediaPlay, true);
  document.addEventListener("playing", onMediaPlay, true);
  document.addEventListener("pause", onMainPause, true);
  const observer = new MutationObserver(records => {
    repairRoot();
    if (!enabled) return;
    for (const container of hidden.keys()) if (!container.isConnected || !container.matches(selector)) restore(container);
    for (const record of records) {
      if (record.type === "childList") record.addedNodes.forEach(inspect);
      else inspect(record.target);
    }
    compactFeed();
    closeCarouselAds();
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["data-role", "data-v-c9e412c6", "class", "title", "href", "data-ai-entity", "style", "data-clearplay-site", attribute] });
  function apply(value) {
    const next = value !== false;
    if (next && !enabled) { handled = new WeakSet(); carouselPending = new WeakSet(); carouselAttempts = new WeakMap(); }
    enabled = next;
    if (document.documentElement) {
      document.documentElement.setAttribute("data-clearplay-site", site);
      document.documentElement.setAttribute(attribute, enabled ? "on" : "off");
    }
    if (enabled) inspect(document);
    else { timers.forEach(clearTimeout); timers.clear(); for (const container of hidden.keys()) restore(container); }
    compactFeed();
    closeCarouselAds();
  }
  const onStorage = (changes, area) => {
    if (area === "local" && Object.hasOwn(changes, key)) { revision++; apply(changes[key].newValue); }
  };
  chrome.storage.onChanged.addListener(onStorage);
  const initialRevision = revision;
  chrome.storage.local.get({ [key]: true }).then(settings => {
    if (revision === initialRevision) apply(settings[key]);
  }).catch(() => { if (revision === initialRevision) apply(false); });
  const onReady = () => { repairRoot(); apply(enabled); };
  window.addEventListener("pageshow", onReady);
  document.addEventListener("DOMContentLoaded", onReady, { once: true });
  function isRendered(el) {
    if (!el.getClientRects().length) return false;
    for (let n = el; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    return true;
  }
  function feedStatus() {
    return feedGroups.map(([label, rule]) => {
      const elements = [...document.querySelectorAll(rule)];
      return { label, matched: elements.length, rendered: elements.filter(isRendered).length };
    });
  }
  function diagnose() {
    // Explicit user action only. Collect structural names, never links, page text,
    // cookies or account information. A candidate is evidence, not a hiding rule.
    const markers = [...document.querySelectorAll('div,span,a,button,img')].filter(el =>
      el.childElementCount === 0 && (/^(广告|开始游戏)$/.test(el.textContent.trim()) ||
        /(?:adBadge|adMark|adFlag|filmFeed_gameBtn)/i.test(el.className || '') ||
        el.matches('img[alt="ad"], img[src$="/ad.svg"], img[data-ai-entity="广告配图"]')) && isRendered(el));
    const ancestry = el => {
      const ancestors = [];
      for (let n = el; n && ancestors.length < 6; n = n.parentElement)
        ancestors.push({ tag: n.tagName, class: String(n.className || '').slice(0,200), matched: n.matches(selector) });
      return ancestors;
    };
    // Some ad badges are baked into images. Report wide image links as candidates
    // only; dimensions must never be used as an automatic filtering rule.
    const wideImageLinks = [...document.querySelectorAll('a')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.height >= 40 && r.height <= 250 && r.width > r.height * 3 && el.querySelector('img') && isRendered(el);
    }).slice(0,12).map(ancestry);
    return {
      candidates: markers.slice(0,30).map(ancestry),
      wideImageLinks,
      candidateCount: markers.length,
      iframeCount: document.querySelectorAll('iframe').length,
      openShadowRoots: [...document.querySelectorAll('*')].filter(el => el.shadowRoot).length
    };
  }
  const onMessage = (message, _sender, respond) => {
    if (!["clearplay:status", "clearplay:diagnose", "clearplay:sync:v17"].includes(message?.type)) return;
    if (message.type === "clearplay:sync:v17") {
      revision++;
      if (message.styleInstalled) styleReady = true;
      apply(message.enabled);
    }
    const containers = [...document.querySelectorAll(selector)];
    respond({
      version: "0.17.0", site, supported: true, ready: styleReady, enabled,
      matched: containers.length,
      hidden: containers.filter(el => getComputedStyle(el).display === "none").length,
      videos: document.querySelectorAll("video").length,
      categories: feedStatus(),
      ...(message.type === "clearplay:diagnose" ? { diagnostics: diagnose() } : {})
    });
  };
  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.__clearplayV17 = { dispose() {
    observer.disconnect(); timers.forEach(clearTimeout); timers.clear();
    for (const el of slots.keys()) restoreSlot(el);
    for (const container of hidden.keys()) restore(container);
    window.removeEventListener("pageshow", onReady);
    document.removeEventListener("pause", onMainPause, true);
    document.removeEventListener("play", onMediaPlay, true);
    document.removeEventListener("playing", onMediaPlay, true);
    document.removeEventListener("DOMContentLoaded", onReady);
    chrome.storage.onChanged.removeListener(onStorage);
    chrome.runtime.onMessage.removeListener(onMessage);
    document.documentElement?.removeAttribute(attribute);
    document.documentElement?.removeAttribute("data-clearplay-site");
    delete globalThis.__clearplayV17;
  }};
})();
