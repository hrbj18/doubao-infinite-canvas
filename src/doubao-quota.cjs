const FAST_MODEL = 'Seedance 2.0 Fast';
const STALE_MS = 5 * 60000;
const modelKey = model => String(model || FAST_MODEL).replace(/\s+/g, '').toLowerCase();
const variantKey = task => `${modelKey(task.model || task.selectedModel)}:${task.duration || 'default'}:${task.resolution || 'default'}:${task.mode || 'references'}`;

function normalizeSummary(json, observedAt = Date.now()) {
  if (json?.code !== 0 || !json.data?.member_info || !json.data.window_limit_section) throw new Error('官方额度响应未通过结构校验');
  const data=json.data, section=data.window_limit_section;
  return { source:'doubao_subscription_api', observedAt, activeSubscription:data.member_info.hasActiveSubscription===true,
    plan: String(data.current_subscription?.display?.short_name || '普通账号').slice(0,40), exhausted:section.usage_exhausted===true,
    windows:(section.window_limit_groups || []).flatMap(g=>(g.window_limits || []).map(w=>({group:String(g.feature_group || '').slice(0,40),usedPercent:typeof w.used_percent==='number'&&w.used_percent>=0&&w.used_percent<=100?w.used_percent:null,
      startAt:w.start_time>0?w.start_time*1000:null,resetAt:w.end_time>0?w.end_time*1000:null,type:w.window_type}))).slice(0,12),
    balance:null, note:'接口只报告套餐用量，未提供免费Fast按时长的剩余额度，不能换算为视频条数' };
}

function parseFeedback(text) {
  const costs=[...String(text || '').matchAll(/(?:本次(?:生成)?(?:将)?|需要)\s*消耗\s*(\d+(?:\.\d+)?)\s*(?:个)?(?:视频生成)?额度/g)].map(m=>Number(m[1]));
  const balances=[...String(text || '').matchAll(/(?:今日|当前|目前)(?:还)?剩余\s*(\d+(?:\.\d+)?)\s*(?:个)?(?:视频生成)?额度/g)].map(m=>Number(m[1]));
  if(new Set(costs).size!==1 || !costs[0] || costs[0]>10000 || new Set(balances).size!==1 || balances[0]>10000)return null;
  return { cost:costs[0],remaining:balances[0] };
}

function recordFeedback(account, task, attempt, text, now) {
  const value=parseFeedback(text);if(!value)return false;
  const costs=account.videoQuota?.costs || {};
  costs[variantKey(task)]={cost:value.cost,observedAt:now,source:'platform_task_feedback'};
  account.videoQuota={source:'platform_task_feedback',observedAt:now,model:modelKey(task.model || task.selectedModel),remaining:value.remaining,costs,attemptId:attempt?.id};
  task.quotaFeedback={...value,observedAt:now};
  return true;
}

function decision(account, attempts, task, now) {
  const holds=attempts.filter(a=>a.accountId===account.id&&['reserved','uncertain'].includes(a.phase));
  const official=account.platformQuota, freshOfficial=official && now-official.observedAt<STALE_MS;
  if(freshOfficial && official.exhausted)return {canPrepare:false,reason:'平台当前时段额度已耗尽',balanceKnown:false};
  if(holds.some(a=>a.phase==='uncertain'))return {canPrepare:false,reason:'此账号仍有未知提交，先核实原任务',balanceKnown:false};
  const key=variantKey(task),block=account.autoQuotaBlocks?.[key];
  if(block && now<block.retryAt)return {canPrepare:false,reason:'此模型与时长已被平台拒绝，等待重新核对',balanceKnown:false};
  const q=account.videoQuota;
  const fresh=q && now-q.observedAt<STALE_MS && q.model===modelKey(task.model);
  const subsequent=attempts.filter(a=>a.accountId===account.id && a.phase==='accepted' && a.id!==q?.attemptId && (a.acceptedAt || a.time)>=q?.observedAt);
  const cost=fresh?q.costs?.[key]?.cost:null;
  if(!fresh || subsequent.length || !cost)return {canPrepare:holds.length===0,balanceKnown:false,remaining:null,cost:null,reason:'免费余额或此时长消耗未知，逐任务核对，不按本地次数停用账号'};
  const held=holds.reduce((sum,a)=>sum+(q.costs?.[variantKey(a)]?.cost ?? q.remaining),0),remaining=Math.max(0,q.remaining-held);
  return {canPrepare:remaining>=cost,balanceKnown:true,remaining,cost,capacity:Math.floor(remaining/cost),reason:remaining>=cost?'平台反馈额度足够':'此时长所需额度超过当前剩余'};
}
module.exports={FAST_MODEL,STALE_MS,modelKey,variantKey,normalizeSummary,parseFeedback,recordFeedback,decision};
