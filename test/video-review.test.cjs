const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Studio } = require('../src/core.cjs');
const { execute } = require('../src/media.cjs');
const { describeVideo } = require('../ui/video-evidence.js');
const { VideoReview } = require('../src/video-review.cjs');

test('参考图成片和15秒拼接不能作为首尾帧效果证明；使用任务快照而非被编辑的画布', () => {
  const state = { assets: [{ id: 'five', kind: 'video' }, { id: 'fifteen', kind: 'video', source: 'concatenation', sourceSegments: ['five', 'five'] }], tasks: [{ id: 'task', outputAssetId: 'five', mode: 'references', refs: [{ role: 'reference', assetId: 'image' }] }], projects: [{ nodes: [{ type: 'generation', mode: 'first_last' }] }] };
  assert.equal(describeVideo(state, 'five').origin, 'references');
  assert.equal(describeVideo(state, 'five').nativeFirstLast, false);
  assert.equal(describeVideo(state, 'five').review.verdict, 'pending');
  assert.equal(describeVideo(state, 'fifteen').origin, 'concatenation');
  assert.equal(describeVideo(state, 'fifteen').nativeFirstLast, false);
  state.tasks[0].mode = 'first_last'; state.tasks[0].refs = [{ role: 'last', assetId: 'end' }, { role: 'first', assetId: 'start' }];
  assert.equal(describeVideo(state, 'five').nativeFirstLast, true);
  assert.equal(describeVideo(state, 'five').expectedFirstAssetId, 'start');
  assert.equal(describeVideo(state, 'five').expectedLastAssetId, 'end');
  assert.equal(describeVideo(state, 'five').review.verdict, 'pending');
  assert.equal(describeVideo(state, 'fifteen').nativeFirstLast, false);
});

test('实际视频对照提取真实首尾并复用；效果反馈跨重启保存且不改变生成、额度或水印结论', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-review-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(root).startsWith('studio-review-')); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'clip.mp4');
  await execute('ffmpeg', ['-v','error','-y','-f','lavfi','-i','testsrc=size=128x96:rate=10','-t','1','-pix_fmt','yuv420p',file]);
  const studio = new Studio(root), video = studio.registerAsset(file, { kind: 'video' }), reviews = new VideoReview(studio);
  const [a, b] = await Promise.all([reviews.comparison({assetId:video.id}), reviews.comparison({assetId:video.id})]);
  assert.equal(a.actualFirstAssetId,b.actualFirstAssetId); assert.equal(a.actualLastAssetId,b.actualLastAssetId);
  assert.equal(studio.state.assets.length,3);
  assert.equal(studio.find('assets',a.actualLastAssetId).sourceFrame.selection,'last_decodable');
  assert.notEqual(fs.readFileSync(studio.find('assets',a.actualFirstAssetId).file).toString('base64'),fs.readFileSync(studio.find('assets',a.actualLastAssetId).file).toString('base64'));
  reviews.record({assetId:video.id,verdict:'rejected',reason:'站立不动，没有发射动作'});
  const restored = new Studio(root), result = await new VideoReview(restored).comparison({assetId:video.id});
  assert.equal(restored.state.assets.length,3); assert.equal(result.review.verdict,'rejected'); assert.equal(result.review.reason,'站立不动，没有发射动作');
  assert.equal(restored.state.tasks.length,0); assert.equal(restored.state.attempts.length,0);
  assert.throws(()=>reviews.record({assetId:video.id,verdict:'rejected',reason:''}),/反馈原因/);
});
