const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isVideoMode, PlatformAdapter, generationStage } = require('../src/platform.cjs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const observer = require('../src/platform-observer.cjs');
const { Studio } = require('../src/core.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Dola明确需要12额度但仅剩2且无法生成时识别额度拒绝，不把普通费用提示当拒绝',()=>{
  assert.equal(generationStage('本次视频生成需要消耗12个视频生成额度，今日剩余2个视频生成额度，无法生成该视频。请尝试降低配置后重试。'),'quota');
  assert.equal(generationStage('本次视频生成需要消耗12个视频生成额度，今日剩余20个视频生成额度，预计等待10分钟。'),'generating');
});

test('Dola文字等待回复不等于真实生成任务，保留未知预算直到拿到作品',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-dola-evidence-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const studio=new Studio(root),project=studio.createProject();const file=path.join(root,'ref.png');fs.writeFileSync(file,'fixture');const image=studio.registerAsset(file);
  const account=studio.addAccount({name:'Dola',platform:'dola',dailyLimit:2});studio.setLogin(account.id,'ready');
  const task=studio.find('tasks',studio.submit({projectId:project.id,platform:'dola',duration:15,prompt:'小猫举剑',mode:'references',refs:[{assetId:image.id,role:'reference'}],idempotencyKey:'dola-15-proof'}).id);
  studio.reserve(task);studio.find('attempts',task.attemptId).phase='uncertain';studio.transition(task,'reconciling',{submitIntentAt:Date.now(),remote:{conversationId:'original'}});
  const adapter=Object.create(PlatformAdapter.prototype);Object.assign(adapter,{studio,polling:new Set(),pollAt:new Map(),openAccount:async()=>({webContents:{executeJavaScript:async code=>code.includes('function taskView')?{matched:true,promptInEditor:false,url:'https://www.dola.com/chat/original',text:'本次使用Dreamina Seedance 2.5生成，预计等待60分钟。'}:true}})});
  await adapter.refreshTask(task.id);assert.equal(task.status,'reconciling');assert.equal(task.generationEvidence,'chat_feedback_only');assert.equal(studio.usage(account.id).used,0);assert.equal(studio.usage(account.id).reserved,1);
  studio.attachVideo(task.id,'actual-dola-video');assert.equal(studio.usage(account.id).used,1);assert.equal(studio.find('tasks',task.id).status,'download_pending');
});

test('普通聊天页面也有视频入口，不能把入口文字当成已进入视频模式', () => {
  const page = { mode: '对话', text: '对话 图像生成 视频生成', buttons: [{ text: '视频生成', selected: false }] };
  assert.equal(isVideoMode(page), false);
  assert.equal(isVideoMode({ ...page, mode: '视频生成' }), true);
});

test('自动化复用登录窗口时隐藏窗口，用户主动打开才显示', async () => {
  const adapter = Object.create(PlatformAdapter.prototype); let visible = true;
  const win = { isDestroyed: () => false, hide: () => { visible = false; }, show: () => { visible = true; }, focus: () => {} };
  adapter.studio = { find: () => ({ id: 'account', platform: 'doubao' }) }; adapter.windows = new Map([['account', win]]);
  await adapter.openAccount('account', { visible: false }); assert.equal(visible, false);
  await adapter.openAccount('account'); assert.equal(visible, true);
});

test('观察视频提交响应关联原始提示词，读取历史不会计成新提交', async () => {
  const messages = [], prompt = '小猫轻轻举剑';
  const payload = { data: { conversation_id: 'conversation', message_id: 'message', creations: [{ video: { vid: 'new-video' } }] } };
  class XHR { send() {} addEventListener() {} }
  const context = vm.createContext({ window: { postMessage: value => messages.push(value.value), fetch: async () => ({ headers: { get: () => 'application/json' }, clone: () => ({ json: async () => payload }) }) }, location: { origin: 'https://www.doubao.com', pathname: '/chat/' }, document: { querySelectorAll: () => [{ getClientRects: () => [1], innerText: '视频生成' }] }, XMLHttpRequest: XHR, crypto: { randomUUID }, TextDecoder });
  vm.runInContext(observer, context);
  await context.window.fetch('/samantha/chat/completion', { body: JSON.stringify({ messages: [{ content: JSON.stringify({ text: prompt }) }], auth_token: 'DO-NOT-EMIT' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(messages.some(m => m.type === 'accepted' && m.prompts.includes(prompt)));
  assert.ok(messages.some(m => m.type === 'video' && m.vid === 'new-video' && m.prompts.includes(prompt)));
  assert.equal(JSON.stringify(messages).includes('DO-NOT-EMIT'), false);
  messages.length = 0;
  await context.window.fetch('/samantha/history'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.some(m => m.type === 'accepted'), false);
});

test('Dola 只有明确选中的视频模式才允许发送', () => {
  assert.equal(isVideoMode({ buttons: [{ text: 'Video generation', selected: false }] }), false);
  assert.equal(isVideoMode({ buttons: [{ text: 'Video generation', selected: true }] }), true);
});
test('豆包的参数确认不计成生成；真正的等待生成与额度拒绝分别处理', () => {
  assert.equal(generationStage('确认后我再开始生成视频。'), 'confirm_parameters');
  assert.equal(generationStage('确认后我再开始生成视频。本次使用 Seedance 2.0 Mini 生成，预计等待 5 分钟。'), 'generating');
  assert.equal(generationStage('每日免费额度已用完'), 'quota');
  assert.equal(generationStage('生成失败'), 'failed');
  assert.equal(generationStage('我会生成30秒。单次最高支持15秒。方案A：生成两段视频，每段15秒。确认后我直接生成两段。'),'parameter_plan');
  assert.equal(generationStage('方案A：一条15秒。方案B：两段连续视频。你回复A或B，我就直接生成。'),'parameter_plan');
});
test('后台轮询自动确认参数一次，收到生成等待反馈后才计次数', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-platform-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const studio = new Studio(directory), project = studio.createProject();
  const file = path.join(directory, 'sample.png'); fs.writeFileSync(file, 'fixture');
  const asset = studio.registerAsset(file), account = studio.addAccount({ name: 'test', platform: 'doubao' }); studio.setLogin(account.id, 'ready');
  const taskId = studio.submit({ projectId: project.id, platform: 'doubao', mode: 'references', refs: [{ assetId: asset.id, role: 'reference' }], prompt: '保持参考图角色，轻轻举剑', idempotencyKey: 'confirm-once' }).id;
  const task = studio.find('tasks', taskId); studio.reserve(task); studio.find('attempts', task.attemptId).phase = 'uncertain';
  studio.transition(task, 'reconciling', { remote: { conversationId: '123456' }, submitIntentAt: Date.now() });
  let sent = 0, response = '视频生成参数确认 模型：Seedance 2.0 Fast 时长：10 秒。确认后我再开始生成视频。';
  const adapter = Object.create(PlatformAdapter.prototype);
  Object.assign(adapter, { studio, polling: new Set(), pollAt: new Map(), openAccount: async (_id, options) => {
    assert.equal(options.visible, false);
    return { webContents: { executeJavaScript: async source => source.includes('function taskView') ? ({ matched: true, url: 'https://www.doubao.com/chat/123456', text: response, promptInEditor: false }) : true, insertText: text => assert.ok(text.includes('参考图')), sendInputEvent: event => { if (event.type === 'keyDown') { sent++; response = '本次使用 Seedance 2.0 Fast 生成，预计等待 5 分钟。'; } } } };
  } });
  await adapter.refreshTask(taskId); assert.equal(sent, 1); assert.equal(studio.usage(account.id).used, 0); assert.equal(studio.usage(account.id).reserved, 1);
  adapter.pollAt.set(taskId, 0); await adapter.refreshTask(taskId);
  assert.equal(task.status, 'running'); assert.equal(studio.usage(account.id).used, 1);
  adapter.pollAt.set(taskId, 0); await adapter.refreshTask(taskId); assert.equal(sent, 1);
});
