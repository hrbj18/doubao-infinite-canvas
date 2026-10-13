const fs = require('node:fs');
const SAMPLE = 'C:\\Users\\Administrator\\Pictures\\素材\\微信图片_20261008165625_99_60.jpg';
function seed(studio) {
  if (studio.state.projects.length) return;
  const project = studio.createProject('持剑小猫 · 动作测试');
  if (!fs.existsSync(SAMPLE)) return;
  const image = studio.registerAsset(SAMPLE, { name: '持剑小猫.jpg' });
  studio.saveProject(project.id, { viewport: { x: 20, y: 25, scale: .8 }, nodes: [
    { id: 'sample-image', type: 'image', name: '持剑小猫 · 参考图', assetId: image.id, x: 70, y: 80 },
    { id: 'sample-generation', type: 'generation', name: '让小猫动起来', platform: 'doubao', mode: 'references', x: 480, y: 80, prompt: '保持参考图中小猫、盔甲、粉色蝴蝶结和长剑的外观一致。小猫轻轻眨眼，缓缓抬头，再缓慢举起长剑，披风随微风轻轻飘动。动作自然克制，镜头固定，保持完整构图。', duration: '', ratio: '' }
  ], edges: [{ id: 'sample-edge', from: 'sample-image', to: 'sample-generation', role: 'reference' }] });
}
module.exports = { seed, SAMPLE };
