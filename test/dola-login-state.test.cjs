const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlatformAdapter } = require('../src/platform.cjs');
test('已确认未登录时，下载立即暂停且不打开或重载平台窗口',async()=>{
  const task={id:'task',platform:'dola',accountId:'account',vid:'original-video'},adapter=Object.create(PlatformAdapter.prototype);
  adapter.studio={find:()=>task};adapter.openAccount=async()=>{throw new Error('不应打开未登录窗口');};
  await assert.rejects(()=>adapter.download(structuredClone(task),{id:'account',platform:'dola',login:'login_required'}),error=>error.code==='login_required');
});
test('已确认未登录的Dola账号立即提示恢复登录，不重读原会话直到超时', async () => {
  const task={id:'task',accountId:'account',platform:'dola',submitIntentAt:1,remote:{conversationId:'38418113302312209'}},account={login:'login_required'};
  const adapter=Object.create(PlatformAdapter.prototype);let restores=0;
  adapter.studio={find:type=>type==='tasks'?task:account};
  adapter.cookieAccounts={restore:async()=>{restores++;throw new Error('不应重复等待网络读取');}};
  const result=await adapter.readDolaCompletion(task.id);
  assert.equal(result.matched,false);assert.equal(result.code,'login_required');assert.match(result.reason,/登录/);assert.equal(restores,0);
  assert.equal(task.submitIntentAt,1);
});
