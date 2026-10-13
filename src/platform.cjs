const fs = require('node:fs');
const path = require('node:path');
const { PLATFORMS } = require('./core.cjs');
const observerScript = require('./platform-observer.cjs');
const durationScript = require('./platform-duration.cjs');
const { installDurationTransport } = require('./platform-duration-transport.cjs');
const { videoInfo } = require('./media.cjs');
const { downloadFromButton } = require('./platform-download.cjs');
const { resumePlatformFile } = require('./platform-resume-download.cjs');
const { inspectVideoTiming } = require('./platform-video-timing.cjs');
const { COMPLETION_POLL_MS, inspectDolaCompletion } = require('./platform-completion.cjs');
const { CookieAccounts } = require('./account-cookies.cjs');
const doubaoQuota = require('./doubao-quota.cjs');
const { readPlatformQuota } = require('./platform-quota.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boundedRead(read, timeoutMs = 5000) {
  let timer;
  try { return await Promise.race([read(), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('后台页面核对超时，下次自动重试')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
function problem(code, message) { const e = new Error(message); e.code = code; return e; }
async function loadAccountPage(win, url, timeoutMs = 30000) {
  let timer, ready;
  const dom = new Promise(resolve => { ready = resolve; win.webContents.once('dom-ready', ready); });
  const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(problem('page_timeout', '平台页面加载超时，请稍后再次检测登录')), timeoutMs); });
  try { await Promise.race([dom, win.loadURL(url), deadline]); }
  finally { clearTimeout(timer); win.webContents.removeListener('dom-ready', ready); }
}
function pageProbe() {
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const editable = [...document.querySelectorAll('textarea,[contenteditable=true]')].filter(visible);
  const buttons = [...document.querySelectorAll('button,[role=button],[role=option],[role=menuitem],[role=radio],[role=tab],label')].filter(visible).map(el => ({ text: (el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '').trim().slice(0, 100), aria: el.getAttribute('aria-label'), title: el.title, testId: el.getAttribute('data-testid'), className: typeof el.className === 'string' ? el.className.slice(0, 200) : '', selected: el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true', disabled: !!el.disabled }));
  const inputs = [...document.querySelectorAll('input[type=file]')].map(el => ({ accept: el.accept, multiple: el.multiple, hint: (el.closest('label')?.innerText || el.closest('label')?.textContent || el.parentElement?.innerText || el.parentElement?.textContent || '').slice(0, 100) }));
  const login = buttons.some(b => /^(登录|立即登录|Log in|Sign in|Login)$/i.test(b.text));
  const mode = [...document.querySelectorAll('[data-testid=skill_input_exit_button],[data-testid=chat_input_action_mode]')].filter(visible).map(el => (el.innerText || el.textContent || '').trim()).find(Boolean);
  return { url: location.href, composer: editable.length > 0, login, buttons, inputs, mode, text: (document.body.innerText || document.body.textContent || '').slice(-18000) };
}
async function waitForComposer(wc,timeoutMs=45000) {
  const deadline=Date.now()+timeoutMs;
  do {const page=await wc.executeJavaScript(`(${pageProbe.toString()})()`);if(page.composer||page.login)return true;if(Date.now()>=deadline)return false;await sleep(500);}while(Date.now()<=deadline);
  return false;
}
function isVideoMode(probe) {
  return /^(视频生成|生成视频|AI\s*视频|Video generation|Generate video|Create video|AI video)$/i.test(probe.mode || '') || probe.buttons.some(b => b.selected && /^(视频生成|生成视频|Video generation|Generate video|Create video)$/i.test(b.text));
}
function generationStage(text) {
  if (/生成失败|视频制作失败|video generation failed/i.test(text)) return 'failed';
  if(/免费额度已用完/.test(text)&&/消耗付费额度/.test(text)&&/是否继续生成|确认生成/.test(text))return 'payment_confirmation';
  if (/额度不足|次数已用完|每日免费额度已用完|insufficient credits|quota exceeded/i.test(text)) return 'quota';
  const credits=/需要消耗\s*(\d+(?:\.\d+)?)\s*个视频生成额度[\s\S]{0,100}?剩余\s*(\d+(?:\.\d+)?)\s*个视频生成额度/.exec(text);
  if(credits && Number(credits[1])>Number(credits[2]) && /无法生成|不能生成/.test(text))return 'quota';
  if (/预计等待\s*\d+\s*分钟|视频生成中|正在生成视频|video is being generated/i.test(text)) return 'generating';
  if (/(?:确认后|确认[^。\n]{0,20}再|你回复|你选择|回复\s*[ABＡＢ]|confirm[^.\n]{0,50}|reply\s+[ab])/i.test(text) && /(?:方案\s*[ABＡＢ]|(?:两|2)\s*段|two\s+(?:clips|videos|segments))/i.test(text)) return 'parameter_plan';
  if (/确认后[^。\n]{0,30}(开始)?生成视频|confirm[^.\n]{0,40}generate the video/i.test(text)) return 'confirm_parameters';
  return 'unknown';
}
function taskView(prompt, conversationId, continuationPrompt) {
  if (conversationId && !conversationId.startsWith('local_') && !location.pathname.endsWith('/' + conversationId)) return { matched: false };
  const copy = document.body.cloneNode(true);
  for (const el of copy.querySelectorAll('script,style,textarea,[contenteditable=true],[data-testid*=conversation-list],[data-testid=draft-conversation-section]')) el.remove();
  const all = copy.textContent || '', compact = [], offsets = [];
  const normalized=value=>value.replace(/\s+/g,'').replace(/[・･]/g,'·');
  for (let i = 0; i < all.length; i++) if (!/\s/.test(all[i])) { compact.push(normalized(all[i])); offsets.push(i); }
  const needle = normalized(prompt), at = compact.join('').lastIndexOf(needle);
  const end = at >= 0 ? offsets[at + needle.length - 1] + 1 : -1;
  const editors = [...document.querySelectorAll('textarea,[contenteditable=true]')].filter(el => el.getClientRects().length).map(el => el.value || el.innerText || el.textContent || '');
  const continuation = continuationPrompt && normalized(continuationPrompt);
  return { matched: at >= 0, url: location.href, text: end >= 0 ? all.slice(end, end + 7000) : '', promptInEditor: editors.some(x => normalized(x) === needle), continuationInEditor: !!continuation && editors.some(x=>normalized(x)===continuation), continuationInMessages: !!continuation && compact.join('').includes(continuation) };
}
function namedTarget(labels, testId) {
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const point=el=>{const r=el.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint?.(x,y);return document.elementFromPoint&&hit!==el&&!el.contains(hit)?null:{x,y};};
  if (testId) { const el = document.querySelector(`[data-testid="${testId}"]`); if (!el || !visible(el) || el.disabled) return null; return point(el); }
  const elements = [...document.querySelectorAll('button,[role=button],[role=option],[role=menuitem],[role=radio],[role=tab],label')].filter(visible);
  const text = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '').trim().split('\n')[0].replace(/\s*(Ctrl|Shift|Alt)\b.*$/i, '').trim().replace(/\s+/g,' ').toLowerCase();
  for (const label of labels) {
    const hits = elements.filter(el => text(el) === label.trim().replace(/\s+/g,' ').toLowerCase() && !el.disabled);
    if (hits.length === 1) { const target=point(hits[0]);if(target)return target; }
  }
  return null;
}
async function dismissDesktopPromotion(wc) {
  const closed=await wc.executeJavaScript(`(${function(){
    const dialogs=[...document.querySelectorAll('[role=dialog]')].filter(el=>el.getClientRects().length&&/下载豆包电脑版/.test(el.innerText||'')&&/解锁本地任务能力/.test(el.innerText||''));
    if(dialogs.length!==1)return null;const button=dialogs[0].querySelector('[data-id=close-btn]');if(!button||!button.getClientRects().length)return null;
    button.click();return true;
  }.toString()})()`);
  if(!closed)return false;
  await sleep(300);return true;
}
async function dismissConversationModeMenu(wc) {
  const found=await wc.executeJavaScript(`(${function(){return [...document.querySelectorAll('[role=menu]')].some(e=>e.getClientRects().length&&(e.innerText||'').replace(/\s+/g,'')==='对话工作任务本地电脑工作任务云电脑');}.toString()})()`);
  if(!found)return false;
  await wc.executeJavaScript(`(${function(){const menus=[...document.querySelectorAll('[role=menu]')].filter(e=>e.getClientRects().length&&(e.innerText||'').replace(/\s+/g,'')==='对话工作任务本地电脑工作任务云电脑');if(menus.length!==1)return;const items=[...menus[0].querySelectorAll('[role=menuitem]')].filter(e=>e.getClientRects().length&&(e.innerText||'').trim()==='对话');if(items.length===1)items[0].click();}.toString()})()`);
  await sleep(150);return true;
}
async function clickNamed(wc, labels, testId) {
  if(labels.length&&labels.every(label=>['新对话','开启新对话','New chat'].includes(label)))return wc.executeJavaScript(`(()=>{const point=(${namedTarget.toString()})(${JSON.stringify(labels)},${JSON.stringify(testId)});if(!point)return false;const target=document.elementFromPoint(point.x,point.y);if(!target)return false;target.click();return true;})()`);
  const point = await wc.executeJavaScript(`(${namedTarget.toString()})(${JSON.stringify(labels)},${JSON.stringify(testId)})`);
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:point.x,y:point.y});
  wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x,y:point.y});
  return true;
}
function activateVideoModeButton() {
  const buttons=[...document.querySelectorAll('[data-testid=skill_bar_button_17]')].filter(e=>e.getClientRects().length&&!e.disabled&&e.innerText.trim()==='视频生成');
  if(buttons.length!==1)return false;
  const button=buttons[0],r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
  if(hit!==button&&!button.contains(hit))return false;
  button.click();return true;
}
async function chooseDuration(wc, seconds) {
  const labels=[`${seconds} 秒`,`${seconds}秒`,`${seconds}s`,`${seconds} s`];
  if(await clickNamed(wc,labels)) return true;
  const p=await wc.executeJavaScript(`(${pageProbe.toString()})()`);
  const candidates=p.buttons.filter(b=>!b.className.includes('conversation-item') && /\d+\s*(秒|s)\b/i.test(b.text));
  if(candidates.length===1) {await clickNamed(wc,[candidates[0].text.split('\n')[0]]);await sleep(300);}
  if(await clickNamed(wc,labels)) return true;
  const slider=await wc.executeJavaScript(`(${function () {
    const sliders=[...document.querySelectorAll('[role=slider]')].filter(e=>e.getClientRects().length);
    const text=document.body.innerText||document.body.textContent||'', match=/(?:时长|Duration)\s*(\d+)\s*s\s*(\d+)\s*s\s*(\d+)\s*s/i.exec(text);
    if(sliders.length!==1||!match)return null;const el=sliders[0],current=Number(el.getAttribute('aria-valuenow')),min=Number(el.getAttribute('aria-valuemin')),max=Number(el.getAttribute('aria-valuemax'));
    const [nowSeconds,minSeconds,maxSeconds]=match.slice(1).map(Number);
    if(max-min!==maxSeconds-minSeconds||current-min!==nowSeconds-minSeconds)return null;
    el.focus();return {min,max,minSeconds,maxSeconds};
  }.toString()})()`);
  if(!slider||!Number.isInteger(seconds)||seconds<slider.minSeconds||seconds>slider.maxSeconds)return false;
  for(const keyCode of ['HOME',...Array.from({length:seconds-slider.minSeconds},()=> 'RIGHT')]) {wc.sendInputEvent({type:'keyDown',keyCode});wc.sendInputEvent({type:'keyUp',keyCode});await sleep(50);}
  await sleep(200);
  return wc.executeJavaScript(`(${function (expected,minimum) { const sliders=[...document.querySelectorAll('[role=slider]')].filter(e=>e.getClientRects().length);const text=(document.body.innerText||document.body.textContent||'').replace(/\s+/g,'');return sliders.length===1&&Number(sliders[0].getAttribute('aria-valuenow'))-Number(sliders[0].getAttribute('aria-valuemin'))+minimum===expected&&(text.includes('时长'+expected+'s')||text.includes('Duration'+expected+'s')); }.toString()})(${seconds},${slider.minSeconds})`);
}
async function chooseRatio(wc, ratio) {
  if (await clickNamed(wc,[ratio])) return true;
  if (!(await clickNamed(wc,[], 'chat_input_action_video-ratio'))) return false;
  await sleep(300);
  return clickNamed(wc,[ratio]);
}
const sourceScript = vid => `(${async function (videoId) {
  const query = '?aid=497858&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version';
  async function post(name, body) {
    const r = await fetch('/samantha/aispace/' + name + query, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error('下载源接口 HTTP ' + r.status);
    const json = await r.json(); if (json.code !== undefined && json.code !== 0) throw new Error(json.message || '平台拒绝下载源请求'); return json.data;
  }
  const home = await post('homepage');
  const roots = (home?.children || []).filter(x => /我的创作|my creations|creations|created by me/i.test(x.name || ''));
  if (!roots.length) throw new Error('未识别当前平台的创作目录，需要核对平台下载接口');
  let nodeId;
  for (const root of roots) {
    let cursor; const used = new Set();
    for (let page = 0; page < 30; page++) {
      const data = await post('node_info', { node_id: root.id, need_full_path: true, size: 50, ...(cursor ? { cursor } : {}), sort_param: { need_sort_config: true, sort_order: 1, sort_type: 0 } });
      nodeId = data?.children?.find(x => String(x.key) === videoId)?.id;
      if (nodeId) break;
      const next = data?.next_cursor ?? data?.cursor;
      if (!data?.has_more || !next || used.has(String(next))) break;
      used.add(String(next)); cursor = next;
    }
    if (nodeId) break;
  }
  if (!nodeId) throw new Error('创作目录暂未找到视频，可稍后重试或在账号窗口打开创作记录');
  const data = await post('get_download_info', { requests: [{ node_id: nodeId }] });
  const url = data?.download_infos?.[0]?.main_url;
  if (!url || !/^https:\/\//.test(url)) throw new Error('平台未返回有效的视频下载源');
  return url;
}.toString()})(${JSON.stringify(vid)})`;

const dolaSourceScript = task => `(${async function (conversationId) {
  if(location.hostname!=='www.dola.com' || !conversationId || location.pathname!=='/chat/'+conversationId)throw new Error('Dola下载必须在原会话核对，不切换其他任务');
  const sources=[...new Set([...document.querySelectorAll('video')].map(el=>el.currentSrc||el.src||el.querySelector('source')?.src).filter(Boolean))];
  const identity=value=>{const u=new URL(value);const at=u.pathname.indexOf('/video/tos/');return /^v\d+-dola\.dola\.com$/.test(u.hostname)&&at>=0?u.hostname+u.pathname.slice(at):u.href;};
  if(!sources.length||new Set(sources.map(identity)).size!==1)throw new Error('原会话没有唯一可识别的视频源，请核对作品');
  const url=new URL(sources.at(-1));
  if(url.protocol!=='https:')throw new Error('Dola尚未提供可下载的HTTPS视频源');
  return url.href;
}.toString()})(${JSON.stringify(task.remote?.conversationId)})`;

function videoPreviewTarget() {
  const cards=[...document.querySelectorAll('[class*="block-video-"]')].filter(el=>{const r=el.getBoundingClientRect();return r.width>200&&r.height>120&&r.bottom>0&&r.top<innerHeight;});
  if(cards.length!==1)return null;
  const image=cards[0].querySelector('img');if(!image)return null;
  const r=image.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
}

class PlatformAdapter {
  constructor(studio, electron) {
    this.studio = studio; this.electron = electron; this.windows = new Map(); this.senderAccounts = new Map(); this.prepared = new Map(); this.capabilities = {}; this.polling = new Set(); this.pollAt = new Map();
    this.cookieAccounts = new CookieAccounts(studio, this);
    this.completionWindows = new Map(); this.completionPollAt = new Map(); this.completionReading = new Set();
    electron.ipcMain.handle('platform-observer-script', event => { if (!this.senderAccounts.has(event.sender.id)) throw new Error('未知账号窗口'); return observerScript; });
    electron.ipcMain.on('platform-observation', (event, value) => {
      const id = this.senderAccounts.get(event.sender.id); if (!id || !value) return;
      const task = this.studio.state.tasks.find(t => t.accountId === id && ['running', 'reconciling'].includes(t.status));
      if (task && value.type === 'duration_adjusted' && value.taskId === task.id && durationScript.intentFor(task) && value.duration === task.duration) { task.requestedDurationAdjusted = value.duration; this.studio.save(); }
      const promptMatches = task && value.prompts?.some(p => p === task.prompt || p === task.continuationPrompt);
      if (task && value.type === 'request' && task.submitIntentAt && promptMatches) { task.remoteRequestId = value.requestId; this.studio.save(); }
      if (task && value.type === 'accepted' && task.status === 'reconciling' && task.remoteRequestId === value.requestId && promptMatches) { task.remote = { conversationId: value.conversationId, messageId: value.messageId }; this.studio.save(); }
      if (!value.vid) return;
      this.studio.observe(id, value);
      if (task?.platform === 'dola' && !value.ready) return;
      const old = this.prepared.get(task?.id)?.seenVids || task?.observationBaseline || [];
      const conversation = task?.remote?.conversationId;
      if (task && !old.includes(value.vid) && ((task.remote?.messageId && task.remote.messageId === value.messageId) || (conversation && conversation === value.conversationId) || (value.prompt && value.prompt === task.prompt) || (task.remoteRequestId && task.remoteRequestId === value.requestId && value.prompts?.includes(task.prompt)))) {
        this.studio.attachVideo(task.id, value.vid, { platformCompletedAt: value.platformCompletedAt }); void this.studio.download(task.id);
      }
    });
  }
  async openAccount(id, { visible = true } = {}) {
    const account = this.studio.find('accounts', id);
    let win = this.windows.get(id);
    if (win && !win.isDestroyed()) { if (visible) { win.show(); win.focus(); } else win.hide(); return win; }
    const { BrowserWindow, session } = this.electron;
    const isolated = session.fromPartition(`persist:studio-${account.platform}-${account.id}`);
    await this.cookieAccounts.restore(id);
    win = this.windows.get(id);
    if (win && !win.isDestroyed()) { if (visible) { win.show(); win.focus(); } else win.hide(); return win; }
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win = new BrowserWindow({ title: `${PLATFORMS[account.platform].name} · ${account.name}`, width: 1200, height: 860, show: visible, webPreferences: { session: isolated, preload: path.join(__dirname, 'account-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    this.windows.set(id, win); this.senderAccounts.set(win.webContents.id, id);
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) void win.loadURL(url); return { action: 'deny' }; });
    win.webContents.on('did-finish-load', () => { void win.webContents.executeJavaScript(observerScript).catch(() => {}); });
    const remember = () => { const url = win.webContents.getURL(); if (url.startsWith(PLATFORMS[account.platform].url)) { account.lastPage = url; this.studio.save(); } };
    win.webContents.on('did-navigate', remember); win.webContents.on('did-navigate-in-page', remember);
    const senderId = win.webContents.id;
    win.on('closed', () => { this.senderAccounts.delete(senderId); this.windows.delete(id); });
    try { await loadAccountPage(win, account.lastPage?.startsWith(PLATFORMS[account.platform].url) ? account.lastPage : PLATFORMS[account.platform].url); }
    catch (e) { if (!e.message.includes('ERR_ABORTED')) { this.studio.setLogin(id, 'unknown', `页面加载失败：${e.message}`); throw e; } }
    return win;
  }
  async probe(id) {
    const a = this.studio.find('accounts', id); const win = await this.openAccount(id, { visible: false });
    let probe;
    for (let i = 0; i < 20; i++) { probe = await win.webContents.executeJavaScript(`(${pageProbe.toString()})()`); if (probe.composer || probe.login) break; await sleep(500); }
    const sameOrigin = new URL(probe.url).hostname === new URL(PLATFORMS[a.platform].url).hostname;
    const cookies = sameOrigin ? await win.webContents.session.cookies.get({ url: PLATFORMS[a.platform].url }) : [];
    // Cookie 只判断是否存在，永远不输出；页面必须有编辑框且无登录按钮。
    const hasSession = cookies.some(c => /^(sessionid|sessionid_ss|sid_guard|sid_tt|session_id|__Secure-sessionid)$/i.test(c.name));
    const status = sameOrigin && hasSession && probe.composer && !probe.login ? 'ready' : probe.login ? 'login_required' : 'unknown';
    this.studio.setLogin(id, status, status === 'ready' ? '页面具备编辑框与持久会话；提交时继续核验' : '请完成登录后再次检测');
    if (a.cookieLogin) { a.cookieLogin.checkState = status === 'ready' ? 'verified' : 'unverified'; a.cookieLogin.lastCheckedAt = Date.now(); this.studio.save(); }
    this.capabilities[id] = { detectedAt: Date.now(), source: 'page', videoControls: probe.buttons.filter(b => /视频|video|首帧|尾帧|reference|frame/i.test(b.text)), fileInputs: probe.inputs, confirmedGeneration: false };
    return { login: status, capabilities: this.capabilities[id] };
  }
  async inspect(id, taskId) {
    const win = await this.openAccount(id, { visible: false });
    const p = await win.webContents.executeJavaScript(`(${pageProbe.toString()})()`);
    let taskPage;
    if (taskId) {
      const task = this.studio.find('tasks', taskId); if (task.accountId !== id) throw new Error('任务不属于当前账号');
      taskPage = await win.webContents.executeJavaScript(`(${taskView.toString()})(${JSON.stringify(task.prompt)},${JSON.stringify(task.remote?.conversationId)},${JSON.stringify(task.continuationPrompt)})`);
    }
    return { url: p.url, windowVisible: win.isVisible(), mode: p.mode, composer: p.composer, loginButton: p.login, buttons: p.buttons.filter(b => !b.className.includes('conversation-item')), inputs: p.inputs, taskPage, pageText: taskId ? p.text.slice(-6000) : undefined, pageRestricted: /region-ban/.test(p.url), proxy: await win.webContents.session.resolveProxy(PLATFORMS[this.studio.find('accounts', id).platform].url) };
  }
  async selectVideoMode(id) {
    const win = await this.openAccount(id, { visible: false });
    let p;
    for (let step = 0; step < 12; step++) {
      await dismissDesktopPromotion(win.webContents);
      await dismissConversationModeMenu(win.webContents);
      p = await win.webContents.executeJavaScript(`(${pageProbe.toString()})()`);
      if (isVideoMode(p)) break;
      let clicked = await clickNamed(win.webContents,['视频生成','生成视频','AI 视频','Video generation','Generate video','Create video']);
      if(step>=1) clicked=await win.webContents.executeJavaScript(`(${activateVideoModeButton.toString()})()`)||clicked;
      if (!clicked) await clickNamed(win.webContents,[], 'chat_input_action_mode');
      await sleep(500);
    }
    p = await win.webContents.executeJavaScript(`(${pageProbe.toString()})()`);
    return { selected: isVideoMode(p), mode: p.mode, buttons: p.buttons.filter(b => !b.className.includes('conversation-item')), inputs: p.inputs };
  }
  async discoverCapabilities(id) {
    if(this.studio.state.tasks.some(t=>t.accountId===id && ['preparing','awaiting_confirmation','running','reconciling'].includes(t.status)))throw new Error('账号有未完成任务，暂不切换页面探测能力');
    const login = await this.probe(id); if (login.login !== 'ready') return { login: login.login, confirmed: false };
    const selected = await this.selectVideoMode(id), win = await this.openAccount(id, { visible: false });
    const p = await win.webContents.executeJavaScript(`(${pageProbe.toString()})()`);
    const controls = p.buttons.filter(b => !b.className.includes('conversation-item') && /秒|\b\d+\s*s\b|首帧|尾帧|参考|frame|reference|Seedance|模型|model|比例|ratio|16:9|9:16/i.test(b.text));
    const quotaHints = [...p.text.matchAll(/[^。\n]{0,25}(额度|剩余|免费次数|每日|credits|quota)[^。\n]{0,70}/gi)].map(m => m[0]).slice(-12);
    const result = { detectedAt: Date.now(), login: login.login, videoMode: selected.selected, mode: p.mode, windowVisible: win.isVisible(), controls, inputs: p.inputs, quotaHints, durations: [5, 10, 15, 30].filter(n => controls.some(b => new RegExp(`^${n}\\s*(秒|s)$`, 'i').test(b.text))), nativeFirst: controls.some(b => /首帧|first frame/i.test(b.text)), nativeFirstLast: controls.some(b => /首尾帧|first.*last/i.test(b.text)), verifiedGeneration: false };
    const account = this.studio.find('accounts', id); account.capabilities = result; this.studio.save(); return result;
  }
  async syncQuota(id) {
    this.quotaSyncPromises ||= new Map();this.quotaSyncing ||= new Set();
    if(this.quotaSyncPromises.has(id))return this.quotaSyncPromises.get(id);
    this.quotaSyncing.add(id);
    const promise=this.readQuota(id);this.quotaSyncPromises.set(id,promise);
    try{return await promise;}finally{this.quotaSyncing.delete(id);this.quotaSyncPromises.delete(id);}
  }
  syncIdleQuotas() {
    for(const a of this.studio.state.accounts)if(a.platform==='doubao'&&a.quotaMode==='auto'&&a.login==='ready'&&!this.quotaSyncing?.has(a.id)&&Date.now()-(a.quotaSyncCheckedAt||0)>doubaoQuota.STALE_MS&&!this.studio.state.tasks.some(t=>t.accountId===a.id&&['preparing','awaiting_confirmation','running','reconciling','downloading'].includes(t.status)))void this.syncQuota(a.id).catch(()=>{});
  }
  async readQuota(id) {
    const a=this.studio.find('accounts',id);
    if(a.platform!=='doubao')throw new Error('额度同步仅适用于国内豆包');
    if(this.studio.state.tasks.some(t=>t.accountId===id&&['preparing','awaiting_confirmation','running','reconciling','downloading'].includes(t.status)))throw new Error('账号正在处理任务，暂不刷新额度页面');
    a.quotaSyncCheckedAt=Date.now();
    const login=await this.probe(id);if(login.login!=='ready')throw new Error('请恢复豆包登录后同步额度');
    const win=await this.openAccount(id,{visible:false});
    try {a.platformQuota=await readPlatformQuota(win);a.quotaSyncError=null;this.studio.save();return {accountId:id,readOnly:true,generationSubmitted:false,windowVisible:win.isVisible(),...a.platformQuota};}
    catch(error){a.quotaSyncError=error.message;a.quotaSyncCheckedAt=Date.now();this.studio.save();throw error;}
  }
  async inspectOptions(id, kind = 'parameters', duration) {
    let imageAssetId, requestedModel, taskId;
    if (kind && typeof kind === 'object') { duration = kind.duration; imageAssetId = kind.imageAssetId; requestedModel = kind.model; taskId=kind.taskId; kind = kind.kind || 'parameters'; }
    if(kind==='quota_network')return this.syncQuota(id);
    if(kind==='new_video') {
      if(this.studio.state.tasks.some(t=>t.accountId===id&&['preparing','awaiting_confirmation','running','reconciling','downloading'].includes(t.status)))throw new Error('账号有未完成任务，不切换新对话');
      if(this.quotaSyncing?.has(id))throw new Error('账号正在同步额度，请稍后核对视频入口');
      const win=await this.openAccount(id,{visible:false}),wc=win.webContents;
      const hasDraft=await wc.executeJavaScript(`(${function(){return [...document.querySelectorAll('textarea,[contenteditable=true]')].some(el=>el.getClientRects().length&&!!(el.value||el.innerText||el.textContent||'').trim());}.toString()})()`);
      if(hasDraft)throw new Error('当前编辑框有草稿，保留内容，不切换新对话');
      if(!(await clickNamed(wc,['新对话','开启新对话','New chat'])))throw new Error('未明确识别新对话入口');
      await sleep(1000);
      let blank=await wc.executeJavaScript(`(${pageProbe.toString()})()`);
      if(!blank.composer&&!blank.login) {
        await loadAccountPage(win,PLATFORMS[this.studio.find('accounts',id).platform].url);
        await waitForComposer(wc);
      }
      const result=await this.selectVideoMode(id);
      return {...result,windowVisible:win.isVisible(),generationSubmitted:false};
    }
    if (kind === 'resume_download') {
      const task = this.studio.find('tasks', taskId);
      if (task.accountId !== id || task.platform !== 'doubao' || !task.vid || task.status !== 'downloading') throw new Error('仅可续传此账号正在下载的原作品');
      this.resumingDownloads ||= new Map();
      if (this.resumingDownloads.has(taskId)) return this.resumingDownloads.get(taskId);
      const run = (async () => {
        const win = await this.openAccount(id, { visible: false }), wc = win.webContents;
        const url = await boundedRead(() => wc.executeJavaScript(sourceScript(task.vid)));
        const partial = path.join(this.studio.directory, 'outputs', `doubao-${task.id}.mp4.part`), output = path.join(this.studio.directory, 'outputs', `doubao-${task.id}-resumed.mp4`);
        const resumed = await resumePlatformFile(wc.session, url, partial, output);
        const info = await videoInfo(output);
        task.recoveredDownload = { ...resumed, vid: task.vid, mediaInfo: info, completedAt: Date.now() }; this.studio.save();
        // 原作已生成且续传完成；关闭原慢连接，让同一任务的下载重试采用已校验文件。
        if (task.status === 'downloading' && !this.studio.state.tasks.some(t => t.accountId === id && t.id !== task.id && ['preparing','reconciling','running'].includes(t.status))) await wc.session.closeAllConnections();
        return { taskId, ...resumed, mediaInfo: info, generationSubmitted: false, windowVisible: win.isVisible() };
      })();
      this.resumingDownloads.set(taskId, run);
      try { return await run; } finally { this.resumingDownloads.delete(taskId); }
    }
    if (kind === 'download_progress') {
      const task = this.studio.find('tasks', taskId);
      if (task.accountId !== id || task.platform !== 'doubao' || !task.vid) throw new Error('下载进度需要此账号已有视频的原作品');
      const file = path.join(this.studio.directory, 'outputs', `doubao-${task.id}.mp4`), partial = `${file}.part`;
      const complete = fs.existsSync(file), local = complete ? file : partial;
      let bytesTotal = complete ? fs.statSync(file).size : null, note;
      const win = await this.openAccount(id, { visible: false });
      if (!complete) {
        try {
          const url = await boundedRead(() => win.webContents.executeJavaScript(sourceScript(task.vid)));
          const response = await win.webContents.session.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
          const length = Number(response.headers.get('content-length'));
          if (response.ok && /video|octet-stream/i.test(response.headers.get('content-type') || '') && Number.isSafeInteger(length) && length > 0) bytesTotal = length;
          else note = '视频源未提供可核对的文件大小';
        } catch { note = '文件头核对暂未完成，保留原下载'; }
      }
      return { taskId, readOnly: true, generationSubmitted: false, windowVisible: win.isVisible(), bytesReceived: fs.existsSync(local) ? fs.statSync(local).size : 0, bytesTotal, downloadSeconds: task.downloadStartedAt ? Math.round(((task.downloadCompletedAt || Date.now()) - task.downloadStartedAt) / 1000) : null, note };
    }
    if (kind === 'network_reconnect') {
      const account = this.studio.find('accounts', id);
      if (this.studio.state.tasks.some(t => t.accountId === id && ['preparing', 'awaiting_confirmation', 'running', 'reconciling', 'downloading'].includes(t.status))) throw new Error('账号有正在处理的任务，暂不重建网络连接');
      const session = this.electron.session.fromPartition(`persist:studio-${account.platform}-${id}`);
      await session.closeAllConnections(); await session.clearCache();
      return { reconnected: true, cookiesPreserved: true };
    }
    if (kind === 'completion_replay') {
      const task = this.studio.find('tasks', taskId);
      if (task.accountId !== id || task.platform !== 'dola' || !task.vid) throw new Error('核对测试需要此账号已有作品的原任务');
      const startedAt = Date.now();
      const result = await this.readDolaCompletion(task.id, { expectedVid: task.vid });
      return { taskId, readOnly: true, generationSubmitted: false, windowVisible: false, elapsedMs: Date.now() - startedAt, ...result };
    }
    if(kind==='conversation_reload') {
      const task=this.studio.find('tasks',taskId);
      if(task.accountId!==id || !['submission_review','running','reconciling','downloading','download_pending','done','parameter_review'].includes(task.status) || !/^[\w-]{1,160}$/.test(task.remote?.conversationId || ''))throw new Error('仅可刷新有原会话记录的已提交任务');
      if(this.studio.state.tasks.some(t=>t.accountId===id && t.id!==task.id && ['preparing','awaiting_confirmation','running','reconciling'].includes(t.status)))throw new Error('账号有其他未完成任务，不刷新其页面');
      const win=await this.openAccount(id,{visible:false});
      await loadAccountPage(win,PLATFORMS[task.platform].url+task.remote.conversationId);
      let taskPage;
      for(let i=0;i<20;i++){taskPage=await win.webContents.executeJavaScript(`(${taskView.toString()})(${JSON.stringify(task.prompt)},${JSON.stringify(task.remote.conversationId)})`);if(taskPage.matched)break;await sleep(500);}
      return {taskId:task.id,taskPage,windowVisible:win.isVisible(),readOnly:true};
    }
    if(kind==='video_evidence') {
      const task=this.studio.find('tasks',taskId);
      if(task.accountId!==id || !task.vid)throw new Error('请提供此账号已有作品的原任务');
      const win=await this.openAccount(id,{visible:false});
      const view=await win.webContents.executeJavaScript(`(${taskView.toString()})(${JSON.stringify(task.prompt)},${JSON.stringify(task.remote?.conversationId)})`);
      if(!view.matched)throw new Error('当前页面未匹配原作品会话');
      const evidence=await win.webContents.executeJavaScript(`(${function(){
        const safeUrl=value=>{try{const u=new URL(value,location.href),at=u.pathname.indexOf('/video/tos/');return {protocol:u.protocol,host:u.hostname,path:at>=0?u.pathname.slice(at):u.pathname};}catch{return null;}};
        const nodes=[...document.querySelectorAll('[data-testid],video,iframe,time,a')];
        return {videos:[...document.querySelectorAll('video')].map(el=>({duration:Number.isFinite(el.duration)?el.duration:null,width:el.videoWidth,height:el.videoHeight,readyState:el.readyState,source:safeUrl(el.currentSrc||el.src||''),poster:safeUrl(el.poster||''),parentTestId:el.parentElement?.getAttribute('data-testid')})),
          cards:nodes.filter(el=>/video|creation|download|play/i.test(el.getAttribute('data-testid')||'')).map(el=>({tag:el.tagName,testId:el.getAttribute('data-testid'),role:el.getAttribute('role'),text:(el.innerText||el.textContent||'').slice(0,120),title:el.title,aria:el.getAttribute('aria-label')})).slice(-60),
          previews:[...document.querySelectorAll('img')].filter(el=>{const r=el.getBoundingClientRect();return r.width>200&&r.height>120&&r.bottom>0&&r.top<innerHeight;}).map(el=>({alt:el.alt,source:safeUrl(el.currentSrc||el.src),ancestors:[el,el.parentElement,el.parentElement?.parentElement,el.parentElement?.parentElement?.parentElement].filter(Boolean).map(n=>({tag:n.tagName,className:typeof n.className==='string'?n.className:'',testId:n.getAttribute('data-testid'),role:n.getAttribute('role')}))})),
          times:[...document.querySelectorAll('time')].map(el=>({datetime:el.getAttribute('datetime'),text:el.textContent})),
          frames:[...document.querySelectorAll('iframe')].map(el=>safeUrl(el.src)),
          resources:performance.getEntriesByType('resource').map(el=>{try{const u=new URL(el.name);return /dola\.com$/.test(u.hostname)?{path:u.pathname,aid:u.searchParams.get('aid')}:null;}catch{return null;}}).filter(Boolean).filter(el=>/video|history|conversation|aispace/.test(el.path)).slice(-25)};
      }.toString()})()`);
      return {taskId:task.id,vid:task.vid,windowVisible:win.isVisible(),readOnly:true,...evidence};
    }
    if(kind==='video_preview') {
      const task=this.studio.find('tasks',taskId);
      if(task.accountId!==id || !task.vid)throw new Error('仅可打开原任务已返回的视频预览');
      if(this.studio.state.tasks.some(t=>t.accountId===id && t.id!==task.id && ['preparing','awaiting_confirmation','running','reconciling'].includes(t.status)))throw new Error('账号有其他未完成任务，不切换预览');
      const win=await this.openAccount(id,{visible:false});
      const view=await win.webContents.executeJavaScript(`(${taskView.toString()})(${JSON.stringify(task.prompt)},${JSON.stringify(task.remote?.conversationId)})`);
      if(!view.matched)throw new Error('当前页面未匹配原作品会话');
      const target=await win.webContents.executeJavaScript(`(${videoPreviewTarget.toString()})()`);
      if(!target)throw new Error('原会话没有唯一可识别的视频卡片');
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...target});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...target});
      await sleep(1000);
      return this.inspectOptions(id,{kind:'video_evidence',taskId});
    }
    if(kind==='video_timing') {
      const task=this.studio.find('tasks',taskId);
      if(task.accountId!==id||task.platform!=='dola'||!task.vid||!/^[\w-]{1,160}$/.test(task.remote?.conversationId||''))throw new Error('作品时间检查需要原Dola任务与作品ID');
      if(this.studio.state.tasks.some(t=>t.accountId===id&&t.id!==task.id&&['preparing','awaiting_confirmation','running','reconciling'].includes(t.status)))throw new Error('账号有其他未完成任务，不刷新时间记录');
      const win=await this.openAccount(id,{visible:false});
      const metadata=await inspectVideoTiming(win,task.vid,()=>loadAccountPage(win,PLATFORMS.dola.url+task.remote.conversationId));
      return {taskId:task.id,vid:task.vid,readOnly:true,windowVisible:win.isVisible(),...metadata};
    }
    if (kind === 'window_state') { this.studio.find('accounts',id); const window=this.windows.get(id), reader=this.completionWindows?.get(id); return { opened:!!window && !window.isDestroyed(), visible:!!window && !window.isDestroyed() && window.isVisible(), completionReader:reader&&!reader.isDestroyed()?{visible:reader.isVisible(),loading:reader.webContents.isLoading(),reading:this.completionReading?.has(id),networkObserver:reader.webContents.debugger.isAttached()}:null, activeTasks:this.studio.state.tasks.filter(t=>t.accountId===id && ['running','reconciling','awaiting_confirmation'].includes(t.status)).map(t=>({id:t.id,status:t.status,polling:this.polling.has(t.id),nextPollIn:(this.pollAt.get(t.id)||0)-Date.now()})) }; }
    if (kind === 'page_evidence') {
      const win=await this.openAccount(id,{visible:false});
      const capture=await win.webContents.capturePage();
      const file=path.join(this.studio.directory,'outputs',`diagnostic-${this.studio.find('accounts',id).platform}-${Date.now()}.jpg`);
      fs.writeFileSync(file,capture.toJPEG(85));
      const p=await win.webContents.executeJavaScript(`(${pageProbe.toString()})()`);
      return {file,windowVisible:win.isVisible(),mode:p.mode,panelText:p.text.slice(-6000)};
    }
    if (this.studio.state.tasks.some(t => t.accountId === id && ['preparing','awaiting_confirmation','running','reconciling'].includes(t.status))) throw new Error('账号有未完成任务，不切换参数菜单');
    const win = await this.openAccount(id, { visible: false }); await this.selectVideoMode(id);
    if (imageAssetId) {
      const image=this.studio.find('assets',imageAssetId); if(image.kind!=='image')throw new Error('预检素材必须是图片');
      const debug=win.webContents.debugger;if(!debug.isAttached())debug.attach('1.3');
      try {const {root}=await debug.sendCommand('DOM.getDocument',{depth:-1});const {nodeIds}=await debug.sendCommand('DOM.querySelectorAll',{nodeId:root.nodeId,selector:'input[type=file]'});if(nodeIds.length!==1)throw new Error('图片预检要求唯一上传入口');await debug.sendCommand('DOM.setFileInputFiles',{nodeId:nodeIds[0],files:[image.file]});}finally{if(debug.isAttached())debug.detach();}
      await sleep(2500);
    }
    let p = await win.webContents.executeJavaScript(`(${pageProbe.toString()})()`);
    const candidates = p.buttons.filter(b => !b.className.includes('conversation-item') && (kind === 'model' ? /^(模型|Model)\b|^模型\n/i.test(b.text) : /\d+\s*(秒|s)\b/i.test(b.text)));
    let clicked=false;
    if(requestedModel) {
      const selected=p.buttons.some(b=>/^模型\n|^Model\n/.test(b.text)&&doubaoQuota.modelKey(b.text.split('\n').at(-1))===doubaoQuota.modelKey(requestedModel));
      if(!selected){
        if(!p.buttons.some(b=>doubaoQuota.modelKey(b.text.split('\n')[0])===doubaoQuota.modelKey(requestedModel))){if(candidates.length!==1 || !(await clickNamed(win.webContents,[candidates[0].text.split('\n')[0]])))throw new Error('未明确识别模型菜单');await sleep(300);}
        if(!(await clickNamed(win.webContents,[requestedModel])))throw new Error('未明确识别指定模型选项');
      }
      clicked=true;
    } else clicked=duration !== undefined ? await chooseDuration(win.webContents,duration) : candidates.length === 1 && await clickNamed(win.webContents,[candidates[0].text.split('\n')[0]]);
    await sleep(400); p = await win.webContents.executeJavaScript(`(${pageProbe.toString()})()`);
    if(requestedModel&&!p.buttons.some(b=>/^模型\n|^Model\n/.test(b.text)&&doubaoQuota.modelKey(b.text.split('\n').at(-1))===doubaoQuota.modelKey(requestedModel)))throw new Error('指定模型未在页面生效');
    const fields = await win.webContents.executeJavaScript(`(${function () { return [...document.querySelectorAll('input:not([type=file]),select,[role=slider],[role=radio]')].filter(el=>el.getClientRects().length).map(el=>({tag:el.tagName,type:el.type,role:el.getAttribute('role'),value:el.value,min:el.min,max:el.max,step:el.step,ariaMin:el.getAttribute('aria-valuemin'),ariaMax:el.getAttribute('aria-valuemax'),ariaNow:el.getAttribute('aria-valuenow'),label:el.getAttribute('aria-label'),html:el.outerHTML.slice(0,800)})); }.toString()})()`);
    return { clicked, windowVisible: win.isVisible(), mode: p.mode, controls: p.buttons.filter(b => !b.className.includes('conversation-item')).map(b => ({ text:b.text,selected:b.selected,testId:b.testId })), inputs:p.inputs, fields, panelText:p.text.slice(-5000) };
  }
  async prepare(task, account) {
    const win = await this.openAccount(account.id, { visible: false }); const wc = win.webContents;
    if(!task.submitIntentAt) {
      const page=await wc.executeJavaScript(`(${pageProbe.toString()})()`);
      if(!page.composer&&!page.login){await loadAccountPage(win,PLATFORMS[account.platform].url);await waitForComposer(wc);}
    }
    const checked = await this.probe(account.id); if (checked.login !== 'ready') throw problem('login', '账号需要登录或页面尚未就绪');
    const seenVids = this.studio.state.observations.filter(o => o.accountId === account.id).map(o => o.vid);
    this.prepared.set(task.id, { seenVids });
    this.studio.find('tasks', task.id).observationBaseline = seenVids; this.studio.save();
    const click = labels => clickNamed(wc, labels);
    await dismissDesktopPromotion(wc);
    const freshChat = await click(['新对话', '开启新对话', 'New chat']); await sleep(1000);
    if (!freshChat) return { reason: '未明确识别新对话入口。请开始一个空白视频对话后核对，避免将历史结果关联到新任务' };
    const blankPage=await wc.executeJavaScript(`(${pageProbe.toString()})()`);
    if(!blankPage.composer&&!blankPage.login) {
      await loadAccountPage(win,PLATFORMS[account.platform].url);
      await waitForComposer(wc);
    }
    Object.assign(this.studio.find('tasks',task.id),{remote:null,remoteRequestId:null});this.studio.save();
    const selection = await this.selectVideoMode(account.id);
    let probe = await wc.executeJavaScript(`(${pageProbe.toString()})()`), video = selection.selected;
    if (!video) return { reason: `尚未确认已进入视频生成模式（当前：${probe.mode || '未识别'}）。本次尚未上传或提交` };
    if (task.model) {
      const current = probe.buttons.find(b => /^(模型|Model)\b|^模型\n/i.test(b.text));
      if (current?.text.split('\n').at(-1).replace(/\s+/g,'').toLowerCase() !== task.model.replace(/\s+/g,'').toLowerCase()) {
        await click(['模型','Model']); await sleep(300);
        if (!(await click([task.model]))) return { reason: `未确认生成模型${task.model}，本次尚未提交` };
      }
      probe=await wc.executeJavaScript(`(${pageProbe.toString()})()`);
      if(!probe.buttons.some(b=>/^模型\n|^Model\n/i.test(b.text)&&doubaoQuota.modelKey(b.text.split('\n').at(-1))===doubaoQuota.modelKey(task.model)))return {reason:'页面未确认所需模型，保留任务，不自动切换其他模型'};
    }
    if (task.mode === 'first') {
      await click(['首帧', '首帧生成', '图生视频', 'First frame', 'Image to video']); await sleep(300);
      probe = await wc.executeJavaScript(`(${pageProbe.toString()})()`);
      if (!/首帧|first frame|image to video|图生视频/i.test(probe.text)) return { reason: '未识别平台原生首帧模式，保留续接素材等待反馈，本次尚未提交' };
    } else if (task.mode === 'first_last') {
      const selected = await click(['首尾帧', '首尾帧生成', 'First and last frame', 'First & last frame']); await sleep(400);
      probe = await wc.executeJavaScript(`(${pageProbe.toString()})()`);
      if (!selected && !/首帧[\s\S]*尾帧|first frame[\s\S]*last frame/i.test(probe.text)) return { reason: '尚未确认平台首尾帧入口，不会按普通参考图提交。请选择首尾帧模式后继续准备' };
    }
    for (const [value, labels] of [[task.duration, task.duration ? [`${task.duration} 秒`, `${task.duration}秒`, `${task.duration}s`, `${task.duration} s`] : []], [task.ratio, task.ratio ? [task.ratio] : []]]) {
      let selected = !value || (value === task.duration ? await chooseDuration(wc, task.duration) : await chooseRatio(wc, task.ratio));
      if (!selected) {
        const options = await wc.executeJavaScript(`(${pageProbe.toString()})()`);
        const candidate = options.buttons.filter(b => !b.className.includes('conversation-item') && /\d+\s*(秒|s)\b/i.test(b.text));
        if (candidate.length === 1) { await click([candidate[0].text.split('\n')[0]]); await sleep(300); selected = await click(labels); }
      }
      if (value && !selected) {
        if (value === task.duration && task.duration === 15 && account.platform === 'doubao') this.studio.find('tasks', task.id).durationStrategy = 'request_15s';
        else if (value === task.duration && account.platform === 'dola' && [15,30].includes(task.duration) && durationScript.intentFor(task)) this.studio.find('tasks', task.id).durationStrategy = `request_${task.duration}s_seedance_2.5`;
        else return { reason: `未确认平台参数 ${value}，保留任务等待参数反馈；本次尚未提交` };
      }
    }
    wc.sendInputEvent({type:'keyDown',keyCode:'ESCAPE'});wc.sendInputEvent({type:'keyUp',keyCode:'ESCAPE'});await sleep(100);
    const files = task.refs.map(r => ({ role: r.role, file: this.studio.find('assets', r.assetId).file }));
    let uploadedReferences = false;
    const debug = wc.debugger; if (!debug.isAttached()) debug.attach('1.3');
    try {
      await debug.sendCommand('DOM.enable');
      const { root } = await debug.sendCommand('DOM.getDocument', { depth: -1 });
      const { nodeIds } = await debug.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
      if (!nodeIds.length) return { reason: '未识别图片上传输入，请展开平台参考图上传入口后继续准备' };
      for (let i = 0; i < nodeIds.length; i++) {
        const { attributes } = await debug.sendCommand('DOM.getAttributes', { nodeId: nodeIds[i] });
        const attrs = Object.fromEntries(Array.from({ length: attributes.length / 2 }, (_, j) => [attributes[2 * j], attributes[2 * j + 1]]));
        if (attrs.accept && !/image|jpg|jpeg|png|webp|\*/i.test(attrs.accept)) continue;
        if (task.mode === 'references') {
          if (files.length > 1 && !Object.hasOwn(attrs, 'multiple')) return { reason: '上传入口未确认支持多图，不会丢弃参考图；请核对页面模式' };
          await debug.sendCommand('DOM.setFileInputFiles', { nodeId: nodeIds[i], files: files.map(f => f.file) }); uploadedReferences = true; break;
        }
        // 必须明确识别首尾角色，不依赖 DOM 顺序猜测。
        const { object } = await debug.sendCommand('DOM.resolveNode', { nodeId: nodeIds[i] });
        const hint = await debug.sendCommand('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){ return (this.closest("label")?.innerText || this.closest("label")?.textContent || this.parentElement?.parentElement?.innerText || this.parentElement?.parentElement?.textContent || "").slice(0,200); }', returnByValue: true });
        const text = hint.result.value || '';
        const role = /首帧|first frame/i.test(text) ? 'first' : /尾帧|last frame/i.test(text) ? 'last' : null;
        if (role) { await debug.sendCommand('DOM.setFileInputFiles', { nodeId: nodeIds[i], files: [files.find(f => f.role === role).file] }); files.find(f => f.role === role).uploaded = true; }
      }
      if (task.mode !== 'references' && files.some(f => !f.uploaded)) return { reason: '未明确识别上传控件的首尾帧角色，本次尚未提交' };
      if (task.mode === 'references' && !uploadedReferences) return { reason: '未识别可接受参考图片的上传控件，本次尚未提交' };
    } finally { if (debug.isAttached()) debug.detach(); }
    for (let i = 0; i < 60; i++) {
      await sleep(500); const upload = await wc.executeJavaScript(`(${pageProbe.toString()})()`);
      if (/上传失败|upload failed/i.test(upload.text)) return { reason: '图片上传失败，本次尚未提交' };
      if (i >= 3 && !/上传中|uploading|(?:^|\n)\s*(?:[0-9]|[1-9][0-9])%\s*(?:\n|$)/i.test(upload.text)) break;
      if (i === 59) return { reason: '图片上传仍未完成，本次尚未提交，可稍后继续准备' };
    }
    const filled = await wc.executeJavaScript(`(${function () {
      const inputs = [...document.querySelectorAll('textarea,[contenteditable=true]')].filter(el => el.getClientRects().length);
      if (inputs.length !== 1) return false; const el = inputs[0]; el.focus();
      if (el.tagName === 'TEXTAREA') el.select();
      else { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
      return true;
    }.toString()})()`);
    if (!filled) return { reason: '未唯一识别提示词编辑框，请在账号窗口检查页面' };
    wc.insertText(task.prompt);
    const page = await wc.executeJavaScript(`(${pageProbe.toString()})()`);
    if (!isVideoMode(page)) return { reason: `上传后视频模式发生变化（当前：${page.mode || '未识别'}），本次尚未提交` };
    if (/上传中|uploading|上传失败|upload failed/i.test(page.text)) return { reason: '参考图仍在上传或上传失败，请核对后继续准备' };
    if (page.buttons.some(b => b.testId === 'chat_input_send_button' && b.disabled)) return { reason: '平台发送按钮尚未就绪，本次尚未提交' };
    // 发送前再次核对当前模式和提示词，不以入口按钮文字证明视频模式。
    this.studio.find('tasks', task.id).preparedPage = page.url;
    this.studio.find('tasks', task.id).prepared = { mode: task.mode, promptFilled: true, filesUploaded: files.length, videoModeSelected: video };
    this.studio.save();
    if (task.reviewBeforeSend) return {reason:'素材与提示词已准备，等待本次发送前检查；尚未提交'};
    await this.submitPrepared(task.id);
    return { status: 'reconciling' };
  }
  async continueTask(id) {
    const t = this.studio.find('tasks', id); if (t.status !== 'awaiting_confirmation') throw new Error('任务不在准备状态');
    if(t.paymentRequired)throw new Error('平台要求付费额度，本任务等待明确付费确认，不重新准备或发送');
    if(t.authorizationRequired)throw new Error('请先在项目任务队列查看并确认素材授权声明');
    await this.studio.execute(t, this.studio.find('accounts', t.accountId)); return this.studio.find('tasks', id);
  }
  async submitPrepared(id) {
    const task = this.studio.find('tasks', id);
    if(task.paymentRequired)throw new Error('平台要求付费额度，本任务等待明确付费确认');
    if(task.authorizationRequired)throw new Error('请先在项目任务队列查看并确认素材授权声明');
    if (!['preparing','awaiting_confirmation'].includes(task.status) || !task.prepared?.videoModeSelected || !task.prepared.promptFilled) throw new Error('任务尚未完成视频模式与素材的准备');
    const win = await this.openAccount(task.accountId, { visible: false }); const wc = win.webContents;
    const probe = await wc.executeJavaScript(`(${pageProbe.toString()})()`);
    const promptMatches = await wc.executeJavaScript(`(${function (prompt) { return [...document.querySelectorAll('textarea,[contenteditable=true]')].some(el => (el.value || el.innerText || el.textContent || '').replace(/\s+/g,'') === prompt.replace(/\s+/g,'')); }.toString()})(${JSON.stringify(task.prompt)})`);
    if (!promptMatches || !isVideoMode(probe)) throw new Error('页面提示词或视频模式已改变，请重新准备');
    if(task.platform==='doubao'&&task.model&&!probe.buttons.some(b=>/^模型\n/i.test(b.text)&&doubaoQuota.modelKey(b.text.split('\n').at(-1))===doubaoQuota.modelKey(task.model)))throw new Error('页面模型与任务不一致，停止发送');
    if (task.platform === 'dola' && [15,30].includes(task.duration) && !probe.buttons.some(b=>/^模型\n2\.5$/i.test(b.text) || /^Model\n2\.5$/i.test(b.text))) throw new Error(`Dola${task.duration}秒请求必须确认当前页面为Seedance 2.5，本次尚未提交`);
    if(task.platform==='dola' && [15,30].includes(task.duration)) {
      this.durationTransports ||= new Map();await this.durationTransports.get(wc.id)?.();
      const close=await installDurationTransport(wc,{platform:task.platform,duration:task.duration,prompt:task.prompt,pageModelVerified:true,expiresAt:Date.now()+15*60000},parameters=>{
        task.requestedDurationAdjusted=task.duration;task.requestParameters=parameters;this.studio.save();
      },(reason,parameters)=>{
        const attempt=this.studio.find('attempts',task.attemptId);
        if(attempt.phase==='accepted'||task.vid)return;
        attempt.phase='reserved';this.studio.transition(task,'awaiting_confirmation',{reason,requestParameters:parameters,previousChatSubmitIntentAt:task.submitIntentAt,submitIntentAt:null,prepared:null,submissionNotSentEvidence:'CDP在请求发送到平台前拦截'});
      },trace=>{(task.transportTrace ||= []).push(trace);task.transportTrace=task.transportTrace.slice(-5);this.studio.save();});
      this.durationTransports.set(wc.id,close);
    }
    await wc.executeJavaScript(durationScript(durationScript.intentFor(task)));
    if (!['preparing','awaiting_confirmation'].includes(task.status) || this.studio.find('attempts',task.attemptId).phase !== 'reserved') throw new Error('任务准备已取消或发送已开始，停止重复提交');
    this.studio.transition(task, 'reconciling', { reason: '发送意图已记录，正在核实平台响应', submitIntentAt: Date.now() });
    this.studio.find('attempts', task.attemptId).phase = 'uncertain'; this.studio.save();
    const clicked = await clickNamed(wc,[], 'chat_input_send_button') || await clickNamed(wc,['发送','Send','生成','Generate','发送消息','Send message']);
    if (!clicked) {
      const focused = await wc.executeJavaScript(`(${function (prompt) {
        const els = [...document.querySelectorAll('textarea,[contenteditable=true]')].filter(el => el.getClientRects().length && (el.value || el.innerText || el.textContent || '').replace(/\s+/g,'') === prompt.replace(/\s+/g,''));
        if (els.length !== 1) return false; els[0].focus(); return true;
      }.toString()})(${JSON.stringify(task.prompt)})`);
      if (focused) { wc.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' }); }
      else { this.studio.find('attempts', task.attemptId).phase = 'reserved'; this.studio.transition(task, 'awaiting_confirmation', { reason: '未明确识别发送控件，尚未提交' }); }
    }
    return this.studio.find('tasks', id);
  }
  async confirmParameters(id) {
    const task = this.studio.find('tasks', id);
    if (!['running','reconciling'].includes(task.status) || task.vid || task.parameterConfirmationAt) throw new Error('任务不需要重复确认参数');
    const win = await this.openAccount(task.accountId, { visible: false }); const wc = win.webContents;
    const page = await wc.executeJavaScript(`(${taskView.toString()})(${JSON.stringify(task.prompt)},${JSON.stringify(task.remote?.conversationId)})`);
    if (!page.matched || generationStage(page.text) !== 'confirm_parameters') throw new Error('当前任务页面没有明确的生成参数确认请求');
    const proposal = page.text.slice(Math.max(0, page.text.lastIndexOf('视频生成参数确认'))).replace(/\s+/g, '');
    if (task.duration && !new RegExp(`(?:^|[^\\d.])${task.duration}(?:\\.0+)?(秒|s)(?![a-z])`, 'i').test(proposal)) throw new Error('平台提议的时长与任务参数不一致，等待核实');
    if (task.ratio && !proposal.includes(task.ratio)) throw new Error('平台提议的比例与任务参数不一致，等待核实');
    const selectedModel = /Seedance\s*[\d.]+\s*(?:Mini|Lite|Pro|Fast)?/i.exec(proposal)?.[0];
    if (task.model && selectedModel?.replace(/\s+/g,'').toLowerCase() !== task.model.replace(/^Dreamina\s*/i,'').replace(/\s+/g, '').toLowerCase()) throw new Error('平台提议的模型与任务不一致，等待核实');
    if (selectedModel) { task.selectedModel = selectedModel; this.studio.find('attempts', task.attemptId).model = selectedModel; }
    if(task.platform==='doubao') {
      const account=this.studio.find('accounts',task.accountId),attempt=this.studio.find('attempts',task.attemptId);
      if(doubaoQuota.recordFeedback(account,task,attempt,page.text,Date.now()))this.studio.save();
      if(account.quotaMode==='auto' && task.quotaFeedback && task.quotaFeedback.cost>task.quotaFeedback.remaining){this.studio.reject(task,'quota','平台提议的额度不足，未确认生成，切换账号');return task;}
    }
    const focused = await wc.executeJavaScript(`(${function () {
      const els = [...document.querySelectorAll('textarea,[contenteditable=true]')].filter(el => el.getClientRects().length);
      if (els.length !== 1) return false; const el = els[0]; el.focus();
      if (el.tagName === 'TEXTAREA') el.select(); else { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
      return true;
    }.toString()})()`);
    if (!focused) throw new Error('尚未识别参数确认的编辑框');
    const text = task.platform === 'doubao' ? '确认，按上述参数立即开始生成视频。使用本对话已上传的参考图，请直接生成，不再重复确认。' : 'Confirmed. Generate the video now using the uploaded reference images and the agreed parameters. No further confirmation is needed.';
    await wc.executeJavaScript(durationScript(durationScript.intentFor(task,[task.prompt,text])));
    wc.insertText(text);
    await sleep(200);
    task.parameterConfirmationAt = Date.now(); task.continuationPrompt = text;
    this.studio.find('attempts', task.attemptId).phase = 'uncertain';
    this.studio.transition(task, 'reconciling', { reason: '参数确认已发出，正在核实视频生成状态' });
    task.confirmationDispatchAttempted = true; this.studio.save();
    if (!(await clickNamed(wc,[], 'chat_input_send_button')) && !(await clickNamed(wc,['发送','Send','发送消息','Send message']))) { wc.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' }); }
    return task;
  }
  async authorizeTask(id, accepted, declaration) {
    this.authorizing ||= new Map();
    const pending = this.authorizing.get(id);
    if (pending) {
      if (pending.accepted !== accepted || pending.declaration !== declaration) throw new Error('该任务正在处理另一份授权决定，请等待其完成');
      return pending.promise;
    }
    const promise = this.applyTaskAuthorization(id, accepted, declaration);
    this.authorizing.set(id, { promise, accepted, declaration });
    try { return await promise; }
    finally { this.authorizing.delete(id); }
  }
  async applyTaskAuthorization(id, accepted, declaration) {
    const task=this.studio.find('tasks',id); if(task.authorizationDecisionAt && !task.authorizationRequired)return task;
    if(typeof accepted!=='boolean' || !task.authorizationRequired)throw new Error('没有等待本人确认的素材授权声明');
    const win=await this.openAccount(task.accountId,{visible:false}),wc=win.webContents;
    let page=await wc.executeJavaScript(`(${pageProbe.toString()})()`);
    let view=await wc.executeJavaScript(`(${taskView.toString()})(${JSON.stringify(task.prompt)},${JSON.stringify(task.remote?.conversationId)})`);
    if(declaration!==task.authorizationText)throw new Error('声明内容已改变，请重新确认');
    if (!page.buttons.some(b => b.testId === 'safety_authorization_confirm_btn') && view.matched) {
      if (!accepted) throw new Error('原提示词已出现在平台消息中，保留原提交待核实，不能作为未提交取消');
      task.authorizationDecisionAt=Date.now();task.authorizationAccepted=true;task.authorizationRequired=false;
      this.studio.find('attempts',task.attemptId).phase='uncertain';
      this.studio.transition(task,'reconciling',{reason:'已发现原任务消息，继续核实原生成，不重新准备或发送'});return task;
    }
    if(!page.buttons.some(b=>b.testId==='safety_authorization_confirm_btn') && task.authorizationEvidence==='editor_not_message' && !task.submitIntentAt) {
      if(!accepted){this.studio.find('attempts',task.attemptId).phase='released';task.authorizationDecisionAt=Date.now();task.authorizationAccepted=false;task.authorizationRequired=false;this.studio.transition(task,'cancelled',{reason:'本人暂未同意素材声明，本次尚未生成'});return task;}
      // 重启会关闭尚未提交的弹窗；已有明确未提交证据，收到本人同意后重新准备同一任务。
      this.studio.transition(task,'preparing',{prepared:null,authorizationRequired:false});
      const result=await this.prepare(structuredClone(task),structuredClone(this.studio.find('accounts',task.accountId)));
      if(task.status==='preparing' && result.status!=='reconciling') {
        if(task.reviewBeforeSend && task.prepared?.videoModeSelected && task.prepared.promptFilled && task.prepared.filesUploaded === task.refs?.length) await this.submitPrepared(task.id);
        else {this.studio.transition(task,'awaiting_confirmation',{authorizationRequired:true,reason:result.reason});return task;}
      }
      for (let i=0;i<20;i++) {
        await sleep(250);page=await wc.executeJavaScript(`(${pageProbe.toString()})()`);view=await wc.executeJavaScript(`(${taskView.toString()})(${JSON.stringify(task.prompt)},${JSON.stringify(task.remote?.conversationId)})`);
        if(page.buttons.some(b=>b.testId==='safety_authorization_confirm_btn') || view.matched)break;
      }
      if(!page.buttons.some(b=>b.testId==='safety_authorization_confirm_btn')) { task.authorizationDecisionAt=Date.now();task.authorizationAccepted=true;task.authorizationRequired=false;this.studio.save();return task; }
    }
    if(!page.buttons.some(b=>b.testId==='safety_authorization_confirm_btn') || !view.promptInEditor || view.matched)throw new Error('授权弹窗或未提交证据已改变，请重新核对');
    if(!page.text.replace(/\s+/g,'').includes(declaration.replace(/\s+/g,''))) {
      task.authorizationText=page.text.slice(page.text.lastIndexOf('安全确认')).replace(/\s*取消\s*确认\s*$/,'').trim();task.authorizationRequired=true;task.submitIntentAt=null;this.studio.find('attempts',task.attemptId).phase='reserved';this.studio.transition(task,'awaiting_confirmation',{reason:'平台声明内容已改变，请重新确认'});throw new Error('声明内容已改变，请重新确认');
    }
    task.authorizationDecisionAt=Date.now();task.authorizationAccepted=accepted;task.authorizationRequired=false;this.studio.save();
    if (accepted) {
      this.studio.find('attempts',task.attemptId).phase='uncertain';
      this.studio.transition(task,'reconciling',{submitIntentAt:task.submitIntentAt||Date.now(),reason:'本人已确认素材声明，正在提交原任务'});
    }
    const clicked=await clickNamed(wc,[],accepted?'safety_authorization_confirm_btn':'safety_authorization_reject_btn');
    if(!clicked) {task.authorizationRequired=true;delete task.authorizationDecisionAt;this.studio.save();throw new Error('未明确识别授权按钮，本次没有继续');}
    if(accepted)this.studio.transition(task,'reconciling',{reason:'本人已确认素材声明，正在核实平台接受状态'});
    else {this.studio.find('attempts',task.attemptId).phase='released';this.studio.transition(task,'cancelled',{reason:'本人暂未同意素材授权声明，本次尚未生成',submissionNotSentEvidence:'授权弹窗阻止发送，提示词仍在编辑框且不在消息中'});}
    return task;
  }
  async readDolaCompletion(id, { expectedVid } = {}) {
    const task = this.studio.find('tasks', id), account = this.studio.find('accounts', task.accountId);
    if (task.platform !== 'dola' || !task.submitIntentAt || !/^\d{5,30}$/.test(task.remote?.conversationId || '')) return { matched: false };
    if (account.login === 'login_required') return { matched: false, code: 'login_required', reason: 'Dola当前未登录，请重新导入有效Cookie或在项目中登录；原任务与额度记录保留，不自动重生成' };
    if (this.cookieAccounts.changing?.has(account.id)) return { matched: false, code: 'login_checking', reason: 'Dola正在更新或检查登录会话，完成后继续核对原作品' };
    this.completionReading ||= new Set(); this.completionWindows ||= new Map();
    if (this.completionReading.has(account.id)) return { matched: false, reason: '后台正在核对原会话' };
    this.completionReading.add(account.id); let win;
    try {
      // A separate hidden reader leaves the submission page and any streaming reply undisturbed.
      await this.cookieAccounts.restore(account.id);
      win = this.completionWindows.get(account.id);
      if (!win || win.isDestroyed()) {
        const isolated = this.electron.session.fromPartition(`persist:studio-${account.platform}-${account.id}`);
        win = new this.electron.BrowserWindow({ width: 1200, height: 860, show: false, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        this.completionWindows.set(account.id, win);
        win.on('closed', () => { if (this.completionWindows.get(account.id) === win) this.completionWindows.delete(account.id); });
        // Start the renderer before attaching CDP; Network.enable otherwise waits for the first navigation.
        await boundedRead(() => win.loadURL('about:blank'));
      }
      const result = await inspectDolaCompletion(win, task, () => loadAccountPage(win, PLATFORMS.dola.url + task.remote.conversationId, 18000), { expectedVid });
      if (!result.matched) {
        if (/\/security\/region-|region-ban/.test(new URL(win.webContents.getURL()).pathname)) return { matched: false, code: 'region_restricted', reason: 'Dola提示受区域限制，请检查当前网络；保留原任务继续跟踪' };
        try {
          const page=await boundedRead(()=>win.webContents.executeJavaScript(`(${pageProbe.toString()})()`));
          if(new URL(page.url).hostname==='www.dola.com' && page.login){const reason='Dola当前未登录，请重新导入有效Cookie或在项目中登录；原任务与额度记录保留，不自动重生成';this.studio.setLogin(account.id,'login_required',reason);return {matched:false,code:'login_required',reason};}
        } catch {}
        return result;
      }
      let view;
      for (let i = 0; i < 20; i++) {
        view = await boundedRead(() => win.webContents.executeJavaScript(`(${taskView.toString()})(${JSON.stringify(task.prompt)},${JSON.stringify(task.remote.conversationId)})`));
        if (view.matched) break;
        await sleep(250);
      }
      return view?.matched ? { ...result, source: 'original_conversation_read' } : { matched: false, reason: '原会话作品未匹配完整任务提示词' };
    } catch (error) {
      if (win && !win.isDestroyed()) win.destroy();
      throw error;
    } finally { this.completionReading.delete(account.id); }
  }
  async refreshTask(id) {
    if (this.polling.has(id) || (this.pollAt.get(id) || 0) > Date.now()) return;
    const task = this.studio.find('tasks', id); if (!( ['running','reconciling'].includes(task.status) || task.platform === 'dola' && task.status === 'submission_review') || task.vid) return;
    this.polling.add(id); this.pollAt.set(id, Date.now() + 5000);
    try {
      if (task.platform === 'dola' && task.submitIntentAt && /^\d{5,30}$/.test(task.remote?.conversationId || '')) {
        this.completionPollAt ||= new Map();
        if ((this.completionPollAt.get(id) || 0) <= Date.now()) {
          this.completionPollAt.set(id, Date.now() + COMPLETION_POLL_MS);
          let completion;
          try { completion = await this.readDolaCompletion(id); }
          catch { completion = { matched: false, reason: '后台作品核对失败，下次自动重试' }; }
          task.completionCheckedAt = Date.now(); task.completionCheckNote = completion.reason || null; this.studio.save();
          if (completion.code && !completion.matched) { this.studio.transition(task, task.status, { reason: completion.reason }); return; }
          if (completion.matched && !task.vid && ['running', 'reconciling', 'submission_review'].includes(task.status)) {
            this.studio.observe(task.accountId, { type: 'video', ...completion });
            this.studio.attachVideo(id, completion.vid, { platformCompletedAt: completion.platformCompletedAt });
            task.completionDetectionSource = completion.source || 'original_conversation_read'; this.studio.save();
            void this.studio.download(id); return;
          }
          if (task.vid || !['running', 'reconciling', 'submission_review'].includes(task.status)) return;
        }
      }
      if (task.status === 'submission_review' || this.studio.state.tasks.some(t => t.accountId === task.accountId && t.id !== task.id && ['preparing', 'awaiting_confirmation', 'running', 'reconciling', 'downloading'].includes(t.status))) return;
      const win = await this.openAccount(task.accountId, { visible: false });
      const view = await win.webContents.executeJavaScript(`(${taskView.toString()})(${JSON.stringify(task.prompt)},${JSON.stringify(task.remote?.conversationId)},${JSON.stringify(task.continuationPrompt)})`);
      if (!view.matched && view.promptInEditor) {
        const page=await win.webContents.executeJavaScript(`(${pageProbe.toString()})()`);
        if(page.buttons.some(b=>b.testId==='safety_authorization_confirm_btn')) {
          const text=page.text.slice(page.text.lastIndexOf('安全确认')).replace(/\s*取消\s*确认\s*$/,'').trim();
          const alreadyApproved = task.authorizationAccepted === true && task.authorizationText?.replace(/\s+/g,'') === text.replace(/\s+/g,'');
          if(task.authorizationText!==text || !task.authorizationRequired || task.authorizationEvidence!=='editor_not_message' || task.status!=='awaiting_confirmation') {
            if (!alreadyApproved) { task.authorizationAccepted = false; delete task.authorizationDecisionAt; }
            this.studio.find('attempts',task.attemptId).phase='reserved';
            this.studio.transition(task,'awaiting_confirmation',{authorizationRequired:true,authorizationText:text,authorizationEvidence:'editor_not_message',submitIntentAt:null,reason:'平台首次素材授权声明需要本人同意，目前尚未生成'});
          }
          if (alreadyApproved) await this.authorizeTask(id, true, text);
        }
      }
      if (!view.matched || view.promptInEditor) return;
      const conversationId = new URL(view.url).pathname.split('/').filter(Boolean).at(-1);
      if (!conversationId || conversationId === 'chat') return;
      if (!task.remote?.conversationId || task.remote.conversationId.startsWith('local_') && !conversationId.startsWith('local_')) { task.remote = {...task.remote,conversationId}; this.studio.save(); }
      const stage = generationStage(view.text);
      if(stage==='payment_confirmation'&&!task.parameterConfirmationAt&&this.studio.find('attempts',task.attemptId).phase!=='accepted') {
        this.studio.find('attempts',task.attemptId).phase='reserved';
        this.studio.transition(task,'awaiting_confirmation',{paymentRequired:true,providerPaymentFeedback:view.text,previousChatSubmitIntentAt:task.submitIntentAt,submitIntentAt:null,prepared:null,submissionNotSentEvidence:'原任务页面明确要求先确认消耗付费额度，尚未点击确认生成',reason:'免费额度已用完；平台要求付费额度，等待本人确认，禁止自动确认或重新提交'});return;
      }
      if(stage==='parameter_plan' && !task.parameterConfirmationAt && this.studio.find('attempts',task.attemptId).phase!=='accepted') {
        this.studio.find('attempts',task.attemptId).phase='reserved';
        this.studio.transition(task,'awaiting_confirmation',{reason:'平台要求确认分段方案，与单次30秒任务不同；尚未确认生成',parameterProposal:view.text,previousChatSubmitIntentAt:task.submitIntentAt,submitIntentAt:null,prepared:null,submissionNotSentEvidence:'平台在当前任务回复中要求先确认分段方案；未发送确认，尚未生成视频'});return;
      }
      if (stage === 'confirm_parameters' && task.parameterConfirmationAt && !task.confirmationDispatchAttempted && view.continuationInEditor && !view.continuationInMessages) {
        // 旧版本键盘确认仍完整保留在编辑框且不在消息中：只推进这条既有意图一次，不重填或重建任务。
        task.confirmationDispatchAttempted = true; this.studio.save();
        await clickNamed(win.webContents,[], 'chat_input_send_button'); return;
      }
      if (stage === 'confirm_parameters' && !task.parameterConfirmationAt) await this.confirmParameters(id);
      else if (stage === 'generating' && task.status === 'reconciling') {
        if(task.platform==='dola') {
          if(task.generationEvidence!=='chat_feedback_only' || task.providerGenerationFeedback!==view.text)this.studio.transition(task,'reconciling',{generationEvidence:'chat_feedback_only',providerGenerationFeedback:view.text,reason:'Dola仅返回文字等待回复，尚未取得真实作品；保留预算，不重复生成'});
        } else {this.studio.accepted(task,task.remote);if(doubaoQuota.recordFeedback(this.studio.find('accounts',task.accountId),task,this.studio.find('attempts',task.attemptId),view.text,Date.now()))this.studio.save();}
        await win.webContents.executeJavaScript(durationScript(null));
      }
      else if (stage === 'quota' && this.studio.find('attempts', task.attemptId).phase !== 'accepted') {
        task.providerQuotaFeedback=view.text;
        if(task.platform==='doubao')doubaoQuota.recordFeedback(this.studio.find('accounts',task.accountId),task,this.studio.find('attempts',task.attemptId),view.text,Date.now());
        task.quotaRejectedAt=Date.now();
        this.studio.save();
        this.studio.reject(task, 'quota', '平台明确拒绝：额度不足，自动切换同平台账号');
      }
      else if (stage === 'failed') {
        if (task.parameterConfirmationAt || task.platform==='dola' && task.submitIntentAt) this.studio.find('attempts', task.attemptId).phase = 'accepted';
        this.studio.reject(task, 'generation', '平台报告视频生成失败，保留提交次数，不重复生成');
      }
    } catch (e) {
      if (['running','reconciling'].includes(task.status) && task.reason !== e.message) this.studio.transition(task, task.status, { reason: e.message });
    } finally { this.polling.delete(id); }
  }
  async download(task, account) {
    const recovered = this.studio.find('tasks', task.id).recoveredDownload;
    if (task.platform === 'doubao' && recovered?.vid === task.vid && recovered.file === path.join(this.studio.directory, 'outputs', `doubao-${task.id}-resumed.mp4`) && fs.existsSync(recovered.file)) {
      const info = await videoInfo(recovered.file), original = this.studio.find('tasks', task.id);
      original.actualDuration = info.duration; original.mediaInfo = info; original.downloadMethod = 'resumed_platform_source';
      if (task.duration && Math.abs(info.duration - task.duration) > 1 / info.fps + .002) { original.durationMismatch = true; original.parameterReview = `实际${info.duration.toFixed(3)}秒与请求${task.duration}秒不一致，保留结果不重生成`; }
      this.studio.save(); return { file: recovered.file, mediaInfo: info };
    }
    if(account.platform==='dola' && account.login==='login_required')throw problem('login_required','Dola当前未登录，请导入有效Cookie或重新登录；保留原作品，恢复后继续下载');
    const win = await this.openAccount(account.id, { visible: false });
    if(account.platform==='dola') {
      if(this.studio.state.tasks.some(t=>t.accountId===account.id&&t.id!==task.id&&['preparing','awaiting_confirmation','running','reconciling'].includes(t.status)))throw problem('account_busy','账号有其他生成任务，完成后自动下载原作品');
      const wc=win.webContents,conversation=task.remote?.conversationId;
      if(!/^[\w-]{1,160}$/.test(conversation||''))throw new Error('原作品缺少可核对的会话记录');
      if(wc.getURL()!==PLATFORMS.dola.url+conversation)await this.inspectOptions(account.id,{kind:'conversation_reload',taskId:task.id});
      const health=await boundedRead(()=>wc.executeJavaScript(`(${pageProbe.toString()})()`));
      if(/\/security\/region-|region-ban/.test(new URL(health.url).pathname))throw problem('region_restricted','Dola提示受区域限制，请恢复可用网络后检测登录；保留原作品');
      if(health.login){this.studio.setLogin(account.id,'login_required','Dola当前未登录，请重新导入有效Cookie或登录');throw problem('login_required','Dola当前未登录，请重新导入有效Cookie或登录；恢复后继续下载原作品');}
      const view=await wc.executeJavaScript(`(${taskView.toString()})(${JSON.stringify(task.prompt)},${JSON.stringify(conversation)})`);
      if(!view.matched)throw new Error('原作品下载页面未匹配任务提示词');
      let page=await wc.executeJavaScript(`(${pageProbe.toString()})()`);
      if(!page.buttons.some(b=>b.testId==='edit_image_download_button')) {
        await this.inspectOptions(account.id,{kind:'video_preview',taskId:task.id});
        for(let i=0;i<20;i++){await sleep(500);page=await wc.executeJavaScript(`(${pageProbe.toString()})()`);if(page.buttons.some(b=>b.testId==='edit_image_download_button'))break;}
      }
      if(!page.buttons.some(b=>b.testId==='edit_image_download_button'))throw new Error('原作品尚未出现正式下载按钮');
      const file=path.join(this.studio.directory,'outputs',`dola-${task.id}-official.mp4`);
      try { await downloadFromButton(win,file,()=>clickNamed(wc,[],'edit_image_download_button'),{startTimeoutMs:120000,stallTimeoutMs:45000,onProgress:progress=>{const live=this.studio.find('tasks',task.id);if(!live.downloadProgress||progress.at-live.downloadProgress.at>=1000){live.downloadProgress=progress;this.studio.save();}}}); }
      catch(error){if(error.code==='download_start_timeout'&&!win.isDestroyed())win.destroy();throw error;}
      const info=await videoInfo(file),original=this.studio.find('tasks',task.id);
      original.actualDuration=info.duration;original.mediaInfo=info;original.downloadMethod='platform_download_button';
      if(task.duration&&Math.abs(info.duration-task.duration)>1/info.fps+.002){original.durationMismatch=true;original.parameterReview=`实际${info.duration.toFixed(3)}秒与请求${task.duration}秒不一致，保留结果不重生成`;}
      this.studio.save();return {file,mediaInfo:info};
    }
    const url = await win.webContents.executeJavaScript(account.platform==='dola'?dolaSourceScript(task):sourceScript(task.vid));
    const response = await win.webContents.session.fetch(url);
    if (!response.ok) throw new Error(`视频源下载失败：HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!/video|octet-stream/i.test(contentType)) throw new Error('下载源不是视频内容');
    const file = path.join(this.studio.directory, 'outputs', `${task.platform}-${task.id}.mp4`); const temp = `${file}.part`;
    const handle = fs.openSync(temp, 'w'); let bytes = 0;
    try { for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2 * 1024 ** 3) throw new Error('视频超过 2GB 下载限制'); fs.writeSync(handle, chunk); } }
    finally { fs.closeSync(handle); }
    if (bytes < 1000) throw new Error('视频源内容不完整');
    fs.renameSync(temp, file);
    const info = await videoInfo(file), original = this.studio.find('tasks', task.id);
    original.actualDuration = info.duration; original.mediaInfo = info;
    if (task.duration && Math.abs(info.duration - task.duration) > 1 / info.fps + .002) { original.durationMismatch = true; original.parameterReview = `实际${info.duration.toFixed(3)}秒与请求${task.duration}秒不一致，保留结果等待处理，不自动重生成`; }
    this.studio.save(); return { file, mediaInfo: info };
  }
}
module.exports = { PlatformAdapter, pageProbe, sourceScript, dolaSourceScript, videoPreviewTarget, isVideoMode, generationStage, chooseDuration, chooseRatio, taskView, loadAccountPage, namedTarget, dismissDesktopPromotion, activateVideoModeButton, dismissConversationModeMenu };
