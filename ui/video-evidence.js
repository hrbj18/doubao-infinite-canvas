(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VideoEvidence = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function describeVideo(state, assetId) {
    const asset = state.assets.find(a => a.id === assetId);
    const task = state.tasks.find(t => t.outputAssetId === assetId);
    const merged = asset?.source === 'concatenation';
    const origin = merged ? 'concatenation' : task?.mode || 'unknown';
    const refs = task?.refs || [];
    const nativeFirstLast = !merged && origin === 'first_last' && refs.length === 2 && refs.filter(r => r.role === 'first').length === 1 && refs.filter(r => r.role === 'last').length === 1;
    const label = { concatenation: '本地拼接成片', references: '参考图生成', first: '首帧输入生成', first_last: '首尾帧输入生成', unknown: '导入视频 / 来源待核实' }[origin] || '来源待核实';
    const notice = merged ? `由 ${asset.sourceSegments?.length || 0} 段视频拼接；成片时长不代表一次生成时长，拼接也不证明动作或首尾帧效果。` : origin === 'references' ? '参考图参与生成，未指定原生首尾帧；需要播放视频检查实际动作。' : origin === 'first_last' ? '任务指定了首尾图；请对照实际首尾画面并播放视频验收动作，输入模式本身不证明效果。' : origin === 'first' ? '任务指定了首图，未指定目标尾图；请播放视频验收动作。' : '未找到对应的生成任务，无法证明输入模式。';
    const review = asset?.videoReview || { verdict: 'pending', reason: '' };
    return { assetId, taskId: task?.id || null, origin, label, notice, nativeFirstLast, expectedFirstAssetId: !merged ? refs.find(r => r.role === 'first')?.assetId || null : null, expectedLastAssetId: !merged ? refs.find(r => r.role === 'last')?.assetId || null : null, referenceAssetIds: !merged ? refs.filter(r => r.role === 'reference').map(r => r.assetId) : [], sourceSegments: merged ? asset.sourceSegments || [] : [], review, reviewLabel: { pending: '效果待验收', passed: '效果已验收', rejected: '效果不符合' }[review.verdict] || '效果待验收' };
  }
  return { describeVideo };
});
