(() => {
  'use strict';
  if (location.hostname !== 'v.qq.com' || globalThis.__clearplayFocusData) return;
  const stats = {responses:0, removed:0};
  globalThis.__clearplayFocusData = stats;
  const active = () => document.documentElement?.getAttribute('data-clearplay-pause-ads') !== 'off';
  const eligible = value => {
    try { const u = new URL(value, location.href); return u.protocol === 'https:' && ['pbaccess.video.qq.com','tpbaccess.video.qq.com'].includes(u.hostname) && u.pathname === '/trpc.vector_layout.page_view.PageService/getPage'; } catch { return false; }
  };
  function clean(value) {
    if (!value || typeof value !== 'object') return;
    // Verified raw module used by Tencent's parseFocusModule. Leave list.cards intact.
    if (value.type === 'pc_carousel' && Array.isArray(value.children_list?.ad_list?.cards)) { stats.removed += value.children_list.ad_list.cards.length; value.children_list.ad_list.cards = []; }
    for (const child of Object.values(value)) if (child && typeof child === 'object') clean(child);
  }
  function filterText(text) {
    if (!active() || typeof text !== 'string' || !text.includes('pc_carousel') || !text.includes('ad_list')) return text;
    try { const value = JSON.parse(text); clean(value); stats.responses++; return JSON.stringify(value); } catch { return text; }
  }
  const originalFetch = window.fetch;
  function wrapResponse(response) {
    if (!eligible(response.url)) return response;
    return new Proxy(response, { get(target, key) {
      if (key === 'text') return async () => filterText(await target.text());
      if (key === 'json') return async () => JSON.parse(filterText(await target.text()));
      if (key === 'clone') return () => wrapResponse(target.clone());
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
  }
  window.fetch = async function(...args) { return wrapResponse(await Reflect.apply(originalFetch, this, args)); };
  for (const key of ['responseText','response']) {
    const descriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, key);
    if (!descriptor?.get || !descriptor.configurable) continue;
    Object.defineProperty(XMLHttpRequest.prototype, key, {...descriptor, get() {
      const value = descriptor.get.call(this);
      if (!active() || !eligible(this.responseURL) || this.readyState !== 4) return value;
      if (typeof value === 'string') return filterText(value);
      if (key === 'response' && this.responseType === 'json' && value) {
        try { return JSON.parse(filterText(JSON.stringify(value))); } catch { return value; }
      }
      return value;
    }});
  }
})();
