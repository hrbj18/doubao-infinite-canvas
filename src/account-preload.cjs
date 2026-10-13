const { ipcRenderer, webFrame } = require('electron');
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== window.location.origin || !/^(www\.)?(doubao|dola)\.com$/.test(window.location.hostname)) return;
  if (event.data?.source !== 'canvas-studio-observer') return;
  const v = event.data.value;
  if (v?.type === 'duration_adjusted' && typeof v.taskId === 'string' && [15,30].includes(v.duration)) ipcRenderer.send('platform-observation',{type:v.type,taskId:v.taskId.slice(0,160),duration:v.duration});
  if (['video','request','accepted'].includes(v?.type)) ipcRenderer.send('platform-observation', { type: v.type, requestId: v.requestId, prompts: Array.isArray(v.prompts) ? v.prompts.filter(x => typeof x === 'string' && x.length <= 12000).slice(0, 10) : [], vid: v.vid?.slice(0, 160), messageId: v.messageId, conversationId: v.conversationId, prompt: v.prompt?.slice(0, 12000), page: v.page, cover: v.cover, ready: v.ready === true, platformCompletedAt: Number.isFinite(v.platformCompletedAt) ? v.platformCompletedAt : undefined });
});
// 沙盒 preload 不能 require 本地文件，由主进程通过 IPC 返回固定的观察脚本。
window.addEventListener('DOMContentLoaded', async () => {
  const script = await ipcRenderer.invoke('platform-observer-script');
  await webFrame.executeJavaScript(script).catch(() => {});
});
