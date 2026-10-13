const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Studio, dayOf } = require('../src/core.cjs');
const immediate = () => new Promise(resolve => setImmediate(resolve));
test('登录失效暂停原作品下载，不耗尽重试；恢复登录只继续该下载，不提交新生成',async t=>{
  const f=fixture(t,{adapter:{download:async()=>{const error=new Error('Dola需要恢复登录');error.code='login_required';throw error;}}});
  const a=f.account('Dola','dola',2),task=f.studio.find('tasks',f.studio.submit({...f.input('recover-login'),platform:'dola'}).id);
  f.studio.reserve(task);f.studio.accepted(task,{conversationId:'38418113302312209'});f.studio.attachVideo(task.id,'original-video');
  await f.studio.download(task.id);
  assert.equal(task.downloadHold,true);assert.equal(task.downloadBlocker?.code,'login_required');assert.equal(task.retries||0,0);assert.equal(f.studio.usage(a.id).used,1);
  const watermarked={id:'watermarked',accountId:a.id,platform:'dola',status:'download_pending',downloadHold:true,localFile:'saved.mp4'};f.studio.state.tasks.push(watermarked);
  f.studio.setLogin(a.id,'login_required');assert.equal(task.downloadHold,true);
  f.studio.setLogin(a.id,'ready');assert.equal(task.downloadHold,false);assert.equal(task.downloadBlocker,null);assert.equal(watermarked.downloadHold,true);
  assert.equal(f.studio.state.attempts.length,1);assert.equal(f.studio.usage(a.id).used,1);
});
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-test-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'canvas-test-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const studio = new Studio(root, options); const imageFile = path.join(root, 'input.png'); fs.writeFileSync(imageFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCuoAAAAASUVORK5CYII=', 'base64'));
  const image = studio.registerAsset(imageFile); const project = studio.createProject('test');
  const input = key => ({ projectId: project.id, platform: 'doubao', mode: 'references', prompt: '小猫缓缓举剑', refs: [{ assetId: image.id, role: 'reference' }], idempotencyKey: key });
  const account = (name, platform = 'doubao', dailyLimit = 1) => { const a = studio.addAccount({ name, platform, dailyLimit }); studio.setLogin(a.id, 'ready'); return a; };
  return { studio, image, project, input, account, root };
}

test('付费确认等待跨重启保留原会话与原因，不自动重新准备或生成',async t=>{
  let generated=0;const f=fixture(t,{adapter:{prepare:async()=>{generated++;}}});f.account('账号');
  const task=f.studio.find('tasks',f.studio.submit({...f.input('paid-review'),reviewBeforeSend:true}).id);f.studio.reserve(task);
  f.studio.transition(task,'awaiting_confirmation',{paymentRequired:true,submissionNotSentEvidence:'平台要求先确认付费',submitIntentAt:null,reason:'免费额度已用完，等待付费确认',remote:{conversationId:'original'}});
  const restored=new Studio(f.root,{adapter:{prepare:async()=>{generated++;}}});restored.recover();await restored.tick();
  const current=restored.find('tasks',task.id);assert.equal(current.status,'awaiting_confirmation');assert.equal(current.reason,'免费额度已用完，等待付费确认');assert.equal(current.remote.conversationId,'original');assert.equal(generated,0);
});

test('发送前审阅任务重启后保留预留次数，需要重新准备；未知提交仍保守核实',t=>{
  const f=fixture(t),a=f.account('Dola','dola');
  const first=f.studio.submit({...f.input('review-restart'),platform:'dola',reviewBeforeSend:true});
  const task=f.studio.find('tasks',first.id);f.studio.reserve(task);f.studio.transition(task,'awaiting_confirmation',{prepared:{promptFilled:true},submitIntentAt:null});
  let restored=new Studio(f.root);restored.recover();
  assert.equal(restored.find('tasks',task.id).status,'awaiting_confirmation');assert.equal(restored.find('tasks',task.id).prepared,null);assert.equal(restored.usage(a.id).reserved,1);
  const uncertain=restored.find('tasks',task.id);uncertain.submitIntentAt=Date.now();restored.save();
  restored=new Studio(f.root);restored.recover();assert.equal(restored.find('tasks',task.id).status,'reconciling');assert.equal(restored.usage(a.id).reserved,1);
});
test('三账号各一并发：预留阻止超分配，第四个任务等待', async t => {
  const f = fixture(t, { adapter: { prepare: async () => new Promise(() => {}) } });
  for (let i = 0; i < 3; i++) f.account('账号' + i);
  for (let i = 0; i < 4; i++) f.studio.submit(f.input('job-' + i));
  await f.studio.tick();
  assert.equal(f.studio.state.tasks.filter(x => x.status === 'preparing').length, 3);
  assert.equal(new Set(f.studio.state.tasks.slice(0, 3).map(x => x.accountId)).size, 3);
  assert.equal(f.studio.state.tasks[3].status, 'waiting_account');
  for (const a of f.studio.snapshot().accounts) assert.deepEqual([a.usage.reserved, a.usage.available], [1, 0]);
});
test('国内任务不借用海外账号，优选账号不可用时自动换同平台账号', async t => {
  const f = fixture(t, { adapter: { prepare: async () => ({ status: 'accepted', remote: { messageId: 'test' } }) } });
  const unavailable = f.account('预算为零', 'doubao', 0), usable = f.account('国内'), overseas = f.account('海外', 'dola');
  const task = f.studio.submit({ ...f.input('fallback'), accountId: unavailable.id }); await f.studio.tick(); await immediate();
  assert.equal(f.studio.find('tasks', task.id).accountId, usable.id); assert.equal(f.studio.usage(overseas.id).used, 0);
});
test('额度拒绝释放预留并自动换账号，不重复扣次数', async t => {
  const f = fixture(t); const a = f.account('无真实额度'), b = f.account('有额度');
  f.studio.adapter = { prepare: async (_task, account) => { if (account.id === a.id) { const e = new Error('额度不足'); e.code = 'quota'; throw e; } return { status: 'accepted' }; } };
  const task = f.studio.submit(f.input('quota')); await f.studio.tick(); await immediate(); await f.studio.tick(); await immediate();
  assert.equal(f.studio.find('tasks', task.id).accountId, b.id); assert.equal(f.studio.usage(a.id).reserved, 0); assert.equal(f.studio.usage(b.id).used, 1); assert.ok(f.studio.find('accounts', a.id).blockedUntil > Date.now());
});
test('幂等键防止重复提交，并拒绝同键不同参数', t => {
  const f = fixture(t); const first = f.studio.submit(f.input('same')); assert.equal(f.studio.submit(f.input('same')).id, first.id); assert.equal(f.studio.state.tasks.length, 1);
  assert.throws(() => f.studio.submit({ ...f.input('same'), prompt: '另一段视频' }), /不同任务参数/);
});
test('重启和跨日不会释放未知提交的预算或重复生成', async t => {
  let time = Date.parse('2026-10-08T23:59:00+08:00'); const f = fixture(t, { clock: () => time, adapter: { prepare: async () => new Promise(() => {}) } }); const a = f.account('测试');
  const task = f.studio.submit(f.input('restart')); await f.studio.tick(); time += 120000;
  const restored = new Studio(f.root, { clock: () => time }); restored.recover();
  assert.equal(dayOf(time), '2026-10-09'); assert.equal(restored.find('tasks', task.id).status, 'reconciling'); assert.equal(restored.usage(a.id).reserved, 1); assert.equal(restored.usage(a.id).available, 0);
  assert.throws(() => restored.cancel(task.id), /核实/);
});
test('首尾帧要求明确两个角色，不把参考图模式默默降级', t => {
  const f = fixture(t); assert.throws(() => f.studio.submit({ ...f.input('frames'), mode: 'first_last' }), /首尾帧/);
  const task = f.studio.submit({ ...f.input('frames-ok'), mode: 'first_last', refs: [{ assetId: f.image.id, role: 'first' }, { assetId: f.image.id, role: 'last' }] }); assert.equal(task.mode, 'first_last');
});
test('下载失败只重试下载；下载源未验证水印时不标记完成', async t => {
  const f = fixture(t); let generations = 0, downloads = 0; const a = f.account('测试');
  f.studio.adapter = { prepare: async () => { generations++; return { status: 'accepted' }; }, download: async () => { downloads++; if (downloads === 1) throw new Error('网络失败'); const file = path.join(f.root, 'source.mp4'); fs.writeFileSync(file, Buffer.alloc(1100)); return { file }; } };
  const task = f.studio.submit(f.input('video')); await f.studio.tick(); await immediate(); f.studio.attachVideo(task.id, 'verified-video-id'); await f.studio.download(task.id);
  assert.equal(f.studio.find('tasks', task.id).status, 'download_pending'); f.studio.retryDownload(task.id); await f.studio.download(task.id);
  assert.equal(generations, 1); assert.equal(downloads, 2); assert.equal(f.studio.usage(a.id).used, 1); assert.ok(f.studio.find('tasks', task.id).localFile); assert.equal(f.studio.find('tasks', task.id).status, 'download_pending');
  f.studio.verifyDownload(task.id, true); assert.equal(f.studio.find('tasks', task.id).status, 'done');
  f.studio.retryDownload(task.id); await f.studio.download(task.id);
  const current = f.studio.find('tasks', task.id), nodes = f.studio.find('projects', f.project.id).nodes.filter(n => n.taskId === task.id);
  assert.equal(nodes.length, 1); assert.equal(nodes[0].assetId, current.outputAssetId);
});
test('项目保存校验失败时不留下部分变更', t => {
  const f = fixture(t), before = structuredClone(f.studio.find('projects', f.project.id));
  assert.throws(() => f.studio.saveProject(f.project.id, { name: '无效改动', nodes: [{ id: '<invalid>', type: 'image', x: 0, y: 0 }] }), /ID/);
  assert.deepEqual(f.studio.find('projects', f.project.id), before);
});
test('项目版本核验防止 MCP 覆盖画布上的新修改', t => {
  const f = fixture(t); f.studio.saveProject(f.project.id, { name: '新版', expectedRevision: 0 }); assert.throws(() => f.studio.saveProject(f.project.id, { name: '旧版', expectedRevision: 0 }), /其他调用/); assert.equal(f.studio.find('projects', f.project.id).name, '新版');
});
test('平台在准备过程中确认任务，返回时不覆盖已进入的生成状态', async t => {
  const f = fixture(t); f.account('测试');
  f.studio.adapter = { prepare: async task => { f.studio.accepted(f.studio.find('tasks', task.id), { conversationId: 'actual' }); return { status: 'reconciling' }; } };
  const task = f.studio.submit(f.input('async-accepted')); await f.studio.tick(); await immediate();
  assert.equal(f.studio.find('tasks', task.id).status, 'running');
});
