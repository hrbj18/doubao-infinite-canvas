const fs = require('node:fs');
const { assert } = require('./core.cjs');
const { extractFrame, videoInfo } = require('./media.cjs');
const { describeVideo } = require('../ui/video-evidence.js');

class VideoReview {
  constructor(studio) { this.studio = studio; this.pending = new Map(); }
  async comparison({ assetId }) {
    if (this.pending.has(assetId)) return this.pending.get(assetId);
    const promise = this.buildComparison(assetId).finally(() => this.pending.delete(assetId));
    this.pending.set(assetId, promise); return promise;
  }
  async buildComparison(assetId) {
    const studio = this.studio, video = studio.find('assets', assetId);
    assert(video.kind === 'video', '效果对照素材必须是视频');
    if (!video.mediaInfo) { video.mediaInfo = await videoInfo(video.file); studio.save(); }
    const frame = async position => {
      const existing = studio.state.assets.find(a => a.kind === 'image' && a.sourceFrame?.assetId === assetId && a.sourceFrame.position === position && fs.existsSync(a.file));
      return existing || await extractFrame(studio, { assetId, position });
    };
    const first = await frame('first'), last = await frame('last');
    return { ...describeVideo(studio.state, assetId), actualFirstAssetId: first.id, actualLastAssetId: last.id, mediaInfo: structuredClone(video.mediaInfo) };
  }
  record({ assetId, verdict, reason = '' }) {
    const asset = this.studio.find('assets', assetId);
    assert(asset.kind === 'video', '效果反馈素材必须是视频');
    assert(['pending', 'passed', 'rejected'].includes(verdict), '未知效果反馈');
    assert(typeof reason === 'string' && reason.length <= 1000, '反馈原因不能超过1000字');
    assert(verdict !== 'rejected' || reason.trim(), '请填写效果不符合的反馈原因');
    asset.videoReview = { verdict, reason: reason.trim(), reviewedAt: this.studio.clock() };
    (asset.reviewHistory ||= []).push(structuredClone(asset.videoReview));
    asset.reviewHistory = asset.reviewHistory.slice(-20);
    this.studio.event('review', `视频效果反馈：${verdict === 'rejected' ? '不符合预期' : verdict === 'passed' ? '已验收' : '待验收'}`, this.studio.state.tasks.find(t => t.outputAssetId === assetId)?.id);
    this.studio.save(); return describeVideo(this.studio.state, assetId);
  }
}
module.exports = { VideoReview };
