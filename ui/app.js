const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
const uuid = () => crypto.randomUUID();
const clone = value => structuredClone(value);
const statusName = { queued: '排队中', waiting_account: '等待账号', preparing: '准备素材', awaiting_confirmation: '页面待确认', running: '生成中', reconciling: '待核实提交', submission_review: '超时待核实', downloading: '下载中', download_pending: '下载待处理', done: '已下载', failed: '失败', parameter_review: '时长待处理', cancelled: '已取消' };
let state, system, project, baseline, selected, view = 'canvas', linking = null, dirty = false, saveTimer, savePromise, toastTimer, drag;
async function action(name, input = {}) {
  const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name, input }) });
  const body = await r.json(); if (!r.ok) throw new Error(body.error || '操作失败'); return body.result;
}
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 5500); }
const safe = fn => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message); } };
const asset = id => state.assets.find(a => a.id === id);
const media = id => `/asset/${encodeURIComponent(id)}`;
function common() {
  $('#task-count').textContent = state.tasks.filter(t => !['done', 'cancelled', 'failed'].includes(t.status)).length;
  $('#account-count').textContent = state.accounts.length;
  $('#platform-summary').innerHTML = Object.entries(state.platforms).map(([id, p]) => { const accounts = state.accounts.filter(a => a.platform === id); return `<div class="platform-item"><span class="platform-icon ${id}">${id === 'doubao' ? '豆' : 'D'}</span><div><strong>${esc(p.name)}</strong><small>${accounts.filter(a => a.login === 'ready').length} / ${accounts.length} 账号已就绪</small></div><span class="status-dot" ${accounts.some(a => a.login === 'ready') ? 'style="background:var(--accent)"' : ''}></span></div>`; }).join('');
  $('#project-select').innerHTML = state.projects.map(p => `<option value="${p.id}" ${p.id === project?.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#canvas-title').textContent = project?.name || '创作画布';
  $('#validation-status').textContent = state.settings.validationRun?.active ? '5秒验证 · 每平台最多2次 · 15秒未启用' : '';
  $('#connection').textContent = system.preview ? '画布预览 · 独立数据' : '本地桌面已连接';
}
async function refresh() {
  const incoming = await (await fetch('/api/state')).json();
  state = incoming;
  if (!project && state.projects.length) { project = clone(state.projects[0]); baseline = clone(project); }
  const remote = state.projects.find(p => p.id === project?.id);
  if (remote && !dirty && !savePromise && remote.revision !== project.revision && !$('#inspector').contains(document.activeElement)) { project = clone(remote); baseline = clone(project); renderCanvas(); renderInspector(); }
  common();
  if (view === 'accounts' && !$('#accounts-view').contains(document.activeElement)) renderAccounts();
  if (view === 'tasks' && !$('#tasks-view').contains(document.activeElement)) renderTasks();
  if (view === 'settings' && !$('#settings-view').contains(document.activeElement)) renderSettings();
  for (const el of document.querySelectorAll('[data-task-status]')) { const t = state.tasks.filter(t => t.nodeId === el.dataset.taskStatus).at(-1); el.textContent = t ? statusName[t.status] : '尚未提交'; }
  for (const el of document.querySelectorAll('[data-video-origin]')) el.textContent = VideoEvidence.describeVideo(state, el.dataset.videoOrigin).label;
  for (const el of document.querySelectorAll('[data-video-review]')) el.textContent = VideoEvidence.describeVideo(state, el.dataset.videoReview).reviewLabel;
}
function mergeRemote(remote, local, before) {
  const mergeItems = (key) => {
    const old = new Map(before[key].map(x => [x.id, x])); const mine = new Map(local[key].map(x => [x.id, x]));
    const result = remote[key].filter(x => !old.has(x.id) || mine.has(x.id)).map(x => mine.has(x.id) && JSON.stringify(mine.get(x.id)) !== JSON.stringify(old.get(x.id)) ? mine.get(x.id) : x);
    for (const x of local[key]) if (!result.some(r => r.id === x.id) && !old.has(x.id)) result.push(x);
    return result;
  };
  return { ...remote, name: local.name !== before.name ? local.name : remote.name, viewport: local.viewport, nodes: mergeItems('nodes'), edges: mergeItems('edges') };
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (savePromise) { await savePromise; if (dirty) return flushSave(); return; }
  if (!dirty || !project) return;
  const local = clone(project), before = clone(baseline); dirty = false;
  savePromise = (async () => {
    let p = local;
    try { p = await action('project.save', { id: local.id, patch: { ...local, expectedRevision: local.revision || 0 } }); }
    catch (e) {
      if (!e.message.includes('其他调用')) { dirty = true; throw e; }
      const remote = (await (await fetch('/api/state')).json()).projects.find(x => x.id === local.id);
      const merged = mergeRemote(remote, local, before); p = await action('project.save', { id: local.id, patch: { ...merged, expectedRevision: remote.revision || 0 } });
    }
    baseline = clone(p);
    if (!dirty) {
      // 编辑器事件绑定到节点对象；保存后保留对象身份，避免后续编辑写入旧副本。
      const keep = key => p[key].map(value => { const existing = project[key].find(x => x.id === value.id); return existing ? Object.assign(existing, value) : value; });
      const nodes = keep('nodes'), edges = keep('edges');
      Object.assign(project, p, { nodes, edges });
    } else project.revision = p.revision;
    $('#save-status').textContent = dirty ? '保存中…' : '已保存';
  })();
  try { await savePromise; } finally { savePromise = null; }
}
function queueSave() { dirty = true; $('#save-status').textContent = '保存中…'; clearTimeout(saveTimer); saveTimer = setTimeout(safe(flushSave), 500); }
function setView(next) {
  view = next;
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== `${next}-view`;
  for (const el of document.querySelectorAll('[data-view]')) el.classList.toggle('active', el.dataset.view === next);
  if (next === 'accounts') renderAccounts(); if (next === 'tasks') renderTasks(); if (next === 'settings') renderSettings();
}
function applyViewport() {
  const v = project.viewport; $('#scene').style.transform = `translate(${v.x}px,${v.y}px) scale(${v.scale})`;
  $('#zoom-level').textContent = `${Math.round(v.scale * 100)}%`;
  $('#canvas').style.backgroundPosition = `${v.x}px ${v.y}px`; $('#canvas').style.backgroundSize = `${22 * v.scale}px ${22 * v.scale}px`;
}
const modeName = mode => ({references:'参考图输入',first:'首帧输入',first_last:'首尾帧输入'}[mode] || '参考图输入');
const inputEdges = id => project.edges.filter(e => e.to === id && project.nodes.find(n => n.id === e.from)?.type === 'image' && (!e.kind || e.kind === 'input'));
const widthOf = n => n.width || (n.type === 'generation' ? 320 : 300);
function renderEdges() {
  if (!project) return;
  $('#edges').innerHTML = project.edges.map(e => {
    const a = project.nodes.find(n => n.id === e.from), b = project.nodes.find(n => n.id === e.to); if (!a || !b) return '';
    const x = a.x + widthOf(a), y = a.y + 60, tx = b.x, ty = b.y + 60, bend = Math.max(90, Math.abs(tx - x) * .5);
    return `<path d="M${x},${y} C${x + bend},${y} ${tx - bend},${ty} ${tx},${ty}"/>`;
  }).join('');
}
function renderCanvas() {
  if (!project) return;
  $('#empty-canvas').hidden = project.nodes.length > 0;
  $('#nodes').innerHTML = project.nodes.map(n => {
    const a = asset(n.assetId), isGeneration = n.type === 'generation';
    let body;
    if (n.type === 'image') body = a ? `<img src="${media(a.id)}" draggable="false" alt="${esc(n.name)}"><div class="node-footer"><span>参考素材</span><span>${(a.size / 1024 ** 2).toFixed(2)} MB</span></div>` : '<div class="generation-body">素材缺失</div>';
    else if (n.type === 'video') { const proof = VideoEvidence.describeVideo(state, n.assetId); body = a ? `<video src="${media(a.id)}" controls preload="metadata"></video><div class="node-footer"><span data-video-origin="${a.id}">${esc(proof.label)}</span><span data-video-review="${a.id}">${esc(proof.reviewLabel)}</span></div>` : '<div class="generation-body">等待视频结果</div>'; }
    else body = `<div class="generation-body"><div class="generation-platform"><span class="platform-badge">${esc(state.platforms[n.platform || 'doubao'].name)}</span><span>${modeName(n.mode)}</span></div><div class="prompt-preview">${esc(n.prompt || '选择节点，输入你的视频创意…')}</div></div><div class="node-footer"><span>${inputEdges(n.id).length} 个输入素材</span><span data-task-status="${n.id}">${statusName[state.tasks.filter(t=>t.nodeId===n.id).at(-1)?.status] || '尚未提交'}</span></div><button class="node-start" data-run-node="${n.id}">生成视频 ↗</button>`;
    return `<article class="node ${n.type} ${n.id === selected ? 'selected' : ''}" data-node="${n.id}" style="left:${n.x}px;top:${n.y}px;width:${widthOf(n)}px"><div class="node-header"><span class="node-icon">${isGeneration ? '✦' : n.type === 'image' ? '▧' : '▷'}</span><span>${esc(n.name || '未命名节点')}</span><span class="node-tag">${isGeneration ? 'GENERATE' : n.type.toUpperCase()}</span></div>${body}${isGeneration ? `<button class="port in" data-port="in" title="连接输入素材"></button>` : ''}<button class="port out ${linking === n.id ? 'linking' : ''}" data-port="out" title="连接到生成节点"></button></article>`;
  }).join('');
  renderEdges(); applyViewport();
}
function select(id) {
  selected = id; for (const el of document.querySelectorAll('[data-node]')) el.classList.toggle('selected', el.dataset.node === id); renderInspector();
}
async function openVideoReview(assetId) {
  const proof = await action('video.comparison', { assetId });
  await refresh();
  const frame = (id, label) => '<figure><figcaption>'+esc(label)+'</figcaption>'+(id?'<img src="'+media(id)+'" alt="'+esc(label)+'">':'<div class="frame-empty">未指定此图</div>')+'</figure>';
  $('#review-content').innerHTML='<p class="review-summary"><strong>'+esc(proof.label)+'</strong> · '+proof.mediaInfo.duration.toFixed(3)+'秒 · '+esc(proof.reviewLabel)+'</p><p class="help">'+esc(proof.notice)+'</p>'+(proof.sourceSegments.length?'<p class="help">拼接来源：'+proof.sourceSegments.map(id=>esc(asset(id)?.name||id)).join(' → ')+'</p>':'')+(proof.referenceAssetIds.length?'<div class="review-references">'+proof.referenceAssetIds.map(id=>frame(id,'参考素材（不锁定首尾）')).join('')+'</div>':'')+'<div class="review-grid">'+frame(proof.expectedFirstAssetId,'任务指定首图')+frame(proof.actualFirstAssetId,'视频实际首帧')+frame(proof.expectedLastAssetId,'任务指定尾图')+frame(proof.actualLastAssetId,'视频真实最后一帧')+'</div><label>播放完整视频，核对动作过程</label><video class="review-video" src="'+media(assetId)+'" controls preload="metadata"></video><p class="help" id="review-feedback">'+esc(proof.review.reason||'下载和时长检查不代表动作效果已通过，请实际播放后反馈。')+'</p><div class="account-actions"><button class="button primary" data-effect-verdict="passed">动作与画面符合预期</button><button class="button" data-effect-verdict="rejected">效果不符合预期</button><button class="button subtle" data-effect-verdict="pending">恢复待验收</button></div>';
  for(const button of document.querySelectorAll('[data-effect-verdict]')) button.onclick=safe(async()=>{const verdict=button.dataset.effectVerdict;let reason='';if(verdict==='rejected'){reason=prompt('请说明未完成的动作或首尾画面问题',proof.review.reason||'动作幅度不足，未完成脚本要求');if(reason===null)return;}button.disabled=true;try{await action('video.review',{assetId,verdict,reason});await refresh();renderCanvas();renderInspector();await openVideoReview(assetId);toast('效果反馈已保存，不会自动重新生成');}finally{button.disabled=false;}});
  if(!$('#review-dialog').open) $('#review-dialog').showModal();
}
$('#close-review').onclick=()=>{$('#review-content').querySelector('video')?.pause();$('#review-dialog').close();};
$('#review-dialog').addEventListener('close',()=>$('#review-content').querySelector('video')?.pause());
function renderInspector() {
  const n = project?.nodes.find(n => n.id === selected);
  if (!n) { $('#inspector').innerHTML = '<span class="eyebrow">NODE INSPECTOR</span><h3>把镜头连接起来</h3><p>同一镜头使用真实尾帧续接；切换分镜时使用新图片。选择视频节点即可准备下一段。</p>'; return; }
  let detail='';
  if(n.type==='generation') {
    detail = '<label for="node-platform">生成平台</label><select id="node-platform">'+Object.entries(state.platforms).map(([id,p])=>'<option value="'+id+'" '+(id===n.platform?'selected':'')+'>'+esc(p.name)+'</option>').join('')+'</select>';
    detail += '<label for="node-mode">输入模式</label><select id="node-mode">'+Object.entries({references:'多图参考',first:'原生首帧',first_last:'首尾帧控制'}).map(([id,label])=>'<option value="'+id+'" '+(id===n.mode?'selected':'')+'>'+label+'</option>').join('')+'</select>';
    detail += '<label for="node-prompt">下一段动作与镜头</label><textarea id="node-prompt" placeholder="描述人物、动作和镜头…">'+esc(n.prompt)+'</textarea><div class="field-pair"><div><label for="node-duration">时长（秒）</label><input id="node-duration" type="number" min="1" max="120" placeholder="平台默认" value="'+esc(n.duration)+'"></div><div><label for="node-ratio">画面比例</label><select id="node-ratio">'+['','1:1','3:4','4:3','9:16','16:9','21:9'].map(x=>'<option value="'+x+'" '+(x===n.ratio?'selected':'')+'>'+(x||'平台默认')+'</option>').join('')+'</select></div></div>';
    detail += '<label for="node-model">模型（可选）</label><input id="node-model" value="'+esc(n.model)+'" placeholder="国内默认 Seedance 2.0 Fast">';
    if(Number(n.duration)===15 && n.platform==='doubao') detail += '<p class="help">15秒增强只作用于此任务，提交前核对平台反馈，下载后核对实际时长；按当前模型、时长和平台额度反馈分配，不设未经验证的每日一条限制。</p>';
    if(Number(n.duration)===30 && n.platform==='dola') detail += '<p class="help">30秒兼容测试仅适用于Seedance 2.5；网页未显示该时长时按当前任务传入参数，由平台校验。以下载视频的实际时长为准。</p>';
    detail += '<label>输入素材与角色</label>'+inputEdges(n.id).map(e=>{const from=project.nodes.find(x=>x.id===e.from);return '<div class="reference-item"><img src="'+media(from.assetId)+'" alt=""><span>'+esc(from.name)+'</span><select data-edge-role="'+e.id+'">'+[['reference','参考图'],['first','首帧'],['last','尾帧']].map(([v,label])=>'<option value="'+v+'" '+(v===(e.role||'reference')?'selected':'')+'>'+label+'</option>').join('')+'</select><button class="icon-button" data-remove-edge="'+e.id+'" title="移除连线">×</button></div>';}).join('');
    if(!inputEdges(n.id).length) detail += '<p>等待新镜头图片，可由 Agent 生图并自动导入，或手动连接图片。</p>';
    detail += '<button id="inspector-run" class="button primary full">提交生成任务 ↗</button><p class="help">这里设置的是输入模式，尚未提交的节点没有视频效果。后台核对平台原生首尾能力、时长和额度；识别不明时等待反馈。</p>';
  } else if(n.type==='video') {
    const info=asset(n.assetId)?.mediaInfo;
    const proof=VideoEvidence.describeVideo(state,n.assetId);
    detail='<p>'+(info ? info.duration.toFixed(3)+'秒 · '+info.width+'×'+info.height+'<br>' : '')+'同镜头继承最后一帧；新分镜使用新图片。</p><button id="continue-shot" class="button primary full">用尾帧继续同一镜头</button><label for="shot-image">新分镜首图（可选）</label><select id="shot-image"><option value="">先创建，等待 Agent 提供新图</option>'+state.assets.filter(a=>a.kind==='image').map(a=>'<option value="'+a.id+'">'+esc(a.name)+'</option>').join('')+'</select><button id="new-shot" class="button full">创建新分镜</button><div class="field-pair"><button id="first-frame" class="button">提取首帧</button><button id="last-frame" class="button">精确尾帧</button></div><label for="frame-time">指定时间（秒）</label><input id="frame-time" type="number" value="1" min="0" step="0.01"><button id="time-frame" class="button full">提取此刻画面</button><button id="reveal-file" class="button subtle full">打开文件所在位置</button>';
    detail='<div class="video-proof"><strong>'+esc(proof.label)+'</strong><span class="badge '+(proof.review.verdict==='rejected'?'warn':'muted')+'">'+esc(proof.reviewLabel)+'</span><p>'+esc(proof.notice)+'</p>'+(proof.review.reason?'<p class="help error">反馈：'+esc(proof.review.reason)+'</p>':'')+'<button id="compare-video" class="button primary full">查看首尾与动作对照</button></div>'+detail;
  } else detail='<p>连接图片到生成节点，并指定首帧、尾帧或参考图。</p><label for="node-width">节点宽度</label><input id="node-width" type="range" min="200" max="600" value="'+widthOf(n)+'"><button id="reveal-file" class="button subtle full">打开素材所在位置</button>';
  $('#inspector').innerHTML='<span class="eyebrow">'+n.type.toUpperCase()+' NODE</span><h3>'+esc(n.name)+'</h3><label for="node-name">节点名称</label><input id="node-name" value="'+esc(n.name)+'">'+detail+'<button id="delete-node" class="button subtle danger full">删除节点</button>';
  $('#node-name').oninput=e=>{n.name=e.target.value;queueSave();const h=document.querySelector('[data-node="'+n.id+'"] .node-header>span:nth-child(2)');if(h)h.textContent=n.name;};
  $('#delete-node').onclick=()=>{project.nodes=project.nodes.filter(x=>x.id!==n.id);project.edges=project.edges.filter(e=>e.from!==n.id&&e.to!==n.id);selected=null;queueSave();renderCanvas();renderInspector();};
  if($('#node-width')) $('#node-width').oninput=e=>{n.width=Number(e.target.value);renderCanvas();queueSave();};
  if($('#reveal-file')) $('#reveal-file').onclick=safe(()=>action('file.reveal',{assetId:n.assetId}));
  if(n.type==='generation') {
    for(const [id,field] of Object.entries({'node-platform':'platform','node-mode':'mode','node-prompt':'prompt','node-duration':'duration','node-ratio':'ratio','node-model':'model'})) $('#'+id).addEventListener(field==='prompt'?'input':'change',e=>{n[field]=field==='duration'&&e.target.value?Number(e.target.value):e.target.value;if(field==='mode'){let i=0;for(const edge of inputEdges(n.id))edge.role=n.mode==='references'?'reference':i++===0?'first':'last';}queueSave();renderCanvas();if(['mode','duration','platform'].includes(field))renderInspector();});
    for(const el of document.querySelectorAll('[data-edge-role]')) el.onchange=()=>{project.edges.find(e=>e.id===el.dataset.edgeRole).role=el.value;queueSave();};
    for(const el of document.querySelectorAll('[data-remove-edge]')) el.onclick=()=>{project.edges=project.edges.filter(e=>e.id!==el.dataset.removeEdge);queueSave();renderCanvas();renderInspector();};
    $('#inspector-run').onclick=safe(()=>submitNode(n.id));
  }
  if(n.type==='video') {
    $('#compare-video').onclick=safe(async()=>{const button=$('#compare-video');button.disabled=true;try{await openVideoReview(n.assetId);}finally{button.disabled=false;}});
    for(const [id,kind] of [['continue-shot','continue'],['new-shot','new']]) $('#'+id).onclick=safe(async()=>{const button=$('#'+id);button.disabled=true;try{await flushSave();const imageAssetId=$('#shot-image').value;const result=await action('shot.create',{projectId:project.id,kind,sourceVideoAssetId:n.assetId,...(kind==='new'&&imageAssetId?{imageAssetId}:{}),idempotencyKey:uuid()});await refresh();selected=result.nodeId;renderCanvas();renderInspector();$('#fit-canvas').click();toast('下一段已准备，请编辑动作并检查图片后提交');}finally{button.disabled=false;}});
    for(const [id,position] of [['first-frame','first'],['last-frame','last'],['time-frame',null]]) $('#'+id).onclick=safe(async()=>{const button=$('#'+id);button.disabled=true;try{const image=await action('video.frame',{assetId:n.assetId,position,time:Number($('#frame-time').value)});state.assets.push(image);const added=addAssetNode(image,{x:n.x+widthOf(n)+65,y:n.y+40});project.edges.push({id:uuid(),from:n.id,to:added.id,kind:'frame'});queueSave();renderEdges();toast('画面已提取并加入画布');}finally{button.disabled=false;}});
  }
}
function addAssetNode(a, position) {
  const v = project.viewport;
  const n = { id: uuid(), type: a.kind, name: a.name, assetId: a.id, x: position?.x ?? (110 - v.x) / v.scale + project.nodes.length % 4 * 45, y: position?.y ?? (100 - v.y) / v.scale + project.nodes.length % 4 * 45 };
  project.nodes.push(n); selected = n.id; queueSave(); renderCanvas(); renderInspector(); return n;
}
async function importFiles(kind) {
  if (system.desktop) {
    const assets = await action('asset.pick', { kind }); for (const a of assets) { state.assets.push(a); addAssetNode(a); }
  } else { $('#file-input').accept = kind === 'image' ? 'image/*' : 'video/*'; $('#file-input').dataset.kind = kind; $('#file-input').click(); }
}
$('#file-input').onchange = safe(async e => { for (const file of e.target.files) { if (file.size > 30 * 1024 ** 2) throw new Error('预览上传限制 30MB；桌面版可直接选择本地视频'); const data = await new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result.split(',')[1]); r.readAsDataURL(file); }); const a = await action('asset.upload', { name: file.name, kind: e.target.dataset.kind, data }); state.assets.push(a); addAssetNode(a); } e.target.value = ''; });
async function submitNode(id) {
  await flushSave(); const n = project.nodes.find(x => x.id === id);
  const refs = inputEdges(id).map(e => ({ assetId: project.nodes.find(x => x.id === e.from).assetId, role: e.role || 'reference' }));
  const task = await action('task.submit', { projectId: project.id, nodeId: id, platform: n.platform || 'doubao', prompt: n.prompt, mode: n.mode || 'references', refs, ...(n.duration ? { duration: Number(n.duration) } : {}), ...(n.ratio ? { ratio: n.ratio } : {}), ...(n.model ? {model:n.model} : {}), ...(state.settings.validationRun?.active ? {validationRunId:state.settings.validationRun.id} : {}), idempotencyKey: uuid() });
  await refresh(); toast(`任务已入队 · ${task.id.slice(0, 8)}`);
}
function zoom(factor, point) {
  const v = project.viewport, rect = $('#canvas').getBoundingClientRect();
  const p = point || { x: rect.width / 2, y: rect.height / 2 }, next = Math.min(3, Math.max(.1, v.scale * factor));
  v.x = p.x - (p.x - v.x) / v.scale * next; v.y = p.y - (p.y - v.y) / v.scale * next; v.scale = next; applyViewport(); queueSave();
}
$('#canvas').onwheel = e => { e.preventDefault(); const r = $('#canvas').getBoundingClientRect(); zoom(Math.exp(-e.deltaY * .0015), { x: e.clientX - r.left, y: e.clientY - r.top }); };
$('#canvas').addEventListener('pointerdown', e => {
  const node = e.target.closest('[data-node]'), port = e.target.closest('[data-port]');
  if (port) {
    e.stopPropagation(); const id = node.dataset.node;
    if (port.dataset.port === 'out') { const n = project.nodes.find(x => x.id === id); if (n.type !== 'image') { toast('请先将视频抽帧为图片，再连接生成节点'); return; } linking = linking === id ? null : id; renderCanvas(); }
    else if (linking && linking !== id) { if (!project.edges.some(x => x.from === linking && x.to === id)) { const target = project.nodes.find(x => x.id === id); const count = inputEdges(id).length; if (target.mode === 'first' && count) target.mode='first_last'; project.edges.push({ id: uuid(), from: linking, to: id, kind:'input', role: target.mode === 'references' ? 'reference' : count ? 'last' : 'first' }); queueSave(); } linking = null; select(id); renderCanvas(); }
    return;
  }
  if (node) {
    select(node.dataset.node);
    if (!e.target.closest('.node-header')) return;
    const n = project.nodes.find(x => x.id === node.dataset.node); drag = { id: n.id, x: e.clientX, y: e.clientY, originX: n.x, originY: n.y };
  } else { select(null); linking = null; drag = { x: e.clientX, y: e.clientY, originX: project.viewport.x, originY: project.viewport.y }; }
  $('#canvas').setPointerCapture(e.pointerId);
});
$('#canvas').onpointermove = e => {
  if (!drag) return;
  if (drag.id) { const n = project.nodes.find(x => x.id === drag.id); n.x = Math.round(drag.originX + (e.clientX - drag.x) / project.viewport.scale); n.y = Math.round(drag.originY + (e.clientY - drag.y) / project.viewport.scale); const el = document.querySelector(`[data-node="${n.id}"]`); el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; renderEdges(); }
  else { project.viewport.x = drag.originX + e.clientX - drag.x; project.viewport.y = drag.originY + e.clientY - drag.y; applyViewport(); }
};
$('#canvas').onpointerup = () => { if (drag) { drag = null; queueSave(); } };
$('#canvas').onpointercancel = () => { drag = null; queueSave(); };
$('#nodes').onclick = safe(e => { const button = e.target.closest('[data-run-node]'); if (button) return submitNode(button.dataset.runNode); });
$('#zoom-in').onclick = () => zoom(1.15); $('#zoom-out').onclick = () => zoom(1 / 1.15);
$('#fit-canvas').onclick = () => {
  if (!project.nodes.length) return;
  const r = $('#canvas').getBoundingClientRect(), minX = Math.min(...project.nodes.map(n => n.x)), minY = Math.min(...project.nodes.map(n => n.y));
  const maxX = Math.max(...project.nodes.map(n => n.x + widthOf(n))), maxY = Math.max(...project.nodes.map(n => n.y + 380));
  const s = Math.max(.1, Math.min(1, (r.width - 100) / (maxX - minX), (r.height - 100) / (maxY - minY)));
  project.viewport = { x: (r.width - (maxX - minX) * s) / 2 - minX * s, y: 50 - minY * s, scale: s }; applyViewport(); queueSave();
};
$('#add-image').onclick = safe(() => importFiles('image')); $('#add-video').onclick = safe(() => importFiles('video'));
$('#add-generation').onclick = () => { const v = project.viewport; const n = { id: uuid(), type: 'generation', name: '视频生成', x: (300 - v.x) / v.scale, y: (140 - v.y) / v.scale, platform: 'doubao', mode: 'references', prompt: '', duration: '', ratio: '' }; project.nodes.push(n); selected = n.id; queueSave(); renderCanvas(); renderInspector(); };
for (const el of document.querySelectorAll('[data-view]')) el.onclick = () => setView(el.dataset.view);
$('#project-select').onchange = safe(async e => { await flushSave(); project = clone(state.projects.find(p => p.id === e.target.value)); baseline = clone(project); selected = null; renderCanvas(); renderInspector(); common(); });
$('#new-project').onclick = safe(async () => { const name = prompt('项目名称', '新视频项目'); if (!name?.trim()) return; await flushSave(); project = await action('project.create', { name: name.trim() }); baseline = clone(project); selected = null; await refresh(); setView('canvas'); renderCanvas(); renderInspector(); });
$('#rename-project').onclick = () => { const name = prompt('项目名称', project.name); if (!name?.trim()) return; project.name = name.trim(); queueSave(); $('#canvas-title').textContent = project.name; };
function cookieExpiry(info) {
  if (!info.expiresAt || info.unknownAuthExpiry) return '登录有效期未知';
  return 'Cookie 到期参考：' + new Date(info.expiresAt).toLocaleString();
}
function cookieStatus(a) {
  const c = a.cookieLogin; if (!c) return '';
  return `<div class="cookie-status"><strong>Cookie 登录 · ${c.checkState === 'checking' ? '后台检测中' : c.checkState === 'verified' && a.login === 'ready' ? '检测已通过' : '等待检测通过'}</strong><span>${c.count} 个 Cookie · ${esc(cookieExpiry(c))}</span><small>${c.storageError ? '加密会话保存失败，请重新导入' : '本机加密保存 · 到期时间不保证登录持续有效'}</small></div>`;
}
let cookieImportKey;
function openCookieImport(id = '') {
  $('#cookie-form').reset(); $('#cookie-error').textContent = ''; $('#cookie-text').classList.add('masked'); $('#cookie-show').textContent = '显示内容'; $('#cookie-show').setAttribute('aria-pressed', 'false');
  $('#cookie-target').innerHTML = '<option value="">新建账号</option>' + state.accounts.map(a => `<option value="${a.id}">${esc(a.name)} · ${esc(state.platforms[a.platform].name)}</option>`).join('');
  $('#cookie-target').value = id; cookieImportKey = uuid(); syncCookieTarget(); $('#cookie-dialog').showModal();
}
function syncCookieTarget() {
  const a = state.accounts.find(a => a.id === $('#cookie-target').value);
  for (const field of ['platform', 'name', 'limit']) $('#cookie-' + field).disabled = !!a;
  $('#cookie-title').textContent = a ? '更新账号 Cookie' : '导入 Cookie 账号';
  if (a) { $('#cookie-platform').value = a.platform; $('#cookie-name').value = a.name; $('#cookie-limit').value = a.dailyLimit; }
  $('#cookie-limit').parentElement.hidden=$('#cookie-platform').value==='doubao';
  $('#cookie-summary').textContent = a ? '替换此账号登录会话；预算和历史用量保留。' : '支持 Cookie-Editor JSON 和 Cookie 文本。说明、卡密不会进入账号记录。';
  cookieImportKey = uuid();
}
$('#cookie-target').onchange = syncCookieTarget;
$('#cookie-platform').onchange=()=>{$('#cookie-limit').parentElement.hidden=$('#cookie-platform').value==='doubao';};
$('#close-cookie').onclick = () => $('#cookie-dialog').close();
$('#cookie-dialog').addEventListener('close', () => { $('#cookie-text').value = ''; $('#cookie-file').value = ''; });
$('#cookie-show').onclick = () => { const masked = $('#cookie-text').classList.toggle('masked'); $('#cookie-show').textContent = masked ? '显示内容' : '隐藏内容'; $('#cookie-show').setAttribute('aria-pressed', String(!masked)); };
$('#cookie-text').oninput = () => { cookieImportKey = uuid(); $('#cookie-summary').textContent = '内容已修改，导入前会重新检查格式。'; $('#cookie-error').textContent = ''; };
$('#cookie-file').onchange = async e => {
  try { const file = e.target.files[0]; if (!file) return; if (file.size > 256 * 1024) throw new Error('文件不得超过 256KB'); $('#cookie-text').value = await file.text(); cookieImportKey = uuid(); $('#cookie-summary').textContent = '文件已读取，内容默认隐藏。点击检查格式或直接导入。'; $('#cookie-error').textContent = ''; }
  catch (error) { $('#cookie-error').textContent = error.message; }
};
const cookieInput = () => ({ accountId: $('#cookie-target').value || undefined, platform: $('#cookie-platform').value, name: $('#cookie-name').value, dailyLimit: Number($('#cookie-limit').value), cookieText: $('#cookie-text').value, idempotencyKey: cookieImportKey });
$('#cookie-preview').onclick = async () => {
  try { const s = await action('account.cookiePreview', cookieInput()); $('#cookie-summary').textContent = `格式通过 · ${s.count} 个 Cookie · ${cookieExpiry(s)}${s.ignoredLines ? ' · 已忽略说明和卡密行' : ''}${s.expiredSkipped ? ' · 已跳过 ' + s.expiredSkipped + ' 个过期 Cookie' : ''}`; $('#cookie-error').textContent = ''; }
  catch (e) { $('#cookie-error').textContent = e.message; }
};
$('#cookie-form').onsubmit = async e => {
  e.preventDefault(); const button = $('#cookie-submit'); button.disabled = true; $('#cookie-error').textContent = ''; $('#cookie-summary').textContent = '正在检查、加密并保存会话…';
  $('#close-cookie').disabled = true; const cancel = ev => ev.preventDefault(); $('#cookie-dialog').addEventListener('cancel', cancel);
  try { const result = await action('account.importCookies', cookieInput()); $('#cookie-dialog').close(); await refresh(); renderAccounts(); toast(result.login === 'ready' ? 'Cookie 登录检测通过' : 'Cookie 已加密保存，账号卡片将显示后台检测结果'); }
  catch (error) { $('#cookie-error').textContent = error.message; }
  finally { button.disabled = false; $('#close-cookie').disabled = false; $('#cookie-dialog').removeEventListener('cancel', cancel); }
};
function autoQuotaCard(a) {
  const q=a.platformQuota,capacity=a.usage.capacity;
  const percent=q?.windows?.map(w=>w.usedPercent).filter(x=>typeof x==='number').sort((x,y)=>y-x)[0];
  return '<div class="usage-text">今日提交 '+a.usage.used+' · 预留 '+a.usage.reserved+(a.usage.busy?' · 账号忙碌':'')+'</div><div class="quota-summary"><strong>自动额度管理 · 默认 Seedance 2.0 Fast</strong><div>'+esc(q?.plan||'账号权益待同步')+'</div>'+(typeof percent==='number'?'<div>平台时段用量 '+percent+'%（不能换算为视频条数）</div>':'')+'<div>'+esc(capacity?.balanceKnown?'5秒参考任务：剩余 '+capacity.remaining+'，单条消耗 '+capacity.cost:capacity?.reason||'免费余额与时长消耗待平台确认')+'</div><small>7秒 / 15秒分别核对，不按已提交条数耗尽账号。</small></div>'+(a.quotaSyncError?'<p class="help error">'+esc(a.quotaSyncError)+'</p>':'');
}
function renderAccounts() {
  const ready = state.accounts.filter(a => a.login === 'ready').length;
  $('#accounts-view').innerHTML = `<div class="page-heading"><div><div class="page-kicker">ACCOUNT POOL</div><h1>让账号协同工作</h1><p>每个账号拥有独立登录会话，国内与海外分别轮询。</p></div><div class="tools"><button id="import-cookie" class="button">导入 Cookie</button><button id="add-account" class="button primary">＋ 添加账号</button></div></div><div class="stats-row"><div class="stat"><small>已添加账号</small><strong>${state.accounts.length}</strong></div><div class="stat"><small>当前已就绪</small><strong>${ready}</strong></div><div class="stat"><small>今日已提交 / 预留</small><strong>${state.accounts.reduce((s, a) => s + a.usage.used, 0)} <span style="color:#71838b;font-size:17px">/ ${state.accounts.reduce((s, a) => s + a.usage.reserved, 0)}</span></strong></div></div><div class="account-grid">${state.accounts.map(a => `<article class="account-card" data-account="${a.id}"><span class="badge ${a.login === 'ready' ? '' : 'muted'}">${a.login === 'ready' ? '已就绪' : a.login === 'login_required' ? '需要登录' : '待检测'}</span><span class="platform-icon ${a.platform}">${a.platform === 'doubao' ? '豆' : 'D'}</span><h3>${esc(a.name)}</h3>${a.quotaMode==='auto'?autoQuotaCard(a):`<div class="usage-meter"><span style="width:${Math.min(100, (a.usage.used + a.usage.reserved) / Math.max(1, a.dailyLimit) * 100)}%"></span></div><div class="usage-text">已用 ${a.usage.used} · 预留 ${a.usage.reserved} · 可用 ${a.usage.available}${a.usage.busy ? ' · 账号忙碌' : ''}</div><div class="field-pair"><div><label>每日次数预算</label><input type="number" min="0" max="10000" data-limit value="${a.dailyLimit}"></div><div><label>校准今日总用量</label><input type="number" min="${a.usage.used}" max="10000" data-used value="${a.usage.used}"></div></div><div class="quota-summary">${['standard','15s'].map(key=>{const q=a.usage.buckets?.[key];return q?'<div>'+(key==='15s'?'15秒':'短片/默认')+'：已用 '+q.used+' · 预留 '+q.reserved+' · 本地剩余 '+q.available+'</div>':'';}).join('')}<small>${a.usage.quotaRelation==='independent'?'已确认独立额度':a.usage.quotaRelation==='shared'?'已确认共享额度':'共享关系待核实，按总预算分配'}</small></div>`}${a.blockedUntil > Date.now() ? `<p class="help error">${esc(a.blockReason || '平台额度不足')}；暂停至 ${new Date(a.blockedUntil).toLocaleString()}</p>` : ''}${cookieStatus(a)}<div class="account-actions"><button data-account-action="cookies" class="button">${a.cookieLogin ? '更新 Cookie' : '导入 Cookie'}</button><button data-account-action="open" class="button">打开登录</button><button data-account-action="probe" class="button primary">检测登录</button>${a.quotaMode==='auto'?'<button data-account-action="quota" class="button">同步平台额度</button>':'<button data-account-action="save" class="button">保存预算</button>'}<button data-account-action="unblock" class="button subtle">重新检查</button><button data-account-action="remove" class="button subtle danger">移除</button></div><p class="help">${esc(a.loginDetail || '首次使用请登录，然后检测会话。')}</p></article>`).join('')}</div>${!state.accounts.length ? '<div class="empty-state"><strong>还没有账号</strong>添加第一个豆包或 Dola 账号，登录完成后任务会自动开始分配。</div>' : ''}`;
  $('#add-account').onclick = () => $('#account-dialog').showModal();
  $('#import-cookie').onclick = () => openCookieImport();
  for (const el of document.querySelectorAll('[data-account-action]')) el.onclick = safe(async () => {
    const card = el.closest('[data-account]'), id = card.dataset.account, type = el.dataset.accountAction;
    if (type === 'cookies') { openCookieImport(id); return; }
    el.disabled = true;
    try {
      if (type === 'save') await action('account.update', { id, patch: { dailyLimit: Number(card.querySelector('[data-limit]').value), todayUsed: Number(card.querySelector('[data-used]').value) } });
      else if (type === 'unblock') { await action('account.update', { id, patch: { clearBlock: true } }); await action('account.probe', { id }); if(state.accounts.find(a=>a.id===id)?.quotaMode==='auto')await action('account.quota',{id}); }
      else if (type === 'remove') { if (!confirm('移除此账号？本地任务记录会保留。')) return; await action('account.remove', { id }); }
      else await action(`account.${type}`, { id });
      await refresh(); renderAccounts();
    } finally { el.disabled = false; }
  });
}
function accountBudgetFields(){const domestic=$('#account-platform').value==='doubao';$('#account-limit').closest('label').hidden=domestic;$('#account-budget-help').textContent=domestic?'国内账号自动同步平台反馈，默认 Fast；免费余额未知时逐任务核对，不手填每日次数。':'Dola继续使用本地次数预算。';}
$('#account-platform').onchange=accountBudgetFields;accountBudgetFields();
$('#close-account').onclick = () => $('#account-dialog').close();
$('#account-form').onsubmit = safe(async e => {
  e.preventDefault(); const account = await action('account.add', { name: $('#account-name').value, platform: $('#account-platform').value, dailyLimit: Number($('#account-limit').value),quotaMode:$('#account-platform').value==='doubao'?'auto':'manual' }); $('#account-dialog').close(); $('#account-name').value = ''; await refresh(); renderAccounts();
  if (system.desktop) await action('account.open', { id: account.id }); else toast('账号已添加。平台登录请使用桌面版。');
});
function renderTasks() {
  const accountName = id => state.accounts.find(a => a.id === id)?.name || '尚未分配';
  const label = t => t.status === 'download_pending' && t.downloadBlocker?.code === 'login_required' ? '下载暂停 · 需登录' : t.status === 'download_pending' && t.downloadBlocker?.code === 'region_restricted' ? '下载暂停 · 检查网络' : t.status === 'download_pending' && t.localFile ? /源视频仍有水印/.test(t.reason || '') ? '已下载 · 有水印' : '已下载 · 水印待确认' : statusName[t.status];
  const timing = t => {
    const parts = [], time = value => new Date(value).toLocaleTimeString();
    if (t.platformCompletedAt) parts.push(`平台成片 ${time(t.platformCompletedAt)}`);
    if (t.resultDetectedAt) parts.push(`发现作品 ${time(t.resultDetectedAt)}`);
    if (t.downloadCompletedAt) parts.push(`下载完成 ${time(t.downloadCompletedAt)}`);
    if (t.status !== 'downloading' && t.downloadCompletedAt && t.downloadStartedAt) parts.push(`本次下载耗时 ${Math.max(0, (t.downloadCompletedAt - t.downloadStartedAt) / 1000).toFixed(1)} 秒`);
    if (t.status === 'downloading' && t.downloadProgress) parts.push(`已接收 ${(t.downloadProgress.received / 1024 / 1024).toFixed(1)} MB${t.downloadProgress.total > 0 ? ` / ${(t.downloadProgress.total / 1024 / 1024).toFixed(1)} MB` : ''}`);
    if (t.platform === 'dola' && ['running', 'reconciling'].includes(t.status) && !t.vid) parts.push(`后台每20秒核对，成片后自动下载${t.completionCheckedAt ? ` · 上次核对 ${time(t.completionCheckedAt)}` : ''}${t.completionCheckNote ? ` · ${t.completionCheckNote}` : ''}`);
    return parts.length ? `<div class="task-meta">${esc(parts.join(' · '))}</div>` : '';
  };
  $('#tasks-view').innerHTML = `<div class="page-heading"><div><div class="page-kicker">GENERATION QUEUE</div><h1>任务与生成结果</h1><p>提交、生成与下载分别记录，失败后保留已有结果。</p></div><span class="badge">最多 3 条并行 · 每账号 1 条</span></div><div class="task-list">${state.tasks.slice().reverse().map(t => `<article class="task-card" data-task="${t.id}"><div class="task-top"><h3>${esc(t.prompt.slice(0, 110))}</h3><span class="badge ${['done', 'running'].includes(t.status) ? '' : 'warn'}">${label(t)}</span></div><div class="task-meta">${esc(state.platforms[t.platform].name)} · ${esc(accountName(t.accountId))} · ${t.id.slice(0, 8)} · ${new Date(t.createdAt).toLocaleString()} · ${modeName(t.mode)}</div>${timing(t)}${t.reason ? `<div class="task-reason">${esc(t.reason)}</div>` : ''}${t.authorizationRequired ? `<div class="authorization-text">${esc(t.authorizationText)}</div>` : ""}${t.outputAssetId ? `<video src="${media(t.outputAssetId)}" controls preload="metadata"></video>` : ''}<div class="account-actions">${t.authorizationRequired ? '<button data-task-action="authorize" class="button primary">查看声明并同意</button><button data-task-action="decline" class="button subtle">暂不提交</button>' : ''}${t.accountId ? '<button data-task-action="open" class="button">打开账号页面</button>' : ''}${t.status === 'awaiting_confirmation' && !t.authorizationRequired ? '<button data-task-action="continue" class="button primary">继续准备</button>' : ''}${!t.authorizationRequired && ['awaiting_confirmation', 'reconciling'].includes(t.status) ? '<button data-task-action="accepted" class="button">确认平台已提交</button><button data-task-action="notSubmitted" class="button subtle">确认尚未提交</button>' : ''}${!t.authorizationRequired && ['running', 'reconciling', 'awaiting_confirmation'].includes(t.status) ? '<button data-task-action="attach" class="button">关联已生成视频</button>' : ''}${t.vid && t.status === 'download_pending' ? '<button data-task-action="download" class="button">重试下载</button>' : ''}${t.localFile && t.status !== 'done' ? '<button data-task-action="clean" class="button primary">确认无可见水印</button><button data-task-action="watermarked" class="button subtle">仍有水印</button>' : ''}${(['queued', 'waiting_account', 'failed'].includes(t.status) || t.status === 'awaiting_confirmation' && !t.submitIntentAt) ? '<button data-task-action="cancel" class="button subtle">取消任务</button>' : ''}${t.outputAssetId ? '<button data-task-action="reveal" class="button subtle">打开文件位置</button>' : ''}</div></article>`).join('')}</div>${!state.tasks.length ? '<div class="empty-state"><strong>你的下一段视频，从画布开始</strong>连接参考图与生成节点，或者通过 MCP 提交任务。</div>' : ''}`;
  for (const el of document.querySelectorAll('[data-task-action]')) el.onclick = safe(async () => {
    const t = state.tasks.find(x => x.id === el.closest('[data-task]').dataset.task), type = el.dataset.taskAction; el.disabled = true;
    try {
      if (type === 'open') await action('account.open', { id: t.accountId });
      if (type === 'authorize' || type === 'decline') { const accepted=type==='authorize'; if(accepted && !confirm(t.authorizationText+'\n\n同意上述声明，并继续本次任务？'))return; await action('task.authorize',{id:t.id,accepted,declaration:t.authorizationText}); }
      if (type === 'continue') await action('task.continue', { id: t.id });
      if (type === 'accepted') { const url = prompt('请粘贴当前已提交任务的会话网址（用于准确关联结果，可留空后手动关联）', ''); if (url === null) return; let conversationId; if (url) { const u = new URL(url); if (!['www.doubao.com', 'www.dola.com'].includes(u.hostname)) throw new Error('会话网址必须属于豆包或 Dola'); conversationId = u.pathname.split('/').filter(Boolean).at(-1); if (conversationId === 'chat') conversationId = null; } await action('task.confirm', { id: t.id, resolution: 'accepted', remote: { conversationId } }); }
      if (type === 'notSubmitted') { if (!confirm('确认平台没有接受此任务？队列将允许重新准备，请先核对平台记录。')) return; await action('task.confirm', { id: t.id, resolution: 'not_submitted' }); }
      if (type === 'attach') { const observed = state.observations.filter(o => o.accountId === t.accountId); const vid = prompt(`输入视频 ID。当前账号已捕获：\n${observed.slice(-6).map(o => o.vid).join('\n') || '暂无，请打开生成结果页面'}`); if (!vid) return; await action('task.attach', { id: t.id, vid: vid.trim() }); }
      if (type === 'download') await action('task.retryDownload', { id: t.id });
      if (type === 'clean' || type === 'watermarked') await action('task.verify', { id: t.id, clean: type === 'clean' });
      if (type === 'reveal') await action('file.reveal', { assetId: t.outputAssetId });
      if (type === 'cancel') await action('task.cancel', { id: t.id });
      await refresh(); renderTasks();
    } finally { el.disabled = false; }
  });
}
function renderSettings() {
  const config = { mcpServers: { canvas_studio: { command: 'node', args: [system.mcp], env: { STUDIO_DATA: system.directory } } } };
  $('#settings-view').innerHTML = `<div class="page-heading"><div><div class="page-kicker">LOCAL CONNECTION</div><h1>连接与数据</h1><p>画布与 Agent 共用同一个项目、账号池和持久任务队列。</p></div></div><div class="settings-panel"><h3>MCP · Agent 接入</h3><p>先启动桌面工作台，再通过下面的配置连接。工具包含项目、素材、账号用量、任务提交、状态查询、下载和抽帧。</p><pre>${esc(JSON.stringify(config, null, 2))}</pre><p>桌面版与浏览器预览使用独立数据。预览不连接真实平台。</p></div><div class="settings-panel"><h3>本地数据</h3><pre>${esc(system.directory)}</pre><p>素材、任务、输出视频与独立账号会话均保存在本机。迁移时先退出程序，再备份整个数据目录；新电脑可能需要重新登录。</p></div><div class="settings-panel"><h3>最近活动</h3>${state.events.slice(-12).reverse().map(e => `<div class="event-row"><time>${new Date(e.time).toLocaleTimeString()}</time><span>${esc(e.message)}</span></div>`).join('') || '<p>暂无活动。</p>'}</div>`;
}
const originalRenderSettings = renderSettings;
renderSettings = function(){originalRenderSettings();const run=state.settings.validationRun;const used=platform=>state.attempts.filter(a=>a.validationRunId===run?.id&&a.platform===platform&&['accepted','reserved','uncertain'].includes(a.phase)).length;$('#settings-view').insertAdjacentHTML('afterbegin','<div class="settings-panel"><h3>本轮5秒流程验证</h3><p>每个平台最多两次，未知提交也占次数；验证模式禁止15秒。'+(run?'豆包 '+used('doubao')+'/2 · Dola '+used('dola')+'/2':'尚未开始')+'</p><button id="validation-toggle" class="button">'+(run?.active?'结束验证模式':'开始本轮验证')+'</button></div>');$('#validation-toggle').onclick=safe(async()=>{await action('validation.run',{operation:run?.active?'stop':'start'});await refresh();renderSettings();});};
window.addEventListener('keydown', e => { if (e.key === 'Escape') { linking = null; renderCanvas(); } });
window.addEventListener('beforeunload', e => { if (dirty || savePromise) { e.preventDefault(); e.returnValue = ''; } });
(async () => { system = await (await fetch('/api/system')).json(); await refresh(); renderCanvas(); renderInspector(); setInterval(() => refresh().catch(() => { $('#connection').textContent = '本地连接已断开'; }), 2500); })().catch(e => toast('启动失败：' + e.message));

let exportClips=[];
function renderExportClips(){ $('#export-clips').innerHTML=exportClips.map((c,i)=>'<div class="export-clip"><label><input type="checkbox" data-export-check="'+i+'" '+(c.checked?'checked':'')+'>'+esc(c.name)+'</label><button type="button" data-export-up="'+i+'" aria-label="上移 '+esc(c.name)+'">↑</button><button type="button" data-export-down="'+i+'" aria-label="下移 '+esc(c.name)+'">↓</button></div>').join('');for(const el of document.querySelectorAll('[data-export-check]'))el.onchange=()=>{exportClips[el.dataset.exportCheck].checked=el.checked;};for(const direction of ['up','down'])for(const el of document.querySelectorAll('[data-export-'+direction+']'))el.onclick=()=>{const i=Number(el.dataset[direction==='up'?'exportUp':'exportDown']),j=i+(direction==='up'?-1:1);if(j>=0&&j<exportClips.length){[exportClips[i],exportClips[j]]=[exportClips[j],exportClips[i]];renderExportClips();}};}
$('#export-project').onclick=safe(async()=>{await flushSave();exportClips=project.nodes.filter(n=>n.type==='video'&&n.assetId&&!n.exportId).map(n=>({assetId:n.assetId,name:n.name,checked:true}));if(exportClips.length<2)throw Error('请先准备至少两段视频');renderExportClips();$('#export-error').textContent='';$('#export-dialog').showModal();});
$('#close-export').onclick=()=>$('#export-dialog').close();
$('#export-form').onsubmit=async e=>{e.preventDefault();const button=$('#export-submit');button.disabled=true;$('#export-error').textContent='正在拼接并保存…';try{const target=Number($('#export-duration').value);const result=await action('video.merge',{projectId:project.id,assetIds:exportClips.filter(c=>c.checked).map(c=>c.assetId),...(target?{targetDuration:target}:{}),idempotencyKey:uuid()});$('#export-dialog').close();await refresh();selected=result.nodeId;renderCanvas();renderInspector();$('#fit-canvas').click();toast('成片已保存，原视频完整保留');}catch(err){$('#export-error').textContent=err.message;}finally{button.disabled=false;}};
