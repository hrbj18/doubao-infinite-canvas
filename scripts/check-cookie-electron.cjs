// 使用临时独立会话和人工 Cookie 验证真实 Electron/Windows 加密；不连接平台、不读取用户凭据。
const { app, session, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { Studio } = require('../src/core.cjs');
const { CookieAccounts } = require('../src/account-cookies.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-native-cookie-'));
app.setPath('userData', path.join(root, 'browser'));
app.whenReady().then(async () => {
  const studio = new Studio(root);
  const adapter = { electron: { session, safeStorage }, windows: new Map(), probe: async id => { const a = studio.find('accounts',id); const cookies = await adapter.cookieAccounts.session(a).cookies.get({url:'https://www.dola.com/'}); assert.equal(cookies.find(c=>c.name==='sessionid').value,'synthetic-native-cookie-only'); studio.setLogin(id,'ready','人工 Cookie API 测试通过，非真实平台登录'); } };
  const login = new CookieAccounts(studio,adapter); adapter.cookieAccounts=login; studio.adapter=adapter;
  const result=await login.import({platform:'dola',name:'native test',dailyLimit:0,cookieText:'sessionid=synthetic-native-cookie-only; sessionid_ss=synthetic-native-cookie-only',idempotencyKey:'native-test'});
  while(login.changing.has(result.accountId)) await new Promise(resolve=>setTimeout(resolve,25));
  await login.flush(); const a=studio.find('accounts',result.accountId),ses=login.session(a);
  const bytes=fs.readFileSync(login.file(a.id)); assert.ok(!bytes.includes(Buffer.from('synthetic-native-cookie-only')));
  const watcher=login.watched.get(a.id); ses.cookies.removeListener('changed',watcher.listener);
  await ses.clearStorageData({storages:['cookies']}); assert.equal((await ses.cookies.get({url:'https://www.dola.com/'})).length,0);
  const restored=new CookieAccounts(studio,adapter); await restored.restore(a.id);
  const cookies=await ses.cookies.get({url:'https://www.dola.com/'}); assert.equal(cookies.find(c=>c.name==='sessionid').value,'synthetic-native-cookie-only'); assert.ok(cookies.every(c=>c.session && !c.expirationDate));
  await ses.cookies.remove('https://www.dola.com/','sessionid'); await ses.cookies.remove('https://www.dola.com/','sessionid_ss'); await restored.flush(); assert.equal(a.login,'login_required');
  const report={passed:true,systemEncryption:true,realSessionRestore:true,logoutPreserved:true,plaintextAbsent:true};
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report)); console.log(JSON.stringify(report)); app.quit();
}).catch(()=>{fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({passed:false}));console.error('真实 Electron Cookie/加密测试失败，凭据原文未输出');app.exit(1);});
