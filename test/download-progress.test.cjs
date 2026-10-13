const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlatformAdapter } = require('../src/platform.cjs');
const os = require('node:os');

test('国内原作品下载进度只读文件头，不取回视频正文、不提交生成、不输出源地址', async () => {
  const task = { id: 'task', accountId: 'account', platform: 'doubao', vid: 'expected-vid', status: 'downloading', downloadStartedAt: Date.now() - 1000 };
  const adapter = Object.create(PlatformAdapter.prototype); let reads = 0;
  adapter.studio = { directory: os.tmpdir(), find: type => type === 'tasks' ? task : { platform: 'doubao' } };
  adapter.openAccount = async () => ({ isVisible: () => false, webContents: {
    executeJavaScript: async script => { assert.ok(script.includes('expected-vid')); return 'https://media.example/private'; },
    session: { fetch: async (_url, options) => { assert.equal(options.method, 'HEAD'); reads++; return { ok: true, headers: new Headers({ 'content-length': '40000000', 'content-type': 'video/mp4' }) }; } }
  } });
  const result = await adapter.inspectOptions('account', { kind: 'download_progress', taskId: 'task' });
  assert.equal(result.bytesTotal, 40000000); assert.equal(result.readOnly, true); assert.equal(result.generationSubmitted, false); assert.equal(reads, 1);
  assert.equal(JSON.stringify(result).includes('https:'), false);
});

test('下载进度拒绝其他账号的作品，不探测无视频任务', async () => {
  const adapter = Object.create(PlatformAdapter.prototype);
  adapter.studio = { find: () => ({ accountId: 'other', platform: 'doubao', vid: 'vid' }) };
  adapter.openAccount = async () => { throw new Error('不得探测其他账号'); };
  await assert.rejects(() => adapter.inspectOptions('account', { kind: 'download_progress', taskId: 'task' }), /原作品/);
});
