const fs = require('node:fs');

async function resumePlatformFile(session, url, partial, output, { timeoutMs = 120000 } = {}) {
  if (fs.existsSync(output)) throw new Error('续传目标已存在，保留已有文件');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const temporary = `${output}.part`; let handle, jobs = [];
  try {
    const head = await session.fetch(url, { method: 'HEAD', signal: controller.signal });
    const total = Number(head.headers.get('content-length'));
    if (!head.ok || !/bytes/i.test(head.headers.get('accept-ranges') || '') || !Number.isSafeInteger(total) || total < 1000 || total > 2 * 1024 ** 3) throw new Error('视频源不支持可核验续传，保留原下载');
    fs.copyFileSync(partial, temporary);
    const prefix = fs.statSync(temporary).size;
    if (prefix <= 0 || prefix >= total) throw new Error('原下载前缀不适合续传，保留原下载');
    handle = fs.openSync(temporary, 'r+');
    const middle = prefix + Math.ceil((total - prefix) / 2), etag = head.headers.get('etag');
    jobs = [[prefix, middle - 1], [middle, total - 1]].filter(([start, end]) => start <= end).map(async ([start, end]) => {
      const response = await session.fetch(url, { headers: { Range: `bytes=${start}-${end}`, ...(etag && !etag.startsWith('W/') ? { 'If-Range': etag } : {}) }, signal: controller.signal });
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${total}`) { await response.body?.cancel(); throw new Error('视频源未返回所请求的字节区间，保留原下载'); }
      let position = start;
      for await (const chunk of response.body) {
        if (position + chunk.length > end + 1) throw new Error('续传数据超出已核验区间');
        fs.writeSync(handle, chunk, 0, chunk.length, position); position += chunk.length;
      }
      if (position !== end + 1) throw new Error('续传数据不完整，保留原下载');
    });
    await Promise.all(jobs);
    fs.closeSync(handle); handle = null;
    if (fs.statSync(temporary).size !== total) throw new Error('续传文件大小不一致');
    fs.renameSync(temporary, output);
    return { file: output, bytesTotal: total, bytesReused: prefix, bytesFetched: total - prefix };
  } catch (error) {
    controller.abort(); await Promise.allSettled(jobs); throw error;
  } finally {
    clearTimeout(timer); if (handle !== undefined && handle !== null) fs.closeSync(handle);
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}
module.exports = { resumePlatformFile };
