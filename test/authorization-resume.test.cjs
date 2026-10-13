const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlatformAdapter } = require('../src/platform.cjs');

test('本人同意后，失效的授权弹窗能恢复已审阅原任务并确认一次', async () => {
  const declaration = '安全确认\n素材已获授权';
  const task = { id: 'task', accountId: 'account', attemptId: 'attempt', platform: 'doubao', prompt: '小猫举剑',
    status: 'awaiting_confirmation', reviewBeforeSend: true, refs: [{}, {}, {}], authorizationRequired: true,
    authorizationText: declaration, authorizationEvidence: 'editor_not_message', submitIntentAt: null };
  const attempt = { phase: 'reserved' };
  let popup = false, preparations = 0, sends = 0, clicks = 0;
  const adapter = Object.create(PlatformAdapter.prototype);
  Object.assign(adapter, {
    studio: { find: type => type === 'tasks' ? task : type === 'attempts' ? attempt : { id: 'account', platform: 'doubao' }, save() {}, transition: (t, status, patch) => Object.assign(t, patch, { status }) },
    openAccount: async () => ({ webContents: {
      executeJavaScript: async code => code.includes('function pageProbe') ? { buttons: popup ? [{ testId: 'safety_authorization_confirm_btn' }] : [], text: declaration }
        : code.includes('function taskView') ? { matched: false, promptInEditor: true } : { x: 10, y: 10 },
      sendInputEvent: event => { if (event.type === 'mouseUp') clicks++; }
    } }),
    prepare: async () => { preparations++; task.prepared = { videoModeSelected: true, promptFilled: true, filesUploaded: 3 }; return { reason: '素材与提示词已准备，等待本次发送前检查；尚未提交' }; },
    submitPrepared: async id => { assert.equal(id, task.id); sends++; popup = true; task.status = 'reconciling'; }
  });
  await adapter.authorizeTask(task.id, true, declaration);
  assert.equal(task.authorizationAccepted, true);
  assert.equal(task.authorizationRequired, false);
  assert.equal(task.status, 'reconciling');
  assert.equal(attempt.phase, 'uncertain'); assert.ok(task.submitIntentAt);
  assert.equal(preparations, 1); assert.equal(sends, 1); assert.equal(clicks, 1);
  await adapter.authorizeTask(task.id, true, declaration);
  assert.equal(sends, 1); assert.equal(clicks, 1);
});

test('授权弹窗已消失且原提示词已成为消息时，只核实原提交，不重新准备或发送', async () => {
  const task = { id: 'task', accountId: 'account', attemptId: 'attempt', prompt: '小猫举剑', authorizationRequired: true, authorizationText: '安全确认', authorizationEvidence: 'editor_not_message', submitIntentAt: null };
  const attempt = { phase: 'reserved' }, adapter = Object.create(PlatformAdapter.prototype);
  Object.assign(adapter, {
    studio: { find: type => type === 'tasks' ? task : attempt, save() {}, transition: (t, status, patch) => Object.assign(t, patch, { status }) },
    openAccount: async () => ({ webContents: { executeJavaScript: async code => code.includes('function pageProbe') ? { buttons: [] } : { matched: true, promptInEditor: false } } }),
    prepare: async () => { throw new Error('不得重新准备已发送的任务'); }
  });
  await adapter.authorizeTask(task.id, true, '安全确认');
  assert.equal(task.status, 'reconciling'); assert.equal(task.authorizationAccepted, true); assert.equal(attempt.phase, 'uncertain');
});

test('授权已记录但弹窗稍后才显示时，按原同意确认弹窗，不能直接跳过', async () => {
  const declaration = '安全确认\n素材已获授权';
  const task = { id: 'task', accountId: 'account', attemptId: 'attempt', prompt: '小猫举剑', status: 'awaiting_confirmation', authorizationRequired: true,
    authorizationText: declaration, authorizationAccepted: true, authorizationDecisionAt: Date.now() - 1000, submitIntentAt: null };
  const attempt = { phase: 'reserved' }; let clicks = 0;
  const adapter = Object.create(PlatformAdapter.prototype);
  Object.assign(adapter, {
    studio: { find: type => type === 'tasks' ? task : attempt, save() {}, transition: (t, status, patch) => Object.assign(t, patch, { status }) },
    openAccount: async () => ({ webContents: {
      executeJavaScript: async code => code.includes('function pageProbe') ? { buttons: [{ testId: 'safety_authorization_confirm_btn' }], text: declaration }
        : code.includes('function taskView') ? { matched: false, promptInEditor: true } : { x: 10, y: 10 },
      sendInputEvent: event => { if (event.type === 'mouseUp') clicks++; }
    } })
  });
  await adapter.authorizeTask(task.id, true, declaration);
  assert.equal(clicks, 1); assert.equal(task.status, 'reconciling'); assert.equal(task.authorizationRequired, false);
});

for (const changed of [false, true]) test(`延迟素材弹窗${changed ? '声明改变时保留待确认' : '沿用本人对同一声明的同意'}`, async () => {
  const declaration = '安全确认\n素材已获授权';
  const task = { id: 'task', accountId: 'account', attemptId: 'attempt', platform: 'doubao', prompt: '小猫举剑', status: 'reconciling', authorizationAccepted: true, authorizationDecisionAt: 1, authorizationText: declaration, submitIntentAt: 1 };
  const attempt = { phase: 'uncertain' }, adapter = Object.create(PlatformAdapter.prototype); let approvals = 0;
  Object.assign(adapter, {
    polling: new Set(), pollAt: new Map(),
    studio: { state: { tasks: [task] }, find: type => type === 'tasks' ? task : attempt, save() {}, transition: (t, status, patch) => Object.assign(t, patch, { status }) },
    openAccount: async () => ({ webContents: { executeJavaScript: async code => code.includes('function taskView') ? { matched: false, promptInEditor: true } : { buttons: [{ testId: 'safety_authorization_confirm_btn' }], text: declaration + (changed ? '\n新增义务' : '') + '\n取消\n确认' } } }),
    authorizeTask: async (id, accepted, text) => { assert.equal(id, task.id); assert.equal(accepted, true); assert.equal(text, declaration); approvals++; task.status = 'reconciling'; }
  });
  await adapter.refreshTask(task.id);
  assert.equal(approvals, changed ? 0 : 1);
  assert.equal(task.status, changed ? 'awaiting_confirmation' : 'reconciling');
  if (changed) assert.equal(task.authorizationAccepted, false);
});

test('并发恢复同一授权只确认一次，不重复触发平台操作', async () => {
  const adapter = Object.create(PlatformAdapter.prototype); let calls = 0, finish;
  adapter.applyTaskAuthorization = async () => { calls++; await new Promise(resolve => { finish = resolve; }); return 'accepted'; };
  const first = adapter.authorizeTask('task', true, '声明'), second = adapter.authorizeTask('task', true, '声明');
  finish(); assert.deepEqual(await Promise.all([first, second]), ['accepted', 'accepted']); assert.equal(calls, 1);
});
