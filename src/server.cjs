const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { assert } = require('./core.cjs');
const { execute, extractFrame } = require('./media.cjs');
const { Workflows } = require('./workflows.cjs');
const { VideoReview } = require('./video-review.cjs');
const { parseCookies } = require('./account-cookies.cjs');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
async function startServer(studio, { port = 43127, desktop = null, preview = false } = {}) {
  const token = randomBytes(32).toString('hex'); let boundPort = port;
  const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
  const workflows = new Workflows(studio);
  const reviews = new VideoReview(studio);
  const actions = {
    'account.add': x => studio.addAccount(x),
    'account.update': x => studio.updateAccount(x.id, x.patch),
    'account.remove': x => desktop ? desktop.cookieAccounts.remove(x.id) : studio.removeAccount(x.id),
    'account.cookiePreview': x => { const a = x.accountId ? studio.find('accounts', x.accountId) : null; return parseCookies(x.cookieText, a?.platform || x.platform).summary; },
    'account.importCookies': x => { assert(desktop, 'Cookie 登录需要桌面版，请启动 Canvas Studio'); return desktop.cookieAccounts.import(x); },
    'account.open': x => { assert(desktop, '请启动桌面版以打开独立登录窗口'); return desktop.openAccount(x.id).then(() => ({ opened: true })); },
    'account.probe': x => { assert(desktop, '浏览器预览不具备平台登录会话，请使用桌面版'); return desktop.probe(x.id); },
    'account.inspect': x => { assert(desktop, '请使用桌面版'); return desktop.inspect(x.id, x.taskId); },
    'account.videoMode': x => { assert(desktop, '请使用桌面版'); return desktop.selectVideoMode(x.id); },
    'account.capabilities': x => { assert(desktop, '请使用桌面版'); return desktop.discoverCapabilities(x.id); },
    'account.quota': x => { assert(desktop,'请使用桌面版同步平台额度'); return desktop.syncQuota(x.id); },
    'account.options': x => { assert(desktop, '请使用桌面版'); return desktop.inspectOptions(x.id, x.kind, x.duration); },
    'project.create': x => studio.createProject(x.name),
    'project.save': x => studio.saveProject(x.id, x.patch),
    'asset.import': x => { assert(typeof x.file === 'string' && path.isAbsolute(x.file), '素材路径必须是绝对路径'); return studio.registerAsset(x.file, x); },
    'asset.pick': async x => { assert(desktop, '请选择文件上传'); const result = await desktop.electron.dialog.showOpenDialog({ title: '导入素材', properties: ['openFile', 'multiSelections'], filters: [{ name: x.kind === 'video' ? '视频' : '图片', extensions: x.kind === 'video' ? ['mp4', 'webm', 'mov', 'mkv'] : ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] }); return result.canceled ? [] : result.filePaths.map(file => studio.registerAsset(file, { kind: x.kind || 'image' })); },
    'asset.upload': x => {
      assert(typeof x.data === 'string' && /^[\w+/=]+$/.test(x.data), '素材编码不正确');
      const buffer = Buffer.from(x.data, 'base64'); assert(buffer.length <= 30 * 1024 ** 2, '上传素材不得超过 30MB');
      const ext = path.extname(x.name || '').toLowerCase(); assert(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mov', '.mkv'].includes(ext), '素材格式不支持');
      const temp = path.join(studio.directory, 'assets', `upload-${randomBytes(8).toString('hex')}${ext}`); fs.writeFileSync(temp, buffer);
      try { return studio.registerAsset(temp, { name: x.name, kind: x.kind || 'image' }); } finally { fs.rmSync(temp, { force: true }); }
    },
    'video.frame': x => extractFrame(studio, x),
    'video.comparison': x => reviews.comparison(x),
    'video.review': x => reviews.record(x),
    'shot.create': x => workflows.createShot(x),
    'video.merge': x => workflows.merge(x),
    'validation.run': x => studio.validation(x.operation),
    'task.submit': x => { const task = studio.submit(x); void studio.tick(); return task; },
    'task.cancel': x => studio.cancel(x.id),
    'task.deferSubmission': x => studio.deferSubmission(x.id),
    'task.confirm': x => { const t = studio.reconcile(x.id, x.resolution, x.remote); void studio.tick(); return t; },
    'task.continue': x => { assert(desktop, '请使用桌面版'); return desktop.continueTask(x.id); },
    'task.sendPrepared': x => { assert(desktop, '请使用桌面版'); return desktop.submitPrepared(x.id); },
    'task.confirmParameters': x => { assert(desktop, '请使用桌面版'); return desktop.confirmParameters(x.id); },
    'task.authorize': x => { assert(desktop, '请使用桌面版'); return desktop.authorizeTask(x.id, x.accepted, x.declaration); },
    'task.attach': x => { const t = studio.attachVideo(x.id, x.vid); void studio.tick(); return t; },
    'task.retryDownload': x => { const t = studio.retryDownload(x.id); void studio.tick(); return t; },
    'task.verify': x => studio.verifyDownload(x.id, x.clean),
    'file.reveal': x => { assert(desktop, '请在桌面版打开文件'); const asset = studio.find('assets', x.assetId); desktop.electron.shell.showItemInFolder(asset.file); return { opened: true }; }
  };
  if (desktop && !desktop.electron.app.isPackaged) actions['dev.reloadAdapter'] = () => { const filename=require.resolve('./platform.cjs'); delete require.cache[filename]; Object.setPrototypeOf(desktop,require(filename).PlatformAdapter.prototype); return { reloaded:true }; };
  function serveFile(req, res, file) {
    const size = fs.statSync(file).size; const type = mime[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` }); fs.createReadStream(file, { start, end }).pipe(res);
    } else { res.writeHead(200, { ...headers, 'Content-Length': size }); fs.createReadStream(file).pipe(res); }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${boundPort}`;
      if (req.headers.host !== `127.0.0.1:${boundPort}`) return json(res, { error: '无效 Host' }, 403);
      if (req.headers.origin && req.headers.origin !== origin) return json(res, { error: '跨站请求被拒绝' }, 403);
      const url = new URL(req.url, origin);
      if (url.pathname === '/' && req.method === 'GET') {
        res.setHeader('Set-Cookie', `studio=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        return serveFile(req, res, path.join(__dirname, '../ui/index.html'));
      }
      const auth = req.headers.authorization?.replace(/^Bearer /, '') || /(?:^|; )studio=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
      const authenticated = auth.length === token.length && timingSafeEqual(Buffer.from(auth), Buffer.from(token));
      if (!authenticated) return json(res, { error: '需要本地会话授权' }, 401);
      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, studio.snapshot());
      if (url.pathname === '/api/system' && req.method === 'GET') return json(res, { preview, desktop: !!desktop, directory: studio.directory, port: boundPort, mcp: path.join(__dirname, 'mcp.mjs') });
      if (url.pathname.startsWith('/asset/') && req.method === 'GET') { const asset = studio.find('assets', url.pathname.slice(7)); return serveFile(req, res, asset.file); }
      if (url.pathname === '/api/action' && req.method === 'POST') {
        let length = 0; const chunks = [];
        for await (const chunk of req) { length += chunk.length; if (length > 45 * 1024 ** 2) throw new Error('请求超过 45MB'); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求 JSON 格式不正确'); }
        assert(actions[body.action], '未知操作'); const value = await actions[body.action](body.input || {}); return json(res, { result: value ?? null });
      }
      const staticFiles = { '/app.js': 'app.js', '/style.css': 'style.css', '/video-evidence.js': 'video-evidence.js' };
      if (staticFiles[url.pathname] && req.method === 'GET') return serveFile(req, res, path.join(__dirname, '../ui', staticFiles[url.pathname]));
      json(res, { error: '未找到资源' }, 404);
    } catch (e) { json(res, { error: e.message }, 400); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  boundPort = server.address().port;
  const runtimeFile = path.join(studio.directory, 'runtime.json');
  fs.writeFileSync(runtimeFile, JSON.stringify({ url: `http://127.0.0.1:${boundPort}`, token, pid: process.pid }), { mode: 0o600 });
  server.on('close', () => { if (fs.existsSync(runtimeFile)) { try { const r = JSON.parse(fs.readFileSync(runtimeFile)); if (r.pid === process.pid) fs.rmSync(runtimeFile); } catch {} } });
  return { server, url: `http://127.0.0.1:${boundPort}` };
}
module.exports = { startServer, extractFrame, execute };
