const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { Studio, dayOf } = require('../src/core.cjs');
const { CookieAccounts, parseCookies } = require('../src/account-cookies.cjs');
const { loadAccountPage } = require('../src/platform.cjs');
const secret = 'synthetic-login-secret-never-real-credentials';
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-cookie-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'canvas-cookie-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const studio = new Studio(root), sessions = new Map(), key = crypto.randomBytes(32);
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async text => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
    decryptStringAsync: async data => { const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0,12)); decipher.setAuthTag(data.subarray(12,28)); return { result: Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString() }; }
  };
  const electron = { safeStorage, session: { fromPartition: partition => {
    if (!sessions.has(partition)) {
      const cookies = new EventEmitter(); cookies.items = [];
      cookies.get = async filter => cookies.items.filter(c => !filter.url || new URL(filter.url).hostname === c.domain.replace(/^\./,'') || !c.hostOnly && new URL(filter.url).hostname.endsWith('.' + c.domain.replace(/^\./,'')));
      cookies.set = async d => { if (cookies.failValue === d.value) throw new Error('simulated Electron error containing ' + d.value); const c = { ...d, domain: d.domain || new URL(d.url).hostname, hostOnly: !d.domain, session: !d.expirationDate }; cookies.items = cookies.items.filter(x=>!(x.name===c.name && x.domain===c.domain && x.path===c.path)); cookies.items.push(c); cookies.emit('changed',{},c,'explicit',false); };
      cookies.remove = async (url,name) => { const removed = cookies.items.filter(c=>c.name===name); cookies.items = cookies.items.filter(c=>c.name!==name); removed.forEach(c=>cookies.emit('changed',{},c,'explicit',true)); };
      cookies.flushStore = async () => {};
      sessions.set(partition, { cookies, clearStorageData: async () => { cookies.items=[]; } });
    } return sessions.get(partition);
  } } };
  const adapter = { electron, windows: new Map(), probe: async id => { studio.setLogin(id,'ready','test verified'); return {login:'ready'}; } };
  const accounts = new CookieAccounts(studio, adapter); adapter.cookieAccounts = accounts; studio.adapter = adapter;
  t.after(async () => { for (const timer of accounts.timers.values()) clearTimeout(timer); await Promise.all(accounts.writes.values()); });
  return { studio, accounts, adapter, electron, sessions, root };
}
const importInput = (extra = {}) => ({ platform:'dola',name:'测试 Cookie',dailyLimit:1,cookieText:'sessionid='+secret+'; sessionid_ss='+secret,idempotencyKey:'synthetic-import-1',...extra });
test('Cookie 文本提取唯一登录行，值中等号保留，没有到期信息时不伪造有效期', () => {
  const parsed = parseCookies('交付说明\n卡密：示例\nsessionid='+secret+'; extra=a=b=c','dola');
  assert.equal(parsed.cookies[1].value,'a=b=c'); assert.equal(parsed.summary.ignoredLines,2);
  assert.equal(parsed.summary.expiresAt,null); assert.equal(parsed.summary.unknownAuthExpiry,true);
  assert.ok(parsed.cookies.every(c=>!Object.hasOwn(c,'expirationDate') && !Object.hasOwn(c,'domain')));
});
test('Cookie-Editor JSON 保留域、路径、HttpOnly、SameSite 和原始 Unix 秒到期时间', () => {
  const expiry = Date.now()/1000 + 600;
  const parsed = parseCookies(JSON.stringify({cookies:[{name:'sessionid',value:secret,domain:'.dola.com',path:'/',secure:true,httpOnly:true,sameSite:'lax',expirationDate:expiry},{name:'other',value:'synthetic',domain:'www.dola.com',hostOnly:true,path:'/chat/',expires:-1}]}),'dola');
  assert.equal(parsed.cookies[0].expirationDate,expiry); assert.equal(parsed.cookies[0].domain,'.dola.com'); assert.equal(parsed.cookies[0].httpOnly,true); assert.equal(parsed.cookies[0].sameSite,'lax');
  assert.equal(parsed.summary.expiresAt,expiry*1000); assert.equal(parsed.summary.unknownAuthExpiry,false); assert.equal(parsed.cookies[1].domain,undefined);
});
test('错误域名、错误作用域、过期登录、多份 Cookie 和错误 JSON 被拒绝，错误不含凭据', () => {
  for (const text of [JSON.stringify([{name:'sessionid',value:secret,domain:'.dola.com.evil.example'}]),JSON.stringify([{name:'sessionid',value:secret,domain:'.doubao.com'}]),JSON.stringify([{name:'sessionid',value:secret,domain:'api.dola.com',hostOnly:true}]),JSON.stringify([{name:'sessionid',value:secret,domain:'.dola.com',expirationDate:1}]),'sessionid='+secret+'\nsessionid=second','[{"value":"'+secret+'",]','sessionid='+secret+'; Path=/; Secure']) {
    assert.throws(()=>parseCookies(text,'dola'),error=>!error.message.includes(secret));
  }
  assert.throws(()=>parseCookies('passport_csrf_token=synthetic','dola'));
});
test('新账号导入加密落盘、登录检测不提交视频、幂等重试不重复建账号', async t => {
  const {studio,accounts,root}=setup(t); const result=await accounts.import(importInput()); await accounts.check(result.accountId);
  const account=studio.find('accounts',result.accountId); assert.equal(account.login,'ready'); assert.equal(account.cookieLogin.checkState,'verified');
  assert.equal(studio.state.tasks.length,0); assert.equal(studio.state.attempts.length,0);
  assert.ok(!fs.readFileSync(path.join(root,'state.json'),'utf8').includes(secret)); assert.ok(!fs.readFileSync(accounts.file(account.id)).includes(Buffer.from(secret))); assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal((await accounts.import(importInput())).accountId,result.accountId); assert.equal(studio.state.accounts.length,1);
  await assert.rejects(()=>accounts.import(importInput({cookieText:'sessionid=different'})),/幂等键/);
  await assert.rejects(()=>accounts.import(importInput({idempotencyKey:'new-key-same-session'})),/已在账号池/);
  assert.equal(studio.snapshot().accounts[0].cookieLogin.importFingerprint,undefined);
  assert.equal(studio.snapshot().accounts[0].cookieLogin.authFingerprint,undefined);
});
test('更新 Cookie 保留预算与今日用量，检测期间阻止调度和再次更新，忙碌账号拒绝更新', async t => {
  const {studio,accounts,adapter}=setup(t); const a=studio.addAccount({name:'现有',platform:'dola',dailyLimit:3}); const stored=studio.find('accounts',a.id); stored.adjustments[dayOf()]=1; stored.login='ready'; studio.save();
  let release; adapter.probe=()=>new Promise(resolve=>release=resolve);
  await accounts.import(importInput({accountId:a.id})); assert.equal(accounts.changing.has(a.id),true); assert.equal(studio.candidates({platform:'dola'}).length,0);
  await assert.rejects(()=>accounts.import(importInput({accountId:a.id,idempotencyKey:'another'})),/正在更新/);
  assert.equal(studio.usage(a.id).used,1); assert.equal(stored.dailyLimit,3);
  release({login:'unknown'}); await new Promise(resolve=>setImmediate(resolve));
  studio.state.tasks.push({id:'busy',accountId:a.id,status:'downloading'});
  await assert.rejects(()=>accounts.import(importInput({accountId:a.id,idempotencyKey:'busy'})),/下载/);
});
test('系统加密不可用时拒绝导入且不留下新账号；会话写入失败回滚且不泄露 Electron 错误', async t => {
  const {studio,accounts,electron}=setup(t); electron.safeStorage.isAsyncEncryptionAvailable=async()=>false;
  await assert.rejects(()=>accounts.import(importInput()),e=>!e.message.includes(secret)); assert.equal(studio.state.accounts.length,0);
  electron.safeStorage.isAsyncEncryptionAvailable=async()=>true;
  const a=studio.addAccount({name:'原账号',platform:'dola'}),ses=accounts.session(a); await ses.cookies.set({url:'https://www.dola.com/',name:'sessionid',value:'old-synthetic-value',path:'/'}); ses.cookies.failValue=secret;
  await assert.rejects(()=>accounts.import(importInput({accountId:a.id})),e=>!e.message.includes(secret)); assert.equal((await ses.cookies.get({}))[0].value,'old-synthetic-value'); assert.equal(studio.find('accounts',a.id).cookieLogin,undefined);
});
test('无到期 Cookie 可从加密会话恢复；平台注销后保存空会话，重启不复活旧 Cookie', async t => {
  const {studio,accounts,adapter,electron,sessions}=setup(t); const result=await accounts.import(importInput()); await accounts.check(result.accountId); const a=studio.find('accounts',result.accountId);
  await accounts.flush(); sessions.clear(); const restored=new CookieAccounts(studio,adapter); await restored.restore(a.id);
  let all=await restored.session(a).cookies.get({}); assert.equal(all.find(c=>c.name==='sessionid').value,secret); assert.equal(all[0].hostOnly,true); assert.equal(all[0].expirationDate,undefined);
  await restored.session(a).cookies.remove('https://www.dola.com/','sessionid'); await restored.session(a).cookies.remove('https://www.dola.com/','sessionid_ss'); await restored.flush(); assert.equal(a.login,'login_required');
  sessions.clear(); const next=new CookieAccounts(studio,adapter); await next.restore(a.id); all=await next.session(a).cookies.get({}); assert.equal(all.length,0);
  for(const timer of restored.timers.values())clearTimeout(timer);
});
test('更新会话后重试旧导入键不会恢复旧凭据或重复建立账号，账号移除后也不复活', async t => {
  const {studio,accounts}=setup(t); const first=await accounts.import(importInput());
  while(accounts.changing.has(first.accountId))await new Promise(resolve=>setImmediate(resolve));
  await accounts.import(importInput({accountId:first.accountId,cookieText:'sessionid=synthetic-new-session',idempotencyKey:'update-session'}));
  while(accounts.changing.has(first.accountId))await new Promise(resolve=>setImmediate(resolve));
  const retried=await accounts.import(importInput()); assert.equal(retried.accountId,first.accountId); assert.equal(studio.state.accounts.length,1);
  assert.equal((await accounts.session(studio.find('accounts',first.accountId)).cookies.get({})).find(c=>c.name==='sessionid').value,'synthetic-new-session');
  await accounts.remove(first.accountId); await assert.rejects(()=>accounts.import(importInput()),/已移除/);
  assert.equal(fs.existsSync(accounts.file(first.accountId)),false);
});
test('登录页面 DOM 就绪即可检测，未完成的资源加载不阻塞；页面未就绪时有超时且清理监听', async () => {
  const webContents=new EventEmitter(); const win={webContents,loadURL:()=>{setImmediate(()=>webContents.emit('dom-ready'));return new Promise(()=>{});}};
  await loadAccountPage(win,'https://www.dola.com/chat/',1000); assert.equal(webContents.listenerCount('dom-ready'),0);
  win.loadURL=()=>new Promise(()=>{}); await assert.rejects(()=>loadAccountPage(win,'https://www.dola.com/chat/',5),/加载超时/); assert.equal(webContents.listenerCount('dom-ready'),0);
});
