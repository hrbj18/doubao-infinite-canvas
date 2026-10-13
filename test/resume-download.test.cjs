const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { resumePlatformFile } = require('../src/platform-resume-download.cjs');

for (const wrongRange of [false, true]) test(`续传${wrongRange ? '拒绝未确认的完整响应且保留原下载' : '只取缺失区间并逐字节复原文件'}`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-range-')), partial = path.join(directory, 'original.part'), output = path.join(directory, 'resumed.mp4');
  const expected = Buffer.from(Array.from({ length: 6000 }, (_, index) => index % 251)); fs.writeFileSync(partial, expected.subarray(0, 2345));
  let fetched = 0;
  const session = { fetch: async (_url, options) => {
    if (options.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(expected.length), 'accept-ranges': 'bytes', etag: '"same-file"' } });
    const [, start, end] = options.headers.Range.match(/bytes=(\d+)-(\d+)/).map(Number);
    assert.ok(start >= 2345); assert.equal(options.headers['If-Range'], '"same-file"'); fetched += end - start + 1;
    return new Response(expected.subarray(start, end + 1), { status: wrongRange ? 200 : 206, headers: { 'content-range': `bytes ${start}-${end}/${expected.length}` } });
  } };
  try {
    if (wrongRange) { await assert.rejects(() => resumePlatformFile(session, 'https://media.example/private', partial, output), /区间/); assert.equal(fs.existsSync(output), false); }
    else { const result = await resumePlatformFile(session, 'https://media.example/private', partial, output); assert.deepEqual(fs.readFileSync(output), expected); assert.equal(fetched, 3655); assert.equal(result.bytesReused, 2345); }
    assert.deepEqual(fs.readFileSync(partial), expected.subarray(0, 2345)); assert.equal(fs.existsSync(`${output}.part`), false);
  } finally { for (const name of fs.readdirSync(directory)) fs.rmSync(path.join(directory, name)); fs.rmdirSync(directory); }
});
