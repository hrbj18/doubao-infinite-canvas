import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const directory = process.env.STUDIO_DATA || (process.env.APPDATA ? path.join(process.env.APPDATA, 'CanvasStudio') : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data'));
async function request(route, body) {
  let runtime;
  try { runtime = JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8')); }
  catch { throw new Error('请先启动 Canvas Studio 桌面工作台，并确认 STUDIO_DATA 指向它的数据目录。'); }
  const url = new URL(runtime.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('运行地址必须是本机 127.0.0.1');
  let response;
  try { response = await fetch(runtime.url + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${runtime.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) }); }
  catch { throw new Error('本地工作台未连接，请启动桌面版。任务数据不会在 MCP 进程中另建副本。'); }
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '工作台请求失败'); return result;
}
const action = async (name, input) => (await request('/api/action', { action: name, input })).result;
const snapshot = () => request('/api/state');
// 凭据由工作台直接读取本机文件，避免把 Cookie 原文放进 Agent 调用参数与返回结果。
const importCookies = x => action('account.importCookies', x);
const server = new McpServer({ name: 'canvas-studio', version: JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version });
function tool(name, description, inputSchema, handler, readOnly = false) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: !readOnly } }, async input => {
    try { const result = await handler(input); return { content: [{ type: 'text', text: JSON.stringify(result) }] }; }
    catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
  });
}
tool('studio_status', '查询工作台、平台、项目和任务汇总。首先确认工作台在线；不读取登录凭据。', {}, async () => {
  const s = await snapshot(); return { platforms: s.platforms, accounts: s.accounts, projects: s.projects.map(p => ({ id: p.id, name: p.name, revision: p.revision, nodes: p.nodes.length })), tasks: s.tasks.map(t => ({ id: t.id, platform: t.platform, status: t.status, reason: t.reason, localFile: t.localFile })) };
}, true);

tool('studio_cookie_login', '从用户授权的本机 .txt/.json 文件导入 Cookie，新建账号或更新现有账号独立会话，并在隐藏窗口检测登录。不提交视频、不消耗生成额度。只传文件绝对路径，禁止把 Cookie 原文放进提示词；返回不包含凭据。会话到期取决于平台。导入返回 checking 时可用 studio_accounts probe/list 查询；同一幂等键重试不重复建账号。', { file: z.string(), platform: z.enum(['doubao', 'dola']).optional(), accountId: z.string().optional(), name: z.string().max(80).optional(), dailyLimit: z.number().int().min(0).max(10000).optional(), idempotencyKey: z.string().min(1).max(200) }, importCookies);
tool('studio_accounts', '查询账号用量与调度模式；国内auto按平台反馈，余额未知不伪造可生成条数。quota只读同步国内官方套餐百分比，不提交视频；open才显示平台窗口。update可切换quotaMode。', { operation: z.enum(['list', 'update', 'open', 'probe', 'inspect', 'capabilities','quota']), accountId: z.string().optional(), taskId: z.string().optional(), dailyLimit: z.number().int().min(0).max(10000).optional(), todayUsed: z.number().int().min(0).max(10000).optional(), quotaMode:z.enum(['auto','manual']).optional(), quotaRelation: z.enum(['unknown','shared','independent']).optional(), quotaEvidence: z.string().optional(), quotaBucket: z.enum(['standard','15s']).optional(), bucketLimit: z.number().int().min(0).max(10000).optional(), bucketUsed: z.number().int().min(0).max(10000).optional(), clearBlock: z.boolean().optional() }, async x => {
  if (x.operation === 'list') return (await snapshot()).accounts;
  if (!x.accountId) throw new Error('请提供 accountId');
  if (x.operation === 'update') { const {operation,accountId,taskId,...patch}=x; return action('account.update', { id: x.accountId, patch }); }
  return action(`account.${x.operation}`, { id: x.accountId, taskId: x.taskId });
});
tool('studio_projects', '列出/读取/创建/保存画布项目。保存完整节点和连线时传 expectedRevision，避免覆盖其他调用的新修改。节点支持 image、generation、video；图片以 assetId 引用。', { operation: z.enum(['list', 'get', 'create', 'save']), projectId: z.string().optional(), name: z.string().max(100).optional(), expectedRevision: z.number().int().optional(), nodes: z.array(z.record(z.string(), z.unknown())).optional(), edges: z.array(z.record(z.string(), z.unknown())).optional(), viewport: z.object({ x: z.number(), y: z.number(), scale: z.number() }).optional() }, async x => {
  const s = await snapshot(); if (x.operation === 'list') return s.projects;
  if (x.operation === 'create') return action('project.create', { name: x.name });
  const p = s.projects.find(p => p.id === x.projectId); if (!p) throw new Error('项目不存在'); if (x.operation === 'get') return p;
  if (x.expectedRevision === undefined) throw new Error('保存项目必须提供读取到的 expectedRevision');
  return action('project.save', { id: x.projectId, patch: { name: x.name, nodes: x.nodes, edges: x.edges, viewport: x.viewport, expectedRevision: x.expectedRevision } });
});
tool('studio_import_asset', '把已授权的本地图片或视频复制到项目素材目录，返回 assetId。路径必须是绝对路径。', { file: z.string(), kind: z.enum(['image', 'video']), name: z.string().optional() }, x => action('asset.import', x));
tool('studio_generate', '提交真实平台视频生成任务。必须指定平台、输入角色、完整提示词和幂等键。同一幂等键重试不会重复生成。references全部reference；first恰好一张first；first_last恰好first和last各一张。accountPolicy默认preferred可切换同平台账号；required固定指定账号，不可用时等待。原生首尾能力必须在页面核对，不明确则等待，不降级。验证时必须传studio_validation返回的validationRunId；排队不代表生成成功。', {
  projectId: z.string(), nodeId: z.string().optional(), platform: z.enum(['doubao', 'dola']), accountId: z.string().optional(), accountPolicy:z.enum(['preferred','required']).optional(), prompt: z.string().min(1).max(12000), mode: z.enum(['references', 'first', 'first_last']),
  refs: z.array(z.object({ assetId: z.string(), role: z.enum(['reference', 'first', 'last']) })).min(1).max(9), duration: z.number().min(1).max(120).optional(), ratio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9', '21:9']).optional(), model: z.string().max(100).optional(), validationRunId: z.string().optional(), idempotencyKey: z.string().min(1).max(200)
}, x => action('task.submit', x));
tool('studio_tasks', '查询任务状态、失败原因、本地视频路径和捕获的作品。done 只代表视频已保存并确认无可见水印，不代表动作或首尾帧效果验收；download_pending 不等于成功。', { taskId: z.string().optional() }, async x => { const s = await snapshot(); if (!x.taskId) return s.tasks; const task = s.tasks.find(t => t.id === x.taskId); if (!task) throw new Error('任务不存在'); return { ...task, observations: s.observations.filter(o => o.accountId === task.accountId) }; }, true);
tool('studio_continue_preparation', '平台页面已切换到正确生成模式后，继续准备素材。不会把首尾帧降级成普通参考图。', { taskId: z.string() }, x => action('task.continue', { id: x.taskId }));
tool('studio_advance_task', '在后台继续已准备的任务或处理平台的参数确认。确认参数只适用于当前任务的明确确认提示，发送意图先保存，不能重复提交。通常工作台自动推进；平台变化时供 Agent 使用。', { taskId: z.string(), operation: z.enum(['submit_prepared','confirm_parameters']) }, x => action(x.operation === 'submit_prepared' ? 'task.sendPrepared' : 'task.confirmParameters', { id: x.taskId }));
tool('studio_confirm_submission', '仅在查看平台记录并取得明确证据后，确认任务已接受或尚未提交。无法确定时保留 reconciling，禁止猜测 not_submitted 以重复消耗预算。conversationId/messageId 用于准确关联视频。', { taskId: z.string(), resolution: z.enum(['accepted', 'not_submitted']), conversationId: z.string().optional(), messageId: z.string().optional() }, x => action('task.confirm', { id: x.taskId, resolution: x.resolution, remote: { conversationId: x.conversationId, messageId: x.messageId } }));
tool('studio_attach_video', '把已经核实属于此任务、此账号的视频 ID 关联到任务并下载平台源。不要把历史作品误关联到新任务。', { taskId: z.string(), vid: z.string() }, x => action('task.attach', { id: x.taskId, vid: x.vid }));
tool('studio_download', '单独重试下载或报告可见水印验证结果。verify 必须实际查看视频后执行，平台源地址本身不能证明无水印；保留平台元数据。', { taskId: z.string(), operation: z.enum(['retry', 'verify']), clean: z.boolean().optional() }, x => { if (x.operation === 'verify' && x.clean === undefined) throw new Error('必须提供实际验证后的 clean'); return action(x.operation === 'retry' ? 'task.retryDownload' : 'task.verify', { id: x.taskId, clean: x.clean }); });
tool('studio_extract_frame', '从本地视频提取指定秒数/首帧/尾帧，返回新的图片 assetId。用于后续参考图或首尾帧任务。', { assetId: z.string(), time: z.number().min(0).optional(), position: z.enum(['first', 'last']).optional() }, x => action('video.frame', x));
tool('studio_video_review', '对照真实视频首尾画面与提交时指定的首尾图；comparison提取并复用真实首尾帧，返回生成来源与验收状态。record仅在实际查看视频或收到用户反馈后记录动作效果，禁止以下载成功或时长正确冒充效果验收。此工具不提交生成、不消耗账号额度。', {assetId:z.string(),operation:z.enum(['comparison','record']),verdict:z.enum(['pending','passed','rejected']).optional(),reason:z.string().max(1000).optional()}, x=>{if(x.operation==='record'&&!x.verdict)throw new Error('请指定效果反馈 verdict');return action(x.operation==='comparison'?'video.comparison':'video.review',x);});
tool('studio_shot', '一次调用准备同镜头续接或新分镜，不自动提交。continue从sourceVideoAssetId提取真实最后一帧并连到下一段原生首帧；new使用Agent已生成的imageFile或imageAssetId，可暂空等待素材。可选lastAssetId启用首尾控制，继承平台/比例/时长和人物提示词，返回新生成节点ID。', { projectId:z.string(), kind:z.enum(['continue','new']), sourceVideoAssetId:z.string().optional(), imageAssetId:z.string().optional(), imageFile:z.string().optional(), lastAssetId:z.string().optional(), name:z.string().max(100).optional(), platform:z.enum(['doubao','dola']).optional(), prompt:z.string().max(12000).optional(), duration:z.number().min(1).max(120).optional(), ratio:z.enum(['1:1','3:4','4:3','9:16','16:9','21:9']).optional(), model:z.string().max(100).optional(), idempotencyKey:z.string().min(1).max(200) }, x=>action('shot.create',x));
tool('studio_merge', '按assetIds指定顺序直接拼接视频并保留原声。targetDuration指定目标秒数：只裁成片末尾，误差最多一帧；不足则提示，不拉长、不自动重生成。保留原片、回填成片节点；幂等键防止重复导出。', { projectId:z.string(), assetIds:z.array(z.string()).min(2).max(32), targetDuration:z.number().positive().max(3600).optional(), name:z.string().max(100).optional(), idempotencyKey:z.string().min(1).max(200) }, x=>action('video.merge',x));
tool('studio_validation', '管理本轮真实测试预算：每平台最多2次5秒，禁止15秒。start幂等返回当前验证；提交时传validationRunId；接受和未知提交均占预算，额度拒绝才释放。stop只停止后续分配，不释放未知提交。', {operation:z.enum(['start','status','stop'])},x=>action('validation.run',x));
tool('studio_cancel_task', '取消排队任务或明确尚未提交的准备等待任务，释放其预留。已经提交或结果未知的任务必须先核实，不能释放预算。', { taskId: z.string() }, x => action('task.cancel', { id: x.taskId }));
tool('studio_defer_submission', '将提交超过120分钟且没有作品的任务移入超时待核实，停止轮询与账号占用，保留原会话和已用/未知预算；不得把它当成未提交或重新发送。', {taskId:z.string()},x=>action('task.deferSubmission',{id:x.taskId}));
await server.connect(new StdioServerTransport());
