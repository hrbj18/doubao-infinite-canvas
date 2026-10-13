const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { bucketOf, accountUsage } = require('./quota.cjs');
const doubaoQuota = require('./doubao-quota.cjs');

const PLATFORMS = { doubao: { name: '豆包', url: 'https://www.doubao.com/chat/' }, dola: { name: 'Dola', url: 'https://www.dola.com/chat/' } };
const BUSY = new Set(['preparing', 'awaiting_confirmation', 'running', 'reconciling', 'downloading']);
function dayOf(time = Date.now()) { return new Date(time + 8 * 3600000).toISOString().slice(0, 10); }
function nextDay(time = Date.now()) { return Date.parse(`${dayOf(time)}T00:00:00+08:00`) + 86400000; }
function assert(condition, message) { if (!condition) throw new Error(message); }
function num(value, min, max, name) { assert(Number.isFinite(value) && value >= min && value <= max, `${name}必须在 ${min}–${max} 之间`); return value; }
const clone = value => structuredClone(value);

class Studio {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.clock = options.clock || Date.now;
    this.file = path.join(directory, 'state.json');
    fs.mkdirSync(directory, { recursive: true });
    for (const name of ['assets', 'outputs']) fs.mkdirSync(path.join(directory, name), { recursive: true });
    if (fs.existsSync(this.file)) {
      try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
      catch { throw new Error('数据文件无法读取。请保留 state.json 和 state.json.bak，再进行恢复。'); }
      assert(this.state.version === 1, '不支持的数据版本');
    } else this.state = { version: 1, accounts: [], projects: [], tasks: [], attempts: [], assets: [], observations: [], events: [], settings: { globalConcurrency: 3 }, cursors: {} };
    this.adapter = options.adapter;
    this.executing = new Set();
    this.downloading = new Set();
    this.tickBusy = false;
    this.state.exports ||= [];
    this.state.workflowOperations ||= [];
    for (const attempt of this.state.attempts) {
      const task = this.state.tasks.find(t => t.id === attempt.taskId);
      attempt.quotaBucket ||= bucketOf(task);
      attempt.duration ??= task?.duration ?? null;
      attempt.model ??= task?.model ?? null;
    }
    this.changed = options.changed || (() => {});
    for (const a of this.state.accounts) if (a.cookieLogin?.checkState === 'checking') { a.cookieLogin.checkState = 'unverified'; a.login = 'unknown'; a.loginDetail = '上次 Cookie 检测中断，请重新检测登录'; }
    for (const task of this.state.tasks) if (task.status === 'cancelled') task.authorizationRequired = false;
    for (const task of this.state.tasks) if (!task.nodeId) this.materializeTask(task);
  }
  materializeTask(task) {
    const project = this.state.projects.find(p=>p.id===task.projectId); if(!project || task.nodeId)return;
    const y = Math.max(-280,...project.nodes.map(n=>n.y)) + 360, nodeId = 'agent-' + task.id;
    task.refs.forEach((ref,i)=>{ const imageId=randomUUID();project.nodes.push({id:imageId,type:'image',name:this.find('assets',ref.assetId).name,assetId:ref.assetId,x:70,y:y+i*340});project.edges.push({id:randomUUID(),from:imageId,to:nodeId,kind:'input',role:ref.role}); });
    project.nodes.push({id:nodeId,type:'generation',name:'Agent · '+(task.duration?task.duration+'秒视频':'视频生成'),x:480,y,platform:task.platform,mode:task.mode,prompt:task.prompt,duration:task.duration||'',ratio:task.ratio||'',model:task.model||''});
    task.nodeId=nodeId;task.shotId ||= nodeId;
    const output=project.nodes.find(n=>n.type==='video' && n.taskId===task.id);
    if(output){output.x=840;output.y=y;project.edges.push({id:randomUUID(),from:nodeId,to:output.id,kind:'output'});}
    project.revision=(project.revision||0)+1;project.updatedAt=this.clock();
  }
  save() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.renameSync(temp, this.file);
    this.changed();
  }
  event(type, message, taskId) {
    this.state.events.push({ id: randomUUID(), time: this.clock(), type, message, taskId });
    this.state.events = this.state.events.slice(-400);
  }
  find(collection, id) { const item = this.state[collection].find(x => x.id === id); assert(item, `${collection} 中找不到 ${id}`); return item; }
  usage(accountId, bucket = 'standard') {
    const today = dayOf(this.clock());
    const account = this.find('accounts', accountId);
    const busy = this.state.tasks.some(t => t.accountId === accountId && BUSY.has(t.status));
    const local=accountUsage(account, this.state.attempts, today, busy, bucket, this.clock());
    if(account.platform==='doubao'&&account.quotaMode==='auto')return {...local,quotaMode:'auto',available:null,limit:null,quotaRelation:'platform',platformQuota:account.platformQuota,capacity: doubaoQuota.decision(account,this.state.attempts,{model:doubaoQuota.FAST_MODEL,duration:bucket==='15s'?15:5,mode:'references'},this.clock())};
    return local;
  }
  snapshot() { return clone({ ...this.state, cookieImports: undefined, accounts: this.state.accounts.map(a => ({ ...a, cookieLogin: a.cookieLogin ? { ...a.cookieLogin, importKey: undefined, importFingerprint: undefined, authFingerprint: undefined } : undefined, usage: this.usage(a.id) })), platforms: PLATFORMS }); }
  addAccount({ name, platform, dailyLimit, quotaMode }) {
    quotaMode ||= platform==='doubao'&&dailyLimit===undefined?'auto':'manual';dailyLimit ??= 1;
    assert(PLATFORMS[platform], '未知平台');
    assert(typeof name === 'string' && name.trim(), '请填写账号名称');
    num(dailyLimit, 0, 10000, '每日次数'); assert(Number.isInteger(dailyLimit), '每日次数必须是整数');
    assert(['auto','manual'].includes(quotaMode) && (quotaMode!=='auto'||platform==='doubao'),'自动额度管理仅适用于国内豆包');
    const account = { id: randomUUID(), name: name.trim().slice(0, 80), platform, dailyLimit, quotaMode, login: 'unknown', adjustments: {}, createdAt: this.clock() };
    this.state.accounts.push(account); this.event('account', `添加账号：${account.name}`); this.save(); return clone(account);
  }
  updateAccount(id, patch) {
    const original = this.find('accounts', id), a = clone(original);
    if (patch.dailyLimit !== undefined) { num(patch.dailyLimit, 0, 10000, '每日次数'); assert(Number.isInteger(patch.dailyLimit), '次数必须是整数'); a.dailyLimit = patch.dailyLimit; }
    if (patch.name !== undefined) { assert(patch.name.trim(), '名称不能为空'); a.name = patch.name.trim().slice(0, 80); }
    if(patch.quotaMode!==undefined){assert(['auto','manual'].includes(patch.quotaMode)&&(patch.quotaMode!=='auto'||a.platform==='doubao'),'自动额度管理仅适用于国内豆包');a.quotaMode=patch.quotaMode;}
    if (patch.clearBlock) { a.blockedUntil = null; a.blockReason = null; a.autoQuotaBlocks={}; }
    if (patch.quotaRelation !== undefined) { assert(['unknown', 'shared', 'independent'].includes(patch.quotaRelation), '未知额度共享关系'); assert(patch.quotaRelation !== 'independent' || (typeof patch.quotaEvidence === 'string' && patch.quotaEvidence.trim()), '独立额度需要平台证据'); a.quotaRelation = patch.quotaRelation; a.quotaEvidence = patch.quotaEvidence || ''; }
    if (patch.quotaBucket !== undefined) {
      assert(['standard', '15s'].includes(patch.quotaBucket), '未知额度类型');
      if (patch.bucketLimit !== undefined) { num(patch.bucketLimit, 0, 10000, '分类预算'); assert(Number.isInteger(patch.bucketLimit), '预算必须为整数'); (a.quotaLimits ||= {})[patch.quotaBucket] = patch.bucketLimit; }
      if (patch.bucketUsed !== undefined) { num(patch.bucketUsed, 0, 10000, '分类用量'); assert(Number.isInteger(patch.bucketUsed), '用量必须为整数'); const recorded = this.state.attempts.filter(x => x.accountId === id && x.day === dayOf(this.clock()) && x.phase === 'accepted' && x.quotaBucket === patch.quotaBucket).length; assert(patch.bucketUsed >= recorded, '用量不能低于项目已提交次数'); ((a.quotaAdjustments ||= {})[dayOf(this.clock())] ||= {})[patch.quotaBucket] = patch.bucketUsed - recorded; }
      if (patch.clearBlock) delete a.quotaBlocks?.[patch.quotaBucket];
    }
    else if (patch.clearBlock) a.quotaBlocks = {};
    if (patch.todayUsed !== undefined) {
      num(patch.todayUsed, 0, 10000, '今日用量'); assert(Number.isInteger(patch.todayUsed), '用量必须是整数');
      const day=dayOf(this.clock()), recorded=this.state.attempts.filter(x=>x.accountId===id && x.day===day && x.phase==='accepted').length;
      assert(patch.todayUsed>=recorded,'校准次数不能低于本项目已提交次数');
      const classified=Object.values(a.quotaAdjustments?.[day]||{}).reduce((sum,n)=>sum+n,0);
      assert(patch.todayUsed>=recorded+classified,'总用量不能低于已记录的分类用量');a.adjustments[day]=patch.todayUsed-recorded-classified;
    }
    Object.assign(original, a); this.save(); return clone(a);
  }
  setLogin(id, login, detail) { assert(['ready', 'login_required', 'unknown'].includes(login), '未知登录状态'); const a = this.find('accounts', id); a.login = login; a.loginDetail = detail; a.checkedAt = this.clock(); this.save(); if(login==='ready')this.resumeAccountDownloads(id); }
  resumeAccountDownloads(id) {
    const account=this.find('accounts',id);if(account.login!=='ready'||account.cookieLogin?.checkState==='checking')return;
    for(const task of this.state.tasks)if(task.accountId===id && task.platform==='dola' && task.status==='download_pending' && task.vid && ['login_required','region_restricted'].includes(task.downloadBlocker?.code))this.transition(task,'download_pending',{downloadBlocker:null,downloadHold:false,retryAt:null,retries:0,reason:'账号已恢复可用，继续下载原作品，不重新生成'});
  }
  removeAccount(id) { assert(!this.state.tasks.some(t => t.accountId === id && !['done', 'failed', 'cancelled'].includes(t.status)), '账号仍有未完成任务，请先处理任务'); this.find('accounts', id); this.state.accounts = this.state.accounts.filter(a => a.id !== id); this.save(); }
  createProject(name = '未命名项目') {
    const p = { id: randomUUID(), revision: 0, name: String(name).slice(0, 100), nodes: [], edges: [], viewport: { x: 60, y: 60, scale: 1 }, createdAt: this.clock(), updatedAt: this.clock() };
    this.state.projects.push(p); this.save(); return clone(p);
  }
  saveProject(id, patch) {
    const original = this.find('projects', id), p = clone(original);
    if (patch.expectedRevision !== undefined) assert(patch.expectedRevision === (p.revision || 0), '项目已被其他调用修改，请刷新后合并');
    if (patch.name !== undefined) p.name = String(patch.name).slice(0, 100);
    if (patch.nodes) {
      assert(Array.isArray(patch.nodes) && patch.nodes.length <= 1000, '节点数量超限');
      const ids = new Set();
      for (const n of patch.nodes) {
        assert(typeof n.id === 'string' && /^[\w-]{1,128}$/.test(n.id) && !ids.has(n.id), '节点 ID 无效或重复'); ids.add(n.id);
        assert(['image', 'generation', 'video'].includes(n.type), '未知节点类型'); num(n.x, -1e6, 1e6, '节点位置'); num(n.y, -1e6, 1e6, '节点位置');
        if (n.width !== undefined) num(n.width, 200, 600, '节点宽度');
        if (n.type === 'generation') { assert(PLATFORMS[n.platform || 'doubao'], '未知生成平台'); assert(!n.mode || ['references', 'first', 'first_last'].includes(n.mode), '未知生成模式'); }
        else if (n.assetId) assert(this.find('assets', n.assetId).kind === n.type, '节点与素材类型不一致');
      }
      p.nodes = clone(patch.nodes);
    }
    if (patch.edges) { assert(Array.isArray(patch.edges) && patch.edges.length <= 3000, '连线数量超限'); const ids = new Set(p.nodes.map(n => n.id)), edgeIds = new Set(); for (const e of patch.edges) { assert(typeof e.id === 'string' && /^[\w-]{1,128}$/.test(e.id) && !edgeIds.has(e.id), '连线 ID 无效或重复'); edgeIds.add(e.id); assert(!e.role || ['reference', 'first', 'last'].includes(e.role), '连线角色无效'); } p.edges = clone(patch.edges.filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)); }
    if (patch.viewport) { const v = patch.viewport; num(v.x, -1e6, 1e6, '视图位置'); num(v.y, -1e6, 1e6, '视图位置'); num(v.scale, .1, 3, '缩放'); p.viewport = clone(v); }
    p.revision = (p.revision || 0) + 1; p.updatedAt = this.clock(); Object.assign(original, p); this.save(); return clone(p);
  }
  registerAsset(file, { name = path.basename(file), kind = 'image' } = {}) {
    assert(['image', 'video'].includes(kind), '不支持此素材类型');
    const allowed = kind === 'image' ? ['.jpg', '.jpeg', '.png', '.webp', '.gif'] : ['.mp4', '.webm', '.mov', '.mkv'];
    const ext = path.extname(file).toLowerCase(); assert(allowed.includes(ext), '素材扩展名不支持');
    assert(fs.statSync(file).isFile(), '素材必须是文件');
    const id = randomUUID(); const destination = path.join(this.directory, 'assets', id + ext);
    fs.copyFileSync(file, destination);
    const asset = { id, name: String(name).slice(0, 200), kind, file: destination, size: fs.statSync(destination).size };
    this.state.assets.push(asset); this.save(); return clone(asset);
  }
  candidates(task) {
    return this.state.accounts.filter(a => a.platform === task.platform && (task.accountPolicy !== 'required' || a.id === task.preferredAccountId) && a.login === 'ready' && !this.adapter?.cookieAccounts?.changing.has(a.id) && !this.adapter?.quotaSyncing?.has(a.id) && (a.platform==='doubao'&&a.quotaMode==='auto'?doubaoQuota.decision(a,this.state.attempts,task,this.clock()).canPrepare:!(this.usage(a.id, bucketOf(task)).blockedUntil > this.clock()) && this.usage(a.id, bucketOf(task)).available > 0) && !this.usage(a.id).busy);
  }
  submit(input) {
    assert(PLATFORMS[input.platform], '任务必须指定 doubao 或 dola 平台');
    assert(typeof input.prompt === 'string' && input.prompt.trim(), '提示词不能为空');
    assert(input.prompt.length <= 12000, '提示词过长');
    assert(['references', 'first', 'first_last'].includes(input.mode), '请选择参考图、首帧或首尾帧模式');
    const refs = clone(input.refs || []); assert(refs.length > 0 && refs.length <= 9, '请提供 1–9 张参考图');
    for (const r of refs) { assert(this.find('assets', r.assetId).kind === 'image', '参考素材必须是图片'); assert(['reference', 'first', 'last'].includes(r.role), '未知素材角色'); }
    if (input.mode === 'first_last') assert(refs.length === 2 && refs.filter(r => r.role === 'first').length === 1 && refs.filter(r => r.role === 'last').length === 1, '首尾帧任务需要分别指定一张首帧和一张尾帧');
    else if (input.mode === 'first') assert(refs.length === 1 && refs[0].role === 'first', '首帧任务需要一张明确指定为首帧的图片');
    else assert(refs.every(r => r.role === 'reference'), '多图参考的素材角色必须是 reference');
    if (input.duration !== undefined) num(input.duration, 1, 120, '时长');
    if (input.ratio !== undefined) assert(['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(input.ratio), '不支持的比例');
    const project = this.find('projects', input.projectId);
    if (input.nodeId) assert(project.nodes.some(n => n.id === input.nodeId && n.type === 'generation'), '生成节点不存在');
    if (input.accountId) assert(this.find('accounts', input.accountId).platform === input.platform, '账号与平台不匹配');
    assert(!input.accountPolicy || ['preferred','required'].includes(input.accountPolicy), '未知账号分配策略');
    assert(input.accountPolicy !== 'required' || input.accountId, '固定账号任务必须指定账号');
    assert(typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 && input.idempotencyKey.length <= 200, '请提供唯一 idempotencyKey');
    if (input.model !== undefined) assert(typeof input.model === 'string' && input.model.length <= 100, '模型名称无效');
    if (input.validationRunId) { const run = this.state.settings.validationRun; assert(run?.id === input.validationRunId && run.active, '验证预算未启用或已结束'); assert(input.duration === 5, '本轮真实验证仅允许5秒任务，禁止消耗15秒'); }
    const identity = JSON.stringify({ projectId: input.projectId, nodeId: input.nodeId || null, platform: input.platform, prompt: input.prompt.trim(), mode: input.mode, refs, duration: input.duration || null, ratio: input.ratio || null, ...(input.model ? { model: input.model } : {}), ...(input.validationRunId ? { validationRunId: input.validationRunId } : {}), ...(input.accountPolicy === 'required' ? { accountPolicy:'required', accountId:input.accountId } : {}) });
    const existing = this.state.tasks.find(t => t.idempotencyKey === input.idempotencyKey);
    if (existing) { assert(existing.identity === identity, '同一幂等键对应了不同任务参数'); return clone(existing); }
    const node = project.nodes.find(n => n.id === input.nodeId);
    const task = { id: randomUUID(), projectId: project.id, nodeId: input.nodeId, platform: input.platform, preferredAccountId: input.accountId, accountPolicy:input.accountPolicy || 'preferred', prompt: input.prompt.trim(), mode: input.mode, refs, duration: input.duration, ratio: input.ratio, model: input.model || (input.platform==='doubao'?doubaoQuota.FAST_MODEL:undefined), reviewBeforeSend: input.reviewBeforeSend === true, validationRunId: input.validationRunId, shotId: node?.shotId || node?.id, parentShotId: node?.parentShotId, sequenceId: node?.sequenceId, shotKind: node?.shotKind, idempotencyKey: input.idempotencyKey, identity, status: 'queued', createdAt: this.clock(), updatedAt: this.clock() };
    this.state.tasks.push(task); this.materializeTask(task); this.event('task', '任务已加入队列', task.id); this.save(); return clone(task);
  }
  reserve(task) {
    const wait = (reason, nextCheckAt = null) => { if (task.status !== 'waiting_account' || task.reason !== reason) { task.status = 'waiting_account'; task.reason = reason; task.nextCheckAt = nextCheckAt; this.save(); } return false; };
    if (this.state.tasks.filter(t => BUSY.has(t.status)).length >= this.state.settings.globalConcurrency) return wait('等待空闲并发：当前最多同时生成 3 条');
    if (task.validationRunId) {
      const run = this.state.settings.validationRun;
      if (!run?.active || run.id !== task.validationRunId) return wait('验证预算已结束，保留任务等待安排');
      const count = this.state.attempts.filter(a => a.validationRunId === run.id && a.platform === task.platform && ['accepted', 'uncertain', 'reserved'].includes(a.phase)).length;
      if (count >= run.limits[task.platform]) return wait('已达到本轮5秒真实测试次数上限，不再提交');
    }
    const candidates = this.candidates(task);
    const preferred = candidates.find(a => a.id === task.preferredAccountId);
    const cursor = this.state.cursors[task.platform];
    const all = this.state.accounts.filter(a => a.platform === task.platform);
    const start = Math.max(0, all.findIndex(a => a.id === cursor) + 1);
    const ordered = [...all.slice(start), ...all.slice(0, start)];
    const account = preferred || ordered.find(a => candidates.some(c => c.id === a.id));
    if (!account) return wait('等待已登录、额度可用且空闲的账号；自动模式按平台反馈核对', this.clock()+60000);
    const attempt = { id: randomUUID(), taskId: task.id, accountId: account.id, platform: task.platform, validationRunId: task.validationRunId, quotaBucket: bucketOf(task), duration: task.duration ?? null, mode:task.mode,resolution:task.resolution,model: task.model ?? null, day: dayOf(this.clock()), phase: 'reserved', time: this.clock() };
    this.state.attempts.push(attempt); this.state.cursors[task.platform] = account.id;
    Object.assign(task, { accountId: account.id, attemptId: attempt.id, status: 'preparing', reason: null, nextCheckAt: null, updatedAt: this.clock() });
    this.event('dispatch', `分配至 ${account.name}，预留当前任务`, task.id); this.save(); return account;
  }
  transition(task, status, patch = {}) { Object.assign(task, patch, { status, updatedAt: this.clock() }); this.save(); }
  accepted(task, remote = {}) {
    const a = this.find('attempts', task.attemptId); a.phase = 'accepted'; a.acceptedAt ||= this.clock();
    this.transition(task, 'running', { remote, reason: null, submittedAt: this.clock() });
  }
  reject(task, code, message) {
    const attempt = this.find('attempts', task.attemptId);
    if (code === 'uncertain') { attempt.phase = 'uncertain'; this.transition(task, 'reconciling', { reason: message }); return; }
    if(code==='quota'&&attempt.phase==='accepted'){this.transition(task,'submission_review',{reason:'已有受理证据，额度反馈待核实，保留原任务，不切号重发'});return;}
    // 只有已证实未提交的拒绝才释放预算；生成失败保留已计次记录。
    if (attempt.phase !== 'accepted') attempt.phase = 'released';
    const account = this.find('accounts', task.accountId);
    if (code === 'quota') { if(account.platform==='doubao'&&account.quotaMode==='auto'){(account.autoQuotaBlocks ||= {})[doubaoQuota.variantKey(task)]={retryAt:this.clock()+15*60000,reason:message};}else{const bucket = attempt.quotaBucket || bucketOf(task); (account.quotaBlocks ||= {})[bucket] = { until: nextDay(this.clock()), reason: message }; if ((account.quotaRelation || 'unknown') !== 'independent') { account.blockedUntil = nextDay(this.clock()); account.blockReason = message; }} }
    if (code === 'login') account.login = 'login_required';
    if (['quota', 'login'].includes(code)) this.transition(task, 'queued', { accountId: null, attemptId: null, reason: message });
    else this.transition(task, 'failed', { reason: message });
  }
  async execute(task, account) {
    if (this.executing.has(task.id)) return;
    this.executing.add(task.id);
    this.transition(task, 'preparing', { prepared: null });
    try {
      const result = await this.adapter.prepare(clone(task), clone(account));
      if (task.status !== 'preparing') return;
      if (result.status === 'accepted') this.accepted(task, result.remote);
      else if (result.status === 'reconciling') this.reject(task, 'uncertain', result.reason || '平台提交结果待核实，不重复生成');
      else this.transition(task, 'awaiting_confirmation', { reason: result.reason || '页面需要人工确认当前生成选项', prepared: result.prepared || task.prepared });
    } catch (e) { this.reject(task, e.code || (task.submitIntentAt ? 'uncertain' : 'prepare'), e.message); }
    finally { this.executing.delete(task.id); }
  }
  async tick() {
    if (!this.adapter || this.tickBusy) return;
    this.tickBusy = true;
    try {
      this.adapter.syncIdleQuotas?.();
      for (const t of this.state.tasks) {
        if (['queued', 'waiting_account'].includes(t.status)) { const a = this.reserve(t); if (a) void this.execute(t, a); }
        if (t.status === 'download_pending' && !t.downloadHold && !this.downloading.has(t.id) && (!t.retryAt || t.retryAt <= this.clock())) void this.download(t.id);
        if (['running', 'reconciling'].includes(t.status) || t.platform === 'dola' && t.status === 'submission_review') {
          if (this.adapter.refreshTask) void this.adapter.refreshTask(t.id);
        }
      }
    } finally { this.tickBusy = false; }
  }
  recover() {
    for (const t of this.state.tasks) {
      if (['preparing', 'awaiting_confirmation', 'running'].includes(t.status)) {
        if(t.status==='awaiting_confirmation'&&t.paymentRequired&&t.submissionNotSentEvidence&&!t.submitIntentAt)continue;
        if(t.status==='awaiting_confirmation' && t.authorizationRequired && t.authorizationEvidence==='editor_not_message' && !t.submitIntentAt)continue;
        const attempt = this.find('attempts', t.attemptId);
        if(t.status==='awaiting_confirmation' && t.reviewBeforeSend && !t.submitIntentAt && attempt.phase==='reserved') {
          t.prepared=null;t.reason='发送前审阅尚未提交；重启后请重新准备素材与提示词';continue;
        }
        if (attempt.phase === 'reserved') attempt.phase = 'uncertain';
        Object.assign(t, { status: 'reconciling', reason: '程序重启：核实平台是否已提交或生成，未核实前不重复提交' });
      }
      if (t.status === 'downloading') t.status = 'download_pending';
    }
    this.save();
  }
  reconcile(id, resolution, info = {}) {
    const t = this.find('tasks', id); assert(['reconciling', 'awaiting_confirmation'].includes(t.status), '任务不需要提交确认');
    if (resolution === 'accepted') this.accepted(t, info);
    else if (resolution === 'not_submitted') { this.find('attempts', t.attemptId).phase = 'released'; this.transition(t, 'queued', { accountId: null, attemptId: null, reason: null, submitIntentAt: null, remote: null, remoteRequestId: null, parameterConfirmationAt: null, continuationPrompt: null }); }
    else throw new Error('请选择 accepted 或 not_submitted');
    return clone(t);
  }
  observe(accountId, observation) {
    if (!observation.vid) return;
    const match = this.state.observations.find(o => o.accountId === accountId && o.vid === observation.vid);
    if (match) Object.assign(match, observation); else this.state.observations.push({ ...observation, id: randomUUID(), accountId, capturedAt: this.clock() });
    this.state.observations = this.state.observations.slice(-2000); this.save();
  }
  attachVideo(id, vid, { verified = false, platformCompletedAt } = {}) {
    const t = this.find('tasks', id); assert(t.accountId, '任务没有生成账号');
    assert(typeof vid === 'string' && /^[\w-]{5,160}$/.test(vid), '视频 ID 格式不正确');
    assert(!this.state.tasks.some(x => x.id !== id && x.vid === vid && x.accountId === t.accountId), '视频已绑定其他任务');
    assert(['running', 'reconciling', 'awaiting_confirmation', 'download_pending', 'submission_review'].includes(t.status), '任务不能绑定视频');
    this.find('attempts', t.attemptId).phase = 'accepted';
    const timing = { resultDetectedAt: t.resultDetectedAt || this.clock() };
    if (Number.isFinite(platformCompletedAt) && platformCompletedAt > 0) timing.platformCompletedAt = platformCompletedAt;
    this.transition(t, 'download_pending', { ...timing, vid, watermarkVerified: !!verified, retryAt: null, reason: null, downloadHold: false }); return clone(t);
  }
  async download(id) {
    const t = this.find('tasks', id); assert(t.vid, '没有可下载的视频 ID');
    if (this.downloading.has(id)) return clone(t);
    this.downloading.add(id); this.transition(t, 'downloading', { firstDownloadStartedAt:t.firstDownloadStartedAt||t.downloadStartedAt||this.clock(),downloadStartedAt: this.clock(),downloadProgress:null,downloadBlocker:null });
    try {
      const output = await this.adapter.download(clone(t), clone(this.find('accounts', t.accountId)));
      assert(output.file && fs.existsSync(output.file), '下载文件不存在');
      const asset = this.registerAsset(output.file, { name: path.basename(output.file), kind: 'video' });
      if (output.mediaInfo) Object.assign(this.find('assets', asset.id), { mediaInfo: output.mediaInfo, sourceTaskId: id });
      const p = this.find('projects', t.projectId);
      const existing = p.nodes.find(n => n.type === 'video' && n.taskId === id);
      if (existing) existing.assetId = asset.id;
      else { const source = p.nodes.find(n => n.id === t.nodeId); p.nodes.push({ id: randomUUID(), type: 'video', x: (source?.x ?? 400) + 360, y: source?.y ?? 120, assetId: asset.id, name: source ? `${source.name} · 视频` : '生成视频', taskId: id, shotId: t.shotId, parentShotId: t.parentShotId, sequenceId: t.sequenceId, shotKind: t.shotKind }); }
      const outputNode = p.nodes.find(n => n.type === 'video' && n.taskId === id);
      if (t.nodeId && p.nodes.some(n => n.id === t.nodeId) && !p.edges.some(e => e.from === t.nodeId && e.to === outputNode.id)) p.edges.push({ id: randomUUID(), from: t.nodeId, to: outputNode.id, kind: 'output' });
      p.revision = (p.revision || 0) + 1; p.updatedAt = this.clock();
      this.transition(t, t.durationMismatch ? 'parameter_review' : t.watermarkVerified ? 'done' : 'download_pending', { downloadCompletedAt: this.clock(), localFile: output.file, outputAssetId: asset.id, downloadHold: !t.watermarkVerified || !!t.durationMismatch, source: 'platform_download', reason: t.durationMismatch ? t.parameterReview : t.watermarkVerified ? null : '已下载平台源文件，等待确认无可见水印', retries: 0 });
      this.event('download', '平台源文件已保存', id); this.save();
    } catch (e) {
      if (['login_required','region_restricted'].includes(e.code)) {
        this.transition(t,'download_pending',{reason:e.message,downloadBlocker:{code:e.code,accountId:t.accountId,at:this.clock()},downloadHold:true,retryAt:null});return clone(t);
      }
      if (e.code === 'account_busy') {
        this.transition(t, 'download_pending', { reason: e.message, retryAt: this.clock() + 3000, downloadHold: false }); return clone(t);
      }
      const retries = (t.retries || 0) + 1;
      this.transition(t, 'download_pending', { reason: e.message, retries, retryAt: this.clock() + Math.min(300000, 15000 * 2 ** retries), downloadHold: retries >= 3 });
    } finally { this.downloading.delete(id); }
    return clone(t);
  }
  verifyDownload(id, clean) { const t = this.find('tasks', id); assert(t.localFile, '请先下载视频'); t.watermarkVerified = !!clean; this.transition(t, t.durationMismatch ? 'parameter_review' : clean ? 'done' : 'download_pending', { downloadBlocker:null,downloadHold: !clean || !!t.durationMismatch, reason: t.durationMismatch ? t.parameterReview : clean ? null : '源视频仍有水印，保留结果待处理' }); return clone(t); }
  retryDownload(id) { const t = this.find('tasks', id); assert(t.vid && ['download_pending', 'done'].includes(t.status), '无法重试下载'); this.transition(t, 'download_pending', { downloadHold: false, retryAt: null, retries: 0 }); return clone(t); }
  deferSubmission(id) {
    const task=this.find('tasks',id);
    assert(['running','reconciling'].includes(task.status), '任务不在提交待核实状态');
    assert(!task.vid && !task.localFile, '已有作品，请先核对和下载作品');
    const submitted=task.submittedAt || task.submitIntentAt;
    assert(Number.isFinite(submitted) && this.clock()-submitted>=120*60000, '提交尚未等待120分钟，不能移入超时待核实');
    const attempt=this.find('attempts',task.attemptId);
    assert(['accepted','uncertain'].includes(attempt.phase), '尚未提交的任务应取消预留');
    // 仅停止轮询和账号占用；保留原请求、未知/已用预算，晚到作品仍可绑定。
    this.transition(task,'submission_review',{submissionReviewAt:this.clock(),reason:'提交超过120分钟仍无作品，保留原任务与预算等待核实，不自动重发'});
    this.event('submission_review','超时提交移入待核实，保留提交次数',id);
    return clone(task);
  }
  cancel(id) {
    const t = this.find('tasks', id), attempt = t.attemptId && this.find('attempts', t.attemptId);
    const unsubmitted = t.status === 'awaiting_confirmation' && !t.submitIntentAt && attempt?.phase === 'reserved';
    assert(['queued', 'waiting_account', 'failed'].includes(t.status) || unsubmitted, '已提交任务需在平台核实，不能释放账号或预算');
    if (unsubmitted) attempt.phase = 'released';
    this.transition(t, 'cancelled', { authorizationRequired: false, reason: unsubmitted ? '任务已取消，尚未提交的预留已释放' : '任务已取消' }); return clone(t);
  }
  validation(operation) {
    if (operation === 'start') { const old = this.state.settings.validationRun; if (!old?.active) { assert(!old || !this.state.tasks.some(t => t.validationRunId === old.id && BUSY.has(t.status)), '当前验证仍有未核实任务'); this.state.settings.validationRun = { id: randomUUID(), active: true, duration: 5, limits: { doubao: 2, dola: 2 }, startedAt: this.clock() }; this.save(); } }
    else if (operation === 'stop') { if (this.state.settings.validationRun) this.state.settings.validationRun.active = false; this.save(); }
    else assert(operation === 'status', '未知验证操作');
    const run = this.state.settings.validationRun; if (!run) return null;
    return clone({ ...run, usage: Object.fromEntries(Object.keys(PLATFORMS).map(platform => [platform, { used: this.state.attempts.filter(a => a.validationRunId === run.id && a.platform === platform && a.phase === 'accepted').length, reserved: this.state.attempts.filter(a => a.validationRunId === run.id && a.platform === platform && ['reserved', 'uncertain'].includes(a.phase)).length }])) });
  }
}
module.exports = { Studio, PLATFORMS, dayOf, nextDay, assert, BUSY };
