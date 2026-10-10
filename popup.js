(() => {
  "use strict";
  const toggle = document.getElementById("pause-ads");
  const status = document.getElementById("status");
  const repair = document.getElementById("repair");
  const detail = document.getElementById("diagnostic");
  const key = "pauseAdsEnabled";
  const registeredVersion = chrome.runtime.getManifest().version;
  const codeVersion = '0.17.0';
  document.querySelector('.version').textContent = 'v' + registeredVersion;
  document.getElementById('version-warning').textContent = registeredVersion === codeVersion ? ''
    : `版本未同步：浏览器登记 ${registeredVersion}，当前文件 ${codeVersion}。请到扩展管理页点击净映的“重新加载”，然后刷新网页。`;
  let saved = true;
  const authorize = document.getElementById("authorize");
  const permissionStatus = document.getElementById("permission-status");
  const origins = ["https://v.qq.com/*", "https://www.iqiyi.com/*", "https://iqiyi.com/*"];
  async function showPermissions() {
    const allowed = await chrome.permissions.contains({ origins });
    authorize.hidden = allowed;
    permissionStatus.textContent = allowed ? "已获得两站访问权限。" : "缺少持续站点授权，自动拦截无法运行。请点击上方按钮授权。";
  }
  authorize.addEventListener("click", async () => {
    try {
      const allowed = await chrome.permissions.request({ origins });
      await showPermissions();
      if (allowed) { await refreshStatus(); permissionStatus.textContent = "授权成功；请刷新已打开的播放页，新页面将自动生效。"; }
    } catch (error) { permissionStatus.textContent = error.message; }
  });
  showPermissions().catch(error => { permissionStatus.textContent = error.message; });

  async function connect() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(v\.qq\.com|www\.iqiyi\.com|iqiyi\.com)\//.test(tab.url || "")) {
      throw new Error("请在腾讯视频或爱奇艺播放页点击扩展；若当前已是该页面，请在扩展详情中允许访问腾讯视频或爱奇艺。");
    }
    const target = { tabId: tab.id, frameIds: [0] };
    // Reinject on toolbar activation: existing tabs may have no live receiver
    // after installation, an extension reload, or a withheld host grant.
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target, files: ["content.css"], origin: "USER" });
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "clearplay:sync:v17", styleInstalled: true, enabled: saved
    }, { frameId: 0 });
    if (result?.version !== "0.17.0") throw new Error("页面未返回新版脚本状态，请刷新播放页后重试。");
    return result;
  }

  async function refreshStatus() {
    repair.disabled = true;
    detail.textContent = "";
    status.textContent = "正在连接当前播放页…";
    try {
      const result = await connect();
      detail.textContent = `页面脚本：${result.version}；样式：${result.ready ? "就绪" : "未就绪"}；匹配：${result.matched}；已隐藏：${result.hidden}；视频元素：${result.videos}`;
      document.getElementById('categories').textContent = (result.categories || []).map(c => `${c.label}：匹配 ${c.matched}，仍显示 ${c.rendered}`).join('\n');
      status.textContent = !result.enabled
        ? "已连接，隐藏功能已关闭。"
        : result.matched > 0
          ? `已连接，匹配到 ${result.matched} 个广告容器，已隐藏 ${result.hidden} 个。`
          : "已连接，暂未匹配到支持过滤的广告。如果广告仍可见，请将下面的诊断信息反馈给开发者。";
    } catch (error) {
      document.getElementById('categories').textContent = '';
      status.textContent = "未连接到播放页，广告处理尚未生效。请点击下方按钮重试。";
      detail.textContent = error?.message || String(error);
    } finally {
      repair.disabled = false;
    }
  }

  repair.addEventListener("click", refreshStatus);
  document.getElementById('copy-report').addEventListener('click', async () => {
    const output = document.getElementById('report');
    output.hidden = false;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'clearplay:diagnose' }, { frameId: 0 });
      output.value = JSON.stringify({ extensionVersion: chrome.runtime.getManifest().version, ...result }, null, 2);
      try { await navigator.clipboard.writeText(output.value); }
      catch { output.focus(); output.select(); }
    } catch (error) { output.value = `无法读取页面诊断：${error.message}`; }
  });
  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      await chrome.storage.local.set({ [key]: toggle.checked });
      saved = toggle.checked;
      await refreshStatus();
    } catch (error) {
      toggle.checked = saved;
      status.textContent = "设置保存失败。";
      detail.textContent = error?.message || String(error);
    } finally {
      toggle.disabled = false;
    }
  });
  chrome.storage.local.get({ [key]: true }).then(async settings => {
    saved = settings[key] !== false;
    toggle.checked = saved;
    toggle.disabled = false;
    await refreshStatus();
  }).catch(error => {
    status.textContent = "无法读取设置。";
    detail.textContent = error?.message || String(error);
  });
})();
