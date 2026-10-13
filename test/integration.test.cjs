const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Studio } = require('../src/core.cjs');
const { startServer, extractFrame, execute } = require('../src/server.cjs');
test('真实 MCP 握手及工具调用共享同一工作台，HTTP 拒绝未授权和跨站请求', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-integration-')); const studio = new Studio(root); studio.createProject('MCP测试');
  const { server, url } = await startServer(studio, { port: 0 }); const runtime = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json')));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); assert.ok(root.startsWith(path.join(os.tmpdir(), 'canvas-integration-'))); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal((await fetch(url + '/api/state')).status, 401);
  assert.equal((await fetch(url + '/api/state', { headers: { Authorization: `Bearer ${runtime.token}`, Origin: 'https://example.com' } })).status, 403);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js'); const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../src/mcp.mjs')], env: { ...process.env, STUDIO_DATA: root }, stderr: 'pipe' });
  const client = new Client({ name: 'integration-test', version: '1.0.0' }); t.after(() => client.close()); await client.connect(transport);
  const tools = await client.listTools(); assert.ok(tools.tools.some(x => x.name === 'studio_generate'));
  assert.ok(tools.tools.some(x => x.name === 'studio_video_review'));
  const wrongReview = await client.callTool({name:'studio_video_review',arguments:{assetId:'missing',operation:'record',verdict:'rejected',reason:'静止'}}); assert.equal(wrongReview.isError,true);
  const result = await client.callTool({ name: 'studio_projects', arguments: { operation: 'create', name: '通过MCP创建' } }); assert.ok(!result.isError); assert.equal(studio.state.projects.length, 2);
  const status = await client.callTool({ name: 'studio_status', arguments: {} }); assert.equal(JSON.parse(status.content[0].text).projects.length, 2);
  const invalid = await client.callTool({ name: 'studio_projects', arguments: { operation: 'save', projectId: studio.state.projects[0].id, name: '覆盖' } }); assert.equal(invalid.isError, true);
});
test('FFmpeg 实际抽帧：首帧、尾帧、指定时间返回可用 PNG，越界被拒绝', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-frame-')); t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'canvas-frame-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'clip.mp4'); await execute('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', file]);
  const studio = new Studio(root); const video = studio.registerAsset(file, { kind: 'video' });
  for (const input of [{ position: 'first' }, { position: 'last' }, { time: .8 }]) { const image = await extractFrame(studio, { assetId: video.id, ...input }); assert.equal(fs.readFileSync(image.file).subarray(1, 4).toString(), 'PNG'); }
  await assert.rejects(() => extractFrame(studio, { assetId: video.id, time: 4 }), /小于视频时长/);
});
