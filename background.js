"use strict";

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "clearplay:install-style") return;
  if (sender.id !== chrome.runtime.id || !sender.tab ||
      sender.frameId !== 0 || !sender.documentId ||
      !/^https:\/\/(v\.qq\.com|www\.iqiyi\.com|iqiyi\.com)\//.test(sender.url || "")) {
    respond({ ok: false });
    return;
  }
  // USER-origin important declarations also beat inline author !important.
  // Target the sending document so navigation cannot inject into a different page.
  chrome.scripting.insertCSS({
    target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
    files: ["content.css"],
    origin: "USER"
  }).then(() => respond({ ok: true }), () => respond({ ok: false }));
  return true;
});

// Persisted document_start registration runs before the site's request consumers.
let focusRegistration = Promise.resolve();
function syncFocusRegistration() {
  focusRegistration = focusRegistration.catch(() => {}).then(async () => {
    const settings = await chrome.storage.local.get({pauseAdsEnabled:true});
    const id = 'clearplay-tencent-focus';
    const scripts = await chrome.scripting.getRegisteredContentScripts({ids:[id]});
    if (settings.pauseAdsEnabled === false) {
      if (scripts.length) await chrome.scripting.unregisterContentScripts({ids:[id]});
    } else {
      const script = {id, matches:['https://v.qq.com/*'], js:['tencent-focus.js'], runAt:'document_start', world:'MAIN', persistAcrossSessions:true};
      if (scripts.length) await chrome.scripting.updateContentScripts([script]);
      else await chrome.scripting.registerContentScripts([script]);
    }
  });
  focusRegistration.catch(error => console.warn('ClearPlay focus registration failed', error));
}
syncFocusRegistration();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && Object.hasOwn(changes,'pauseAdsEnabled')) syncFocusRegistration(); });
chrome.runtime.onInstalled.addListener(syncFocusRegistration);
chrome.runtime.onStartup.addListener(syncFocusRegistration);
