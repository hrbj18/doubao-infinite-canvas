// 只观察当前账号页面的作品元数据，不修改请求参数，不传递 Cookie。
function installObserver() {
  if (window.__canvasStudioObserver) return;
  window.__canvasStudioObserver = true;
  const seen = new Map();
  const originalParse = JSON.parse;
  const emit = value => window.postMessage({ source: 'canvas-studio-observer', value }, location.origin);
  const textOf = m => typeof m.content === 'string' ? m.content : (m.content?.text || m.text || '');
  function visit(root, sourceContext = {}) {
    const queue = [{ value: root, context: sourceContext }]; let inspected = 0;
    while (queue.length && inspected++ < 3000) {
      const { value: v, context } = queue.shift();
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { for (const x of v.slice(0, 150)) queue.push({ value: x, context }); continue; }
      const ctx = { ...context };
      if (v.message_id || v.messageId) ctx.messageId = String(v.message_id || v.messageId);
      if (v.conversation_id || v.conversationId) ctx.conversationId = String(v.conversation_id || v.conversationId);
      if (v.message_id && Number(v.create_time) > 0) ctx.platformCompletedAt = Number(v.create_time) < 1e12 ? Number(v.create_time) * 1000 : Number(v.create_time);
      if (v.prompt) ctx.prompt = String(v.prompt).slice(0, 12000);
      if (v.role === 'user' || v.role === 1) ctx.prompt = String(textOf(v)).slice(0, 12000);
      if (ctx.requestId && ctx.videoMode && ctx.conversationId && ctx.messageId && !v.code && !v.error_code) emit({ type: 'accepted', requestId: ctx.requestId, prompts: ctx.prompts, conversationId: ctx.conversationId, messageId: ctx.messageId });
      if (v.video?.vid) {
        const video = v.video;
        const item = { vid: String(video.vid), messageId: ctx.messageId, conversationId: ctx.conversationId, prompt: ctx.prompt, prompts: ctx.prompts, requestId: ctx.requestId, cover: typeof video.cover_url === 'string' ? video.cover_url : video.cover?.url, page: location.pathname,
          ready: !!(video.download_url && Number(video.duration) > 0 && Number(video.width) > 0 && Number(video.height) > 0), platformCompletedAt: ctx.platformCompletedAt };
        const signature = JSON.stringify(item);
        if (seen.get(item.vid) !== signature) { seen.set(item.vid, signature); emit({ type: 'video', ...item }); }
      }
      for (const [key, x] of Object.entries(v)) {
        if (x && typeof x === 'object') queue.push({ value: x, context: ctx });
        else if (['content', 'text'].includes(key) && typeof x === 'string' && /^[\[{]/.test(x)) { try { queue.push({ value: originalParse(x), context: ctx }); } catch {} }
      }
    }
  }
  JSON.parse = function (...args) { const v = Reflect.apply(originalParse, this, args); try { visit(v); } catch {} return v; };
  const nativeFetch = window.fetch;
  window.fetch = async function (...args) {
    let context = {};
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (/\/chat\/(completion|stream)/.test(url || '') && typeof args[1]?.body === 'string') {
        const prompts = new Set();
        const collect = value => {
          if (!value || typeof value !== 'object') return;
          for (const [key, item] of Object.entries(value)) {
            if (item && typeof item === 'object') collect(item);
            else if (['content', 'text', 'prompt'].includes(key) && typeof item === 'string') { if (/^[\[{]/.test(item)) { try { collect(originalParse(item)); } catch {} } else if (item.length <= 12000) prompts.add(item.trim()); }
          }
        };
        collect(originalParse(args[1].body));
        const videoMode = [...document.querySelectorAll('[data-testid=skill_input_exit_button],[data-testid=chat_input_action_mode]')].some(el => el.getClientRects().length && /^(视频生成|Video generation|Generate video|Create video)$/i.test((el.innerText || el.textContent || '').trim()));
        if (videoMode && prompts.size) { context = { requestId: crypto.randomUUID(), prompts: [...prompts], videoMode }; emit({ type: 'request', ...context }); }
      }
    } catch {}
    const response = await Reflect.apply(nativeFetch, this, args);
    try {
      const type = response.headers.get('content-type') || '';
      if (type.includes('json')) response.clone().json().then(value => visit(value, context)).catch(() => {});
      else if (type.includes('event-stream') && context.requestId) {
        void (async () => {
          const reader = response.clone().body.getReader(); const decoder = new TextDecoder(); let pending = '', bytes = 0;
          try { while (bytes < 8 * 1024 ** 2) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; pending += decoder.decode(item.value, { stream: true }); let end; while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1); if (line.startsWith('data:')) { try { visit(originalParse(line.slice(5).trim()), context); } catch {} } } } }
          finally { reader.releaseLock(); }
        })().catch(() => {});
      }
    } catch {}
    return response;
  };
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => { try { if (this.responseType === 'json') visit(this.response); else if (!this.responseType || this.responseType === 'text') visit(originalParse(this.responseText)); } catch {} });
    return Reflect.apply(nativeSend, this, args);
  };
}
module.exports = `(${installObserver.toString()})();`;
