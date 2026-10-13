const COMPLETION_POLL_MS = 20000;
const millis = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n < 1e12 ? n * 1000 : n : null;
};

// Only expose identifiers and timing. Cookies, message text and signed URLs never leave this reader.
function dolaCompletionMetadata(root, task, { expectedVid } = {}) {
  const conversations = root?.downlink_body?.batch_get_conv_info_downlink_body?.conversation_info_list;
  if (!Array.isArray(conversations)) return null;
  const conversation = conversations.find(c => String(c.conversation_id) === task.remote?.conversationId);
  if (!conversation) return null;
  const candidates = new Map(), baseline = new Set(task.observationBaseline || []);
  for (const message of conversation.messages || []) {
    if (String(message.conversation_id) !== task.remote.conversationId) continue;
    const createdAt = millis(message.create_time);
    if (!createdAt || !task.submitIntentAt || createdAt < task.submitIntentAt - 3000) continue;
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const video = value.video;
      if (video && /^[\w-]{5,160}$/.test(video.vid || '') && !baseline.has(video.vid)
          && (!expectedVid || video.vid === expectedVid) && Number(video.duration) > 0
          && Number(video.width) > 0 && Number(video.height) > 0 && video.download_url) {
        candidates.set(video.vid, { vid: video.vid, messageId: String(message.message_id), conversationId: task.remote.conversationId,
          platformCompletedAt: createdAt, duration: Number(video.duration), width: Number(video.width), height: Number(video.height) });
      }
      for (const [key, item] of Object.entries(value)) {
        if (item && typeof item === 'object') visit(item);
        else if (['content', 'text'].includes(key) && typeof item === 'string' && /^[\[{]/.test(item)) {
          try { visit(JSON.parse(item)); } catch {}
        }
      }
    };
    visit(message);
  }
  if (candidates.size !== 1) return { matched: false, reason: candidates.size ? '原会话出现多个新作品，需要核对关联' : '原会话尚未返回完整视频作品' };
  return { matched: true, ...candidates.values().next().value };
}

async function inspectDolaCompletion(win, task, reload, { timeoutMs = 18000, expectedVid } = {}) {
  const debug = win.webContents.debugger;
  const command = async (name, params, limit = 5000) => {
    let deadline;
    try { return await Promise.race([debug.sendCommand(name, params), new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('后台网络核对超时')), limit); })]); }
    finally { clearTimeout(deadline); }
  };
  if (debug.isAttached()) throw new Error('后台作品核对正在使用中');
  debug.attach('1.3');
  const targets = new Set(); let handler, timer;
  try {
    await command('Network.enable');
    const result = new Promise(resolve => {
      timer = setTimeout(() => resolve({ matched: false, reason: '原会话状态读取超时，下次自动重试' }), timeoutMs);
      handler = async (_event, method, params) => {
        if (method === 'Network.responseReceived') {
          try { const url = new URL(params.response.url); if (url.hostname === 'www.dola.com' && url.pathname === '/im/conversation/batch_get') targets.add(params.requestId); } catch {}
        }
        if (method !== 'Network.loadingFinished' || !targets.delete(params.requestId)) return;
        try {
          const body = await command('Network.getResponseBody', { requestId: params.requestId });
          const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
          if (text.length > 4 * 1024 ** 2) return;
          const metadata = dolaCompletionMetadata(JSON.parse(text), task, { expectedVid });
          if (metadata) { clearTimeout(timer); resolve(metadata); }
        } catch {}
      };
      debug.on('message', handler);
    });
    await reload();
    return await result;
  } finally {
    clearTimeout(timer);
    if (handler) debug.removeListener('message', handler);
    await command('Network.disable', undefined, 1000).catch(() => {});
    if (debug.isAttached()) debug.detach();
  }
}

module.exports = { COMPLETION_POLL_MS, dolaCompletionMetadata, inspectDolaCompletion };
