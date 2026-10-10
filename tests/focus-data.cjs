
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(__dirname,'..');
(async()=>{
 const context = await chromium.launchPersistentContext('',{headless:true,executablePath:process.env.CLEARPLAY_BROWSER_PATH,args:['--disable-extensions-except='+root,'--load-extension='+root]});
 try {
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const endpoint='https://pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getPage';
 const data={data:{CardList:[{type:'pc_carousel',children_list:{list:{cards:[{id:'normal-one'},{id:'normal-two'}]},ad_list:{cards:[{id:'game-ad'}]}}},{type:'other',children_list:{ad_list:{cards:[{id:'unrelated'}]}}}]}};
 await context.route('https://pbaccess.video.qq.com/**',r=>r.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(data)}));
 await context.route('https://v.qq.com/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><script>window.result=fetch('+JSON.stringify(endpoint)+').then(r=>r.json());</script>'}));
 async function toggle(enabled){await worker.evaluate(enabled=>chrome.storage.local.set({pauseAdsEnabled:enabled}),enabled);for(let i=0;i<100;i++){const n=await worker.evaluate(async()=> (await chrome.scripting.getRegisteredContentScripts({ids:['clearplay-tencent-focus']})).length);if(n===(enabled?1:0))return;await new Promise(r=>setTimeout(r,30))}throw Error('registration timeout')}
 await toggle(true);
 const page=await context.newPage();
 for(let i=0;i<2;i++){
 await page.goto('https://v.qq.com/focus-fixture');
 const result=await page.evaluate(()=>window.result);
 assert.equal(result.data.CardList[0].children_list.ad_list.cards.length,0);
 assert.deepEqual(result.data.CardList[0].children_list.list.cards,data.data.CardList[0].children_list.list.cards);
 assert.equal(result.data.CardList[1].children_list.ad_list.cards.length,1);
 }
 console.log('PASS earliest inline fetch consumer and refresh receive no carousel ads; normal order and other modules preserved');
 for(const type of ['', 'json']){
 const result=await page.evaluate(({url,type})=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET',url);x.responseType=type;x.onload=()=>resolve(type==='json'?x.response:JSON.parse(x.responseText));x.onerror=reject;x.send()}),{url:endpoint,type});
 assert.equal(result.data.CardList[0].children_list.ad_list.cards.length,0);
 }
 const clone=await page.evaluate(async url=>{const r=await fetch(url);return {url:r.url,status:r.status,text:await r.clone().text(),json:await r.json()}},endpoint);
 assert.equal(clone.url,endpoint);assert.equal(clone.status,200);assert.equal(JSON.parse(clone.text).data.CardList[0].children_list.ad_list.cards.length,0);
 console.log('PASS XHR text/json, fetch clones and response metadata');
 await toggle(false);await page.goto('https://v.qq.com/focus-fixture');
 assert.equal((await page.evaluate(()=>window.result)).data.CardList[0].children_list.ad_list.cards.length,1);
 await toggle(true);await page.goto('https://v.qq.com/focus-fixture');
 assert.equal((await page.evaluate(()=>window.result)).data.CardList[0].children_list.ad_list.cards.length,0);
 console.log('PASS saved off/on settings determine pre-render filtering after navigation');
 }finally{await context.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
