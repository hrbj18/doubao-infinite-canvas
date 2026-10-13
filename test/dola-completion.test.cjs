const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Studio } = require('../src/core.cjs');
const { PlatformAdapter } = require('../src/platform.cjs');
const { dolaCompletionMetadata, COMPLETION_POLL_MS, inspectDolaCompletion } = require('../src/platform-completion.cjs');
const { EventEmitter } = require('node:events');

test('Dola页面仍显示等待时，后台读取原会话的新作品并立即开始下载', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dola-completion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const studio = new Studio(root), project = studio.createProject();
  const account = studio.addAccount({ name: 'Dola', platform: 'dola', dailyLimit: 2 });
  studio.setLogin(account.id, 'ready');
  const ref = path.join(root, 'ref.png'); fs.writeFileSync(ref, 'fixture');
  const image = studio.registerAsset(ref);
  const task = studio.find('tasks', studio.submit({ projectId: project.id, platform: 'dola', mode: 'references', refs: [{ assetId: image.id, role: 'reference' }], duration: 30, prompt: '小猫举剑讨伐巨龙', idempotencyKey: 'completion-read-only' }).id);
  studio.reserve(task);
  studio.find('attempts', task.attemptId).phase = 'uncertain';
  studio.transition(task, 'reconciling', { submitIntentAt: Date.now() - 60000, remote: { conversationId: '38418113302312209' }, observationBaseline: ['old-video'] });
  let reads = 0, downloads = 0;
  studio.download = async id => { assert.equal(id, task.id); downloads++; };
  const adapter = Object.create(PlatformAdapter.prototype);
  Object.assign(adapter, {
    studio, polling: new Set(), pollAt: new Map(), completionPollAt: new Map(),
    openAccount: async () => ({ webContents: { executeJavaScript: async () => ({ matched: true, promptInEditor: false, url: 'https://www.dola.com/chat/38418113302312209', text: '本次生成预计等待60分钟。' }) } }),
    readDolaCompletion: async id => { assert.equal(id, task.id); reads++; return { matched: true, vid: 'finished-video', platformCompletedAt: Date.now() - 1000 }; }
  });
  await adapter.refreshTask(task.id);
  assert.equal(reads, 1, '等待页面也必须从服务端核对完成状态');
  assert.equal(task.vid, 'finished-video');
  assert.equal(downloads, 1, '发现作品后立即启动下载');
  assert.equal(studio.usage(account.id).used, 1);
  assert.ok(task.resultDetectedAt);
  assert.ok(task.platformCompletedAt);
});

function fixture(messages, conversationId = '38418113302312209') {
  return { downlink_body: { batch_get_conv_info_downlink_body: { conversation_info_list: [{ conversation_id: conversationId, messages }] } } };
}
const pending = { remote: { conversationId: '38418113302312209' }, submitIntentAt: 1791536314366, observationBaseline: ['old-video'] };
function message(vid = 'finished-video', at = '1791539559') {
  const video = { vid, duration: 30.08, width: 1280, height: 720, download_url: 'https://example.test/DO-NOT-EMIT' };
  return { conversation_id: pending.remote.conversationId, message_id: '1549071592947985', create_time: at,
    token: 'DO-NOT-EMIT', content: [{ content: { creation_block: { creations: [{ video }] } } }], content_block: [{ content: JSON.stringify({ video }) }] };
}
test('原会话异步视频消息提取成片时间，去重content副本且不输出正文和鉴权信息', () => {
  const result = dolaCompletionMetadata(fixture([message()]), pending);
  assert.equal(result.matched, true); assert.equal(result.vid, 'finished-video');
  assert.equal(result.platformCompletedAt, 1791539559000);
  assert.equal(JSON.stringify(result).includes('DO-NOT-EMIT'), false);
});
test('拒绝其他会话、提交前历史、旧vid、不完整作品和多个新vid', () => {
  assert.equal(dolaCompletionMetadata(fixture([message()], 'other-conversation'), pending), null);
  for (const messages of [[message('old-video')], [message('finished-video', '1791535000')], [message('first-new-video'), message('second-new-video')]]) {
    assert.equal(dolaCompletionMetadata(fixture(messages), pending).matched, false);
  }
  const incomplete = message(); delete incomplete.content[0].content.creation_block.creations[0].video.download_url; incomplete.content_block = [];
  assert.equal(dolaCompletionMetadata(fixture([incomplete]), pending).matched, false);
});
test('后台等待轮询间隔20秒，网络观察只读且结束后释放监听器', async () => {
  assert.equal(COMPLETION_POLL_MS, 20000);
  const debug = new EventEmitter(); let attached = false, disabled = false;
  debug.isAttached = () => attached; debug.attach = () => { attached = true; }; debug.detach = () => { attached = false; };
  debug.sendCommand = async name => {
    if (name === 'Network.disable') disabled = true;
    if (name === 'Network.getResponseBody') return { body: JSON.stringify(fixture([message()])) };
  };
  const result = await inspectDolaCompletion({ webContents: { debugger: debug } }, pending, async () => {
    debug.emit('message', {}, 'Network.responseReceived', { requestId: 'read', response: { url: 'https://www.dola.com/im/conversation/batch_get' } });
    debug.emit('message', {}, 'Network.loadingFinished', { requestId: 'read' });
  });
  assert.equal(result.matched, true); assert.equal(attached, false); assert.equal(disabled, true); assert.equal(debug.listenerCount('message'), 0);
});
test('会话读取超时仍保持未完成，不遗留网络监听或误报生成失败', async () => {
  const debug = new EventEmitter(); let attached = false;
  debug.isAttached = () => attached; debug.attach = () => { attached = true; }; debug.detach = () => { attached = false; };
  debug.sendCommand = async () => ({});
  const result = await inspectDolaCompletion({ webContents: { debugger: debug } }, pending, async () => {}, { timeoutMs: 5 });
  assert.equal(result.matched, false); assert.match(result.reason, /自动重试/);
  assert.equal(attached, false); assert.equal(debug.listenerCount('message'), 0);
});
test('5秒页面轮询不会反复重载平台；服务端核对按20秒限频', async () => {
  const task = { id: 'pending', status: 'reconciling', accountId: 'account', platform: 'dola', submitIntentAt: Date.now() - 60000, remote: { conversationId: '38418113302312209' }, prompt: '小猫举剑' };
  let reads = 0;
  const adapter = Object.create(PlatformAdapter.prototype);
  Object.assign(adapter, { polling: new Set(), pollAt: new Map(), completionPollAt: new Map(),
    studio: { find: () => task, state: { tasks: [task] }, save: () => {} },
    readDolaCompletion: async () => { reads++; return { matched: false }; },
    openAccount: async () => ({ webContents: { executeJavaScript: async () => ({ matched: true, text: '', url: 'https://www.dola.com/chat/38418113302312209' }) } }) });
  await adapter.refreshTask(task.id); adapter.pollAt.set(task.id, 0); await adapter.refreshTask(task.id);
  assert.equal(reads, 1);
  adapter.pollAt.set(task.id, 0); adapter.completionPollAt.set(task.id, 0); await adapter.refreshTask(task.id);
  assert.equal(reads, 2);
});

test('隐藏读取窗口先初始化渲染进程，再监听原会话；不会调用发送入口', async () => {
  const urls = []; let initialized = false, win;
  const task = { ...pending, id: 'task', accountId: 'account', platform: 'dola', prompt: '小猫举剑' };
  const debug = new EventEmitter(); let attached = false;
  debug.isAttached = () => attached;
  debug.attach = () => { assert.equal(initialized, true); attached = true; };
  debug.detach = () => { attached = false; };
  debug.sendCommand = async name => name === 'Network.getResponseBody' ? { body: JSON.stringify(fixture([message()])) } : {};
  const adapter = Object.create(PlatformAdapter.prototype);
  Object.assign(adapter, {
    studio: { find: (collection) => collection === 'tasks' ? task : { id: 'account', platform: 'dola' } },
    cookieAccounts: { restore: async () => {} },
    electron: { session: { fromPartition: value => { assert.equal(value, 'persist:studio-dola-account'); return {}; } }, BrowserWindow: class {
      constructor(options) {
        assert.equal(options.show, false); win = this;
        this.webContents = Object.assign(new EventEmitter(), { debugger: debug, setWindowOpenHandler: () => {}, executeJavaScript: async () => ({ matched: true }) });
      }
      isDestroyed() { return false; }
      on() {}
      async loadURL(url) {
        urls.push(url); initialized = true;
        if (url === 'about:blank') return;
        this.webContents.emit('dom-ready');
        debug.emit('message', {}, 'Network.responseReceived', { requestId: 'original', response: { url: 'https://www.dola.com/im/conversation/batch_get' } });
        debug.emit('message', {}, 'Network.loadingFinished', { requestId: 'original' });
      }
    } }
  });
  const result = await adapter.readDolaCompletion('task');
  assert.equal(result.matched, true); assert.equal(result.vid, 'finished-video');
  assert.deepEqual(urls, ['about:blank', 'https://www.dola.com/chat/38418113302312209']);
  assert.equal(win.webContents.debugger.isAttached(), false);
  assert.equal(adapter.completionReading.size, 0);
});

test('下载占用账号到文件保存；账号繁忙延迟下载不会耗尽失败重试', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-download-priority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1791539600000;
  const studio = new Studio(root, { clock: () => now }), project = studio.createProject();
  const account = studio.addAccount({ name: 'Dola', platform: 'dola', dailyLimit: 3 }); studio.setLogin(account.id, 'ready');
  const ref = path.join(root, 'ref.png'); fs.writeFileSync(ref, 'fixture'); const image = studio.registerAsset(ref);
  const input = key => ({ projectId: project.id, platform: 'dola', prompt: '小猫举剑', mode: 'references', refs: [{ assetId: image.id, role: 'reference' }], idempotencyKey: key });
  const task = studio.find('tasks', studio.submit(input('original')).id); studio.reserve(task); studio.transition(task, 'running'); studio.attachVideo(task.id, 'finished-video');
  const next = studio.find('tasks', studio.submit(input('next')).id);
  let finish;
  studio.adapter = { download: async () => { await new Promise(resolve => { finish = resolve; }); const file = path.join(root, 'video.mp4'); fs.writeFileSync(file, 'video'); now += 1000; return { file }; } };
  const operation = studio.download(task.id);
  assert.equal(studio.usage(account.id).busy, true); assert.equal(studio.reserve(next), false);
  finish(); await operation;
  assert.equal(task.downloadCompletedAt - task.downloadStartedAt, 1000);
  studio.adapter.download = async () => { const e = new Error('账号繁忙'); e.code = 'account_busy'; throw e; };
  studio.retryDownload(task.id);
  for (let i = 0; i < 4; i++) await studio.download(task.id);
  assert.equal(task.retries, 0); assert.equal(task.downloadHold, false);
  assert.equal(task.retryAt, now + 3000);
});
