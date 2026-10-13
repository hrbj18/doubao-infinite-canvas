// 仅当前任务启用国内15秒或Dola Seedance 2.5的15/30秒兼容请求。
function installDurationPolicy(intent) {
  window.__canvasStudioDurationIntent = intent;
  if (window.__canvasStudioDurationInstalled) return;
  window.__canvasStudioDurationInstalled = true;
  const stringify = JSON.stringify, parse = JSON.parse;
  JSON.stringify = function (value, ...rest) {
    const current = window.__canvasStudioDurationIntent;
    const allowed = current?.duration === 15 && current.platform === 'doubao' || [15,30].includes(current?.duration) && current.platform === 'dola' && /^(?:Dreamina\s*)?Seedance\s*2\.5$/i.test(current.model || '');
    if (allowed && current.expiresAt > Date.now() && value?.chat_ability?.ability_type === 17) {
      try {
        // 限定当前提示词/参数确认，避免全局挂钩修改别的对话。
        const prompts=(current.prompts||[]).filter(Boolean).map(p=>p.replace(/\s+/g,''));
        const queue=[value],seen=new Set();let matched=false,steps=0;
        while(queue.length && steps++<3000 && !matched) {
          const item=queue.shift();
          if(typeof item==='string') {matched=prompts.some(p=>item.replace(/\s+/g,'').includes(p));if(!matched && /^[\[{]/.test(item)){try{queue.push(parse(item));}catch{}}}
          else if(item && typeof item==='object' && !seen.has(item)){seen.add(item);queue.push(...Object.values(item));}
        }
        if (matched) {
          const param = parse(value.chat_ability.ability_param || '{}');
          // 若请求显式指定其他模型，拒绝把它变成30秒请求。
          if (current.platform === 'dola' && param.model && !/2[._]5(?:$|[-_])/i.test(String(param.model))) return Reflect.apply(stringify, this, [value, ...rest]);
          const adjusted = { ...value, chat_ability: { ...value.chat_ability, ability_param: stringify({ ...param, duration: current.duration }) } };
          window.postMessage({ source: 'canvas-studio-observer', value: { type: 'duration_adjusted', taskId: current.taskId, duration: current.duration } }, location.origin);
          return Reflect.apply(stringify, this, [adjusted, ...rest]);
        }
      } catch {}
    }
    return Reflect.apply(stringify, this, [value, ...rest]);
  };
}
const script = intent => `(${installDurationPolicy.toString()})(${JSON.stringify(intent)});`;
script.intentFor = (task, prompts = [task.prompt]) => {
  const allowed = task.platform === 'doubao' && task.duration === 15 || task.platform === 'dola' && [15,30].includes(task.duration) && /^(?:Dreamina\s*)?Seedance\s*2\.5$/i.test(task.model || '');
  return allowed ? {taskId:task.id,platform:task.platform,duration:task.duration,model:task.model,prompts,expiresAt:Date.now()+15*60000} : null;
};
module.exports = script;
