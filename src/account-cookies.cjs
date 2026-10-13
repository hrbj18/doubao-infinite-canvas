const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PLATFORMS, assert } = require('./core.cjs');
const ROOTS = { doubao: 'doubao.com', dola: 'dola.com' };
const AUTH = /^(sessionid|sessionid_ss|session_id|__Secure-sessionid)$/i;
const MAX_BYTES = 256 * 1024;
const BUSY = new Set(['preparing', 'awaiting_confirmation', 'running', 'reconciling', 'downloading']);
function allowedDomain(domain, platform) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase(), root = ROOTS[platform];
  return !!root && (d === root || d.endsWith('.' + root));
}
function cookieDetails(c, platform) {
  let urlHost; if (c.url) { try { urlHost = new URL(c.url).hostname; } catch { throw new Error('Cookie URL 格式不正确'); } }
  const domain = c.domain || urlHost || new URL(PLATFORMS[platform].url).hostname;
  assert(allowedDomain(domain, platform), 'Cookie 域名与所选平台不一致');
  assert(typeof c.name === 'string' && /^[!#$%&'*+\-.^_`|~\w]+$/.test(c.name), 'Cookie 名称格式不正确');
  assert(typeof c.value === 'string' && !/[\x00-\x20\x7f;]/.test(c.value) && Buffer.byteLength(c.name + c.value) <= 4096, 'Cookie 值格式不正确或过长');
  const cookiePath = c.path ?? '/';
  assert(typeof cookiePath === 'string' && cookiePath.startsWith('/') && !/[\x00-\x20\x7f?#]/.test(cookiePath), 'Cookie 路径格式不正确');
  const host = domain.replace(/^\./, '').toLowerCase();
  assert(/^[a-z0-9.-]+$/.test(host), 'Cookie 域名格式不正确');
  if (c.url !== undefined) { let u; try { u = new URL(c.url); } catch { throw new Error('Cookie URL 格式不正确'); } assert(u.protocol === 'https:' && allowedDomain(u.hostname, platform) && (u.hostname === host || u.hostname.endsWith('.' + host)), 'Cookie URL 与域名不一致'); }
  const d = { url: `https://${host}${cookiePath}`, name: c.name, value: c.value, path: cookiePath, secure: c.secure !== false, httpOnly: c.httpOnly === true };
  if (c.hostOnly !== true && c.domain) d.domain = domain.toLowerCase();
  const sameSite = { no_restriction: 'no_restriction', none: 'no_restriction', lax: 'lax', strict: 'strict', unspecified: 'unspecified' }[String(c.sameSite || 'unspecified').toLowerCase()];
  assert(sameSite, 'Cookie SameSite 格式不正确'); d.sameSite = sameSite;
  if (sameSite === 'no_restriction') assert(d.secure, 'SameSite=None 的 Cookie 必须启用 Secure');
  const expiry = c.expirationDate ?? c.expires;
  if (expiry !== undefined && expiry !== null && expiry !== -1 && c.session !== true) {
    assert(typeof expiry === 'number' && Number.isFinite(expiry) && expiry > 0, 'Cookie 到期时间必须是 Unix 秒数'); d.expirationDate = expiry;
  }
  return d;
}
function summarize(cookies, now = Date.now()) {
  const auth = cookies.filter(c => AUTH.test(c.name));
  const known = auth.filter(c => c.expirationDate).map(c => c.expirationDate * 1000);
  return { count: cookies.length, sessionCount: cookies.filter(c => !c.expirationDate).length, expiresAt: known.length ? Math.min(...known) : null, unknownAuthExpiry: auth.some(c => !c.expirationDate), expired: auth.length > 0 && auth.every(c => c.expirationDate && c.expirationDate * 1000 <= now) };
}
function authFingerprint(cookies, platform) {
  const host = new URL(PLATFORMS[platform].url).hostname;
  const auth = cookies.filter(c => AUTH.test(c.name) && c.path === '/' && (new URL(c.url).hostname === host || c.domain && host.endsWith('.' + c.domain.replace(/^\./,''))));
  const primary = auth.find(c => c.name === 'sessionid') || auth.find(c => c.name === 'sessionid_ss') || auth[0];
  return primary ? createHash('sha256').update(platform + '|' + primary.value).digest('hex') : null;
}
function parseCookies(text, platform, now = Date.now()) {
  assert(PLATFORMS[platform], '请选择豆包或 Dola 平台');
  assert(typeof text === 'string' && text.trim() && Buffer.byteLength(text) <= MAX_BYTES, 'Cookie 不能为空，且不得超过 256KB');
  const clean = text.replace(/^\uFEFF/, '').trim(); let raw, format, ignoredLines = 0;
  if (/^[\[{]/.test(clean)) {
    let json; try { json = JSON.parse(clean); } catch { throw new Error('Cookie JSON 无法解析，请检查导出格式'); }
    raw = Array.isArray(json) ? json : json?.cookies; assert(Array.isArray(raw), 'JSON 必须是 Cookie 数组或包含 cookies 数组'); format = 'json';
  } else {
    // 允许账号交付文本的说明行，但只提取唯一、独立的 Cookie 行；卡密不进入账号记录。
    const lines = clean.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const candidates = lines.map(s => s.replace(/^cookie\s*[:：]\s*/i, '')).filter(s => /(?:^|;\s*)(?:sessionid|sessionid_ss|session_id|__Secure-sessionid)=/i.test(s));
    assert(candidates.length === 1, '请提供一条明确的 Cookie 文本，或 Cookie-Editor JSON');
    ignoredLines = lines.length - 1; format = 'header';
    raw = candidates[0].split(';').map(s => s.trim()).filter(Boolean).map(pair => { const at = pair.indexOf('='); assert(at > 0, 'Cookie 文本应使用 name=value; … 格式'); return { name: pair.slice(0, at), value: pair.slice(at + 1), hostOnly: true }; });
  }
  assert(raw.length > 0 && raw.length <= 150, '一次可导入 1–150 个 Cookie');
  const unique = new Map(); let expiredSkipped = 0;
  for (const c of raw) {
    assert(c && typeof c === 'object' && !Array.isArray(c), 'Cookie 条目格式不正确');
    const d = cookieDetails(c, platform);
    if (d.expirationDate && d.expirationDate * 1000 <= now) { expiredSkipped++; continue; }
    const key = `${d.name}|${d.domain || new URL(d.url).hostname}|${d.path}`;
    assert(!unique.has(key) || JSON.stringify(unique.get(key)) === JSON.stringify(d), '存在冲突的同名 Cookie，请重新导出'); unique.set(key, d);
  }
  const cookies = [...unique.values()];
  const platformHost = new URL(PLATFORMS[platform].url).hostname;
  assert(cookies.some(c => AUTH.test(c.name) && (new URL(c.url).hostname === platformHost || c.domain && (platformHost === c.domain.replace(/^\./, '') || platformHost.endsWith('.' + c.domain.replace(/^\./, '')))) && c.path === '/'), expiredSkipped ? '未找到未过期且适用于该平台的登录 Cookie' : '未找到适用于该平台的 sessionid 登录 Cookie');
  return { cookies, summary: { ...summarize(cookies, now), format, ignoredLines, expiredSkipped } };
}
function readCookieFile(file) {
  assert(typeof file === 'string' && path.isAbsolute(file) && ['.txt', '.json'].includes(path.extname(file).toLowerCase()), '请选择本机绝对路径的 .txt 或 .json 文件');
  try { const stat = fs.statSync(file); assert(stat.isFile() && stat.size <= MAX_BYTES, '文件不得超过 256KB'); return fs.readFileSync(file, 'utf8'); }
  catch { throw new Error('Cookie 文件无法读取或超过 256KB'); }
}
class CookieAccounts {
  constructor(studio, adapter) {
    this.studio = studio; this.adapter = adapter; this.electron = adapter.electron;
    this.changing = new Set(); this.restored = new Set(); this.restoring = new Map(); this.watched = new Map(); this.timers = new Map(); this.writes = new Map(); this.imports = new Map(); this.authImports = new Set();
    this.directory = path.join(studio.directory, 'credentials'); fs.mkdirSync(this.directory, { recursive: true });
    studio.state.cookieImports ||= [];
  }
  file(id) { assert(/^[0-9a-f-]{36}$/i.test(id), '账号 ID 不正确'); return path.join(this.directory, id + '.cookies.enc'); }
  session(a) { return this.electron.session.fromPartition(`persist:studio-${a.platform}-${a.id}`); }
  async available() {
    const safe = this.electron.safeStorage;
    const ok = safe?.isAsyncEncryptionAvailable ? await safe.isAsyncEncryptionAvailable() : safe?.isEncryptionAvailable();
    assert(ok && safe.getSelectedStorageBackend?.() !== 'basic_text', '本机系统加密不可用，不能保存 Cookie');
  }
  async encrypt(value) { await this.available(); const s = this.electron.safeStorage; return s.encryptStringAsync ? s.encryptStringAsync(JSON.stringify(value)) : s.encryptString(JSON.stringify(value)); }
  async decrypt(bytes) { const s = this.electron.safeStorage; const text = s.decryptStringAsync ? (await s.decryptStringAsync(bytes)).result : s.decryptString(bytes); return JSON.parse(text); }
  write(id, bytes) { const file = this.file(id), temp = file + '.tmp'; try { fs.writeFileSync(temp, bytes, { mode: 0o600 }); fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); } }
  result(a) { return { accountId: a.id, name: a.name, platform: a.platform, login: a.login, detail: a.loginDetail, cookieLogin: { ...a.cookieLogin, importFingerprint: undefined, importKey: undefined, authFingerprint: undefined }, checking: this.changing.has(a.id) }; }
  async restore(id) {
    if (this.restoring.has(id)) return this.restoring.get(id);
    const promise = this.restoreSession(id); this.restoring.set(id, promise);
    try { return await promise; } finally { this.restoring.delete(id); }
  }
  async restoreSession(id) {
    const a = this.studio.find('accounts', id), ses = this.session(a);
    if (this.restored.has(id) || this.changing.has(id)) return;
    this.restored.add(id);
    if (a.cookieLogin?.persisted && fs.existsSync(this.file(id))) {
      try {
        const saved = await this.decrypt(fs.readFileSync(this.file(id)));
        assert(saved.version === 1 && saved.platform === a.platform && Array.isArray(saved.cookies), 'invalid vault');
        if (!a.cookieLogin.authFingerprint) { a.cookieLogin.authFingerprint = authFingerprint(saved.cookies, a.platform); this.studio.save(); }
        const current = await ses.cookies.get({ url: PLATFORMS[a.platform].url });
        if (!current.some(c => AUTH.test(c.name))) for (const c of saved.cookies) { const d = cookieDetails(c, a.platform); if (!d.expirationDate || d.expirationDate * 1000 > Date.now()) await ses.cookies.set(d); }
        await ses.cookies.flushStore();
      } catch { this.studio.setLogin(id, 'unknown', '加密登录会话无法恢复，请重新导入 Cookie 或登录'); }
    }
    this.watch(a, ses);
  }
  watch(a, ses = this.session(a)) {
    if (this.watched.has(a.id)) return;
    const listener = (_event, cookie) => {
      if (!a.cookieLogin?.persisted || this.changing.has(a.id) || !allowedDomain(cookie.domain, a.platform)) return;
      clearTimeout(this.timers.get(a.id)); this.timers.set(a.id, setTimeout(() => { this.timers.delete(a.id); void this.persist(a.id); }, 300));
    };
    ses.cookies.on('changed', listener); this.watched.set(a.id, { ses, listener });
  }
  persist(id) {
    const promise = (this.writes.get(id) || Promise.resolve()).then(async () => {
      const a = this.studio.state.accounts.find(a => a.id === id); if (!a?.cookieLogin?.persisted || this.changing.has(id)) return;
      const all = (await this.session(a).cookies.get({})).filter(c => allowedDomain(c.domain, a.platform));
      const cookies = all.map(c => cookieDetails(c, a.platform));
      const bytes = await this.encrypt({ version: 1, platform: a.platform, cookies });
      if (!this.studio.state.accounts.includes(a) || this.changing.has(id)) return;
      this.write(id, bytes); Object.assign(a.cookieLogin, summarize(cookies), { lastSavedAt: Date.now(), storageError: false });
      if (!cookies.some(c => AUTH.test(c.name))) { a.login = 'login_required'; a.loginDetail = '平台登录 Cookie 已移除或到期，请重新导入或登录'; }
      this.studio.save();
    }).catch(() => { const a = this.studio.state.accounts.find(a => a.id === id); if (a?.cookieLogin) { a.cookieLogin.storageError = true; this.studio.save(); } });
    this.writes.set(id, promise); return promise;
  }
  async flush() { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); await Promise.all(this.studio.state.accounts.filter(a => a.cookieLogin?.persisted).map(a => this.persist(a.id))); }
  async remove(id) {
    assert(!this.changing.has(id), '账号正在导入或检测 Cookie，请稍后再移除');
    const a = this.studio.find('accounts', id), ses = this.session(a);
    this.studio.removeAccount(id);
    const watcher = this.watched.get(id); if (watcher) watcher.ses.cookies.removeListener('changed', watcher.listener);
    clearTimeout(this.timers.get(id)); this.timers.delete(id); await this.writes.get(id);
    this.adapter.windows.get(id)?.destroy(); this.adapter.completionWindows?.get(id)?.destroy(); this.watched.delete(id); this.restored.delete(id);
    fs.rmSync(this.file(id), { force: true });
    await ses.clearStorageData();
    return { removed: true };
  }
  async import(input) {
    assert(typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 && input.idempotencyKey.length <= 200, '导入需要幂等键');
    const existing = input.accountId ? this.studio.find('accounts', input.accountId) : null;
    const platform = existing?.platform || input.platform;
    assert(!existing || !input.platform || input.platform === platform, '不能更改现有账号的平台');
    const parsed = parseCookies(input.file ? readCookieFile(input.file) : input.cookieText, platform);
    const fingerprint = createHash('sha256').update(JSON.stringify({ platform, accountId: input.accountId || null, cookies: parsed.cookies })).digest('hex');
    const operation = this.studio.state.cookieImports.find(o => o.key === input.idempotencyKey);
    if (operation) { assert(operation.fingerprint === fingerprint, '此幂等键已用于另一份 Cookie，请使用新键'); const a = this.studio.state.accounts.find(a => a.id === operation.accountId); assert(a, '该导入对应的账号已移除，不会重新建立账号'); return this.result(a); }
    const prior = this.studio.state.accounts.find(a => a.cookieLogin?.importKey === input.idempotencyKey);
    if (prior) { assert(prior.cookieLogin.importFingerprint === fingerprint, '此幂等键已用于另一份 Cookie，请使用新键'); return this.result(prior); }
    const pending = this.imports.get(input.idempotencyKey);
    if (pending) { assert(pending.fingerprint === fingerprint, '此幂等键已用于另一份 Cookie'); return pending.promise; }
    const auth = authFingerprint(parsed.cookies, platform);
    assert(!this.studio.state.accounts.some(a => a.id !== existing?.id && a.platform === platform && a.cookieLogin?.authFingerprint === auth), '这份登录 Cookie 已在账号池中，请更新对应账号，避免重复计算额度');
    assert(!this.authImports.has(auth), '这份 Cookie 正在导入，请稍后查看账号池'); this.authImports.add(auth);
    const promise = this.install(input, existing, platform, parsed, fingerprint);
    this.imports.set(input.idempotencyKey, { fingerprint, promise });
    try { return await promise; } finally { this.imports.delete(input.idempotencyKey); this.authImports.delete(auth); }
  }
  async install(input, existing, platform, parsed, fingerprint) {
    if (existing) {
      assert(!this.changing.has(existing.id), '账号正在更新 Cookie，请稍后重试');
      assert(!this.studio.state.tasks.some(t => t.accountId === existing.id && BUSY.has(t.status)), '账号正在生成、核实或下载，请任务结束后更新 Cookie');
      this.changing.add(existing.id);
    }
    let a = existing, oldCookies, oldMetadata, oldVault, stored = false;
    try {
      // 先加密并校验格式，之后才修改账号与浏览器会话。
      const encrypted = await this.encrypt({ version: 1, platform, cookies: parsed.cookies });
      if (!a) { const created = this.studio.addAccount({ name: input.name, platform, dailyLimit: input.dailyLimit ?? 1, quotaMode:input.quotaMode || (platform==='doubao'?'auto':'manual') }); a = this.studio.find('accounts', created.id); this.changing.add(a.id); }
      oldMetadata = structuredClone(a); oldVault = fs.existsSync(this.file(a.id)) ? fs.readFileSync(this.file(a.id)) : null;
      await this.writes.get(a.id);
      const ses = this.session(a); oldCookies = (await ses.cookies.get({})).filter(c => allowedDomain(c.domain, platform));
      this.adapter.windows.get(a.id)?.destroy();
      for (const c of oldCookies) await ses.cookies.remove(cookieDetails(c, platform).url, c.name);
      for (const d of parsed.cookies) await ses.cookies.set(d);
      await ses.cookies.flushStore(); this.write(a.id, encrypted);
      a.login = 'unknown'; a.loginDetail = 'Cookie 已加密保存，正在后台检测登录'; a.lastPage = PLATFORMS[platform].url;
      a.cookieLogin = { ...parsed.summary, source: 'cookie', persisted: true, importedAt: Date.now(), lastSavedAt: Date.now(), checkState: 'checking', importKey: input.idempotencyKey, importFingerprint: fingerprint, authFingerprint: authFingerprint(parsed.cookies, platform) };
      this.studio.state.cookieImports.push({ key: input.idempotencyKey, fingerprint, accountId: a.id, time: Date.now() });
      this.studio.save(); stored = true; this.restored.add(a.id); this.watch(a, ses);
      void this.check(a.id);
      return this.result(a);
    } catch {
      if (a && oldCookies) {
        try { const ses = this.session(a); for (const c of (await ses.cookies.get({})).filter(c => allowedDomain(c.domain, platform))) await ses.cookies.remove(cookieDetails(c, platform).url, c.name); for (const c of oldCookies) await ses.cookies.set(cookieDetails(c, platform)); await ses.cookies.flushStore(); if (oldVault) this.write(a.id, oldVault); else fs.rmSync(this.file(a.id), { force: true }); if (existing) { Object.assign(a, oldMetadata); if (!oldMetadata.cookieLogin) delete a.cookieLogin; } } catch { if (existing) { a.login = 'unknown'; a.loginDetail = 'Cookie 更新失败，请重新检测登录'; } }
      }
      if (a && !existing) this.studio.state.accounts = this.studio.state.accounts.filter(x => x.id !== a.id);
      this.studio.state.cookieImports = this.studio.state.cookieImports.filter(o => o.key !== input.idempotencyKey);
      if (a) this.studio.save();
      throw new Error('Cookie 导入失败，未完成会话更新；请检查本机系统加密和 Cookie 格式');
    } finally { if (!stored && a) this.changing.delete(a.id); }
  }
  async check(id) {
    const a = this.studio.find('accounts', id);
    try { await this.adapter.probe(id); a.cookieLogin.checkState = a.login === 'ready' ? 'verified' : 'unverified'; }
    catch { this.studio.setLogin(id, 'unknown', 'Cookie 已保存，但平台页面无法完成登录检测；请稍后重试'); a.cookieLogin.checkState = 'unverified'; }
    finally { this.changing.delete(id); this.studio.save(); await this.persist(id); if(a.login==='ready' && this.studio.state.accounts.includes(a))this.studio.resumeAccountDownloads?.(id); }
  }
}
module.exports = { parseCookies, summarize, readCookieFile, allowedDomain, CookieAccounts };
