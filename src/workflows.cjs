const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assert, PLATFORMS } = require('./core.cjs');
const { extractFrame, concatenate } = require('./media.cjs');

class Workflows {
  constructor(studio) { this.studio = studio; this.pending = new Map(); }
  async operation(kind, input, handler) {
    assert(typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 && input.idempotencyKey.length <= 200, '请提供工作流幂等键');
    const identity = JSON.stringify({ kind, ...input });
    const old = this.studio.state.workflowOperations.find(x => x.key === input.idempotencyKey);
    if (old) { assert(old.identity === identity, '同一工作流幂等键对应不同参数'); if (old.status === 'completed') return structuredClone(old.result); }
    if (old && kind === 'merge') { const output = this.studio.state.exports.find(x => x.workflowKey === input.idempotencyKey); if (output) { old.result = output; old.status = 'completed'; this.studio.save(); return structuredClone(output); } }
    if (old && kind === 'shot') {
      const project = this.studio.find('projects', input.projectId), node = project.nodes.find(n => n.workflowKey === input.idempotencyKey);
      if (node) { const edges = project.edges.filter(e => e.to === node.id && e.kind === 'input'); const frame = role => project.nodes.find(n => n.id === edges.find(e => e.role === role)?.from)?.assetId || null; const result = { projectId: input.projectId, nodeId: node.id, shotId: node.shotId, sequenceId: node.sequenceId, mode: node.mode, firstAssetId: frame('first'), lastAssetId: frame('last'), status: frame('first') ? 'ready_to_edit' : 'awaiting_image', submitted: false }; old.result = result; old.status = 'completed'; this.studio.save(); return structuredClone(result); }
    }
    if (this.pending.has(input.idempotencyKey)) return this.pending.get(input.idempotencyKey);
    const record = old || { key: input.idempotencyKey, identity, kind, createdAt: this.studio.clock() };
    if (!old) this.studio.state.workflowOperations.push(record);
    record.status = 'preparing'; this.studio.save();
    const promise = (async () => {
      try { const result = await handler(); record.status = 'completed'; record.result = result; record.error = null; this.studio.save(); return structuredClone(result); }
      catch (e) { record.status = 'failed'; record.error = e.message; this.studio.save(); throw e; }
      finally { this.pending.delete(input.idempotencyKey); }
    })();
    this.pending.set(input.idempotencyKey, promise); return promise;
  }
  async createShot(input) {
    return this.operation('shot', input, async () => {
      const { studio } = this, project = studio.find('projects', input.projectId);
      assert(['continue', 'new'].includes(input.kind), '请选择继续同镜头或新分镜');
      const source = input.sourceVideoAssetId ? studio.find('assets', input.sourceVideoAssetId) : null;
      assert(input.kind !== 'continue' || source?.kind === 'video', '同镜头续接需要上一段视频');
      assert(!source || source.kind === 'video', '来源必须是视频');
      const parentTask = source && studio.state.tasks.find(t => t.outputAssetId === source.id);
      const parentVideo = source && project.nodes.find(n => n.type === 'video' && n.assetId === source.id);
      const parent = project.nodes.find(n => n.id === parentTask?.nodeId);
      const platform = input.platform || parentTask?.platform || parent?.platform || 'doubao'; assert(PLATFORMS[platform], '未知平台');
      if (input.duration !== undefined) assert(Number.isFinite(input.duration) && input.duration > 0 && input.duration <= 120, '时长无效');
      if (input.ratio) assert(['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(input.ratio), '画面比例无效');
      if (input.prompt !== undefined) assert(typeof input.prompt === 'string' && input.prompt.length <= 12000, '提示词无效');
      if (input.imageFile) assert(path.isAbsolute(input.imageFile), '图片路径必须是绝对路径');
      let last = input.lastAssetId ? studio.find('assets', input.lastAssetId) : null;
      assert(!last || last.kind === 'image', '目标尾图必须是图片');
      let first = input.imageAssetId ? studio.find('assets', input.imageAssetId) : null;
      assert(!first || first.kind === 'image', '新镜头首图必须是图片');
      assert(input.kind !== 'continue' || (!first && !input.imageFile), '同镜头首图自动从上一视频抽取，请用新分镜操作替换首图');
      if (input.kind === 'continue') first = await extractFrame(studio, { assetId: source.id, position: 'last' });
      else if (!first && input.imageFile) first = studio.registerAsset(input.imageFile, { kind: 'image' });
      // 等待抽帧期间允许画布编辑；追加到当前对象，不覆盖旧版本整张图。
      const current = studio.find('projects', project.id);
      const shotId = randomUUID(), sequenceId = parent?.sequenceId || parent?.shotId || parent?.id || parentVideo?.sequenceId || parentVideo?.id || shotId;
      const baseX = (parentVideo?.x ?? 80) + (source ? 365 : 0); let baseY = parentVideo?.y ?? 100;
      while (current.nodes.some(n => Math.abs(n.x - baseX) < 330 && Math.abs(n.y - baseY) < 300)) baseY += 360;
      const nodes = [], edges = [];
      const addImage = (image, role, y) => {
        const node = { id: randomUUID(), type: 'image', name: role === 'first' ? input.kind === 'continue' ? '上一段最后一帧' : '新分镜首图' : '目标尾图', assetId: image.id, x: baseX, y, shotId, role };
        nodes.push(node); edges.push({ id: randomUUID(), from: node.id, to: shotId, kind: 'input', role }); return node;
      };
      const firstNode = first ? addImage(first, 'first', baseY) : null;
      if (last) addImage(last, 'last', baseY + 340);
      if (input.kind === 'continue' && parentVideo && firstNode) edges.push({ id: randomUUID(), from: parentVideo.id, to: firstNode.id, kind: 'frame' });
      const generation = { id: shotId, shotId, sequenceId, parentShotId: parent?.shotId || parent?.id || parentVideo?.shotId, sourceVideoAssetId: source?.id, sourceTaskId: parentTask?.id, shotKind: input.kind === 'continue' ? 'continuation' : 'new_shot', type: 'generation', name: input.name || (input.kind === 'continue' ? '同镜头续接' : '新分镜'), platform, mode: last ? 'first_last' : 'first', x: baseX + (first ? 365 : 0), y: baseY, prompt: input.prompt ?? parent?.prompt ?? parentTask?.prompt ?? '', duration: input.duration ?? parent?.duration ?? parentTask?.duration ?? '', ratio: input.ratio ?? parent?.ratio ?? parentTask?.ratio ?? '', model: input.model ?? parent?.model ?? parentTask?.model ?? '' };
      generation.workflowKey = input.idempotencyKey; nodes.push(generation);
      if (input.kind === 'new' && parentVideo) edges.push({ id: randomUUID(), from: parentVideo.id, to: shotId, kind: 'sequence' });
      current.nodes.push(...nodes); current.edges.push(...edges); current.revision = (current.revision || 0) + 1; current.updatedAt = studio.clock();
      studio.event('shot', input.kind === 'continue' ? '精确尾帧已连接下一段，等待编辑和提交' : '新分镜已创建，等待检查素材和提交'); studio.save();
      return { projectId: project.id, nodeId: generation.id, shotId, sequenceId, mode: generation.mode, firstAssetId: first?.id || null, lastAssetId: last?.id || null, status: first ? 'ready_to_edit' : 'awaiting_image', submitted: false };
    });
  }
  async merge(input) {
    return this.operation('merge', input, async () => {
      const project = this.studio.find('projects', input.projectId);
      const result = await concatenate(this.studio, input);
      const node = { id: randomUUID(), type: 'video', name: input.name || '合并成片', assetId: result.asset.id, exportId: randomUUID(), x: Math.max(0, ...project.nodes.map(n => n.x)) + 380, y: 100 };
      const current = this.studio.find('projects', project.id); current.nodes.push(node);
      input.assetIds.forEach((id, i) => { const source = current.nodes.find(n => n.type === 'video' && n.assetId === id); if (source) current.edges.push({ id: randomUUID(), from: source.id, to: node.id, kind: 'merge', order: i }); });
      current.revision = (current.revision || 0) + 1; current.updatedAt = this.studio.clock();
      const output = { id: node.exportId, projectId: project.id, nodeId: node.id, assetId: result.asset.id, sourceAssetIds: input.assetIds, file: result.file, mediaInfo: result.mediaInfo, targetDuration: input.targetDuration, availableDuration: result.availableDuration, trimmed: result.trimmed, audio: 'original', transition: 'cut', createdAt: this.studio.clock() };
      output.workflowKey = input.idempotencyKey;
      this.studio.state.exports.push(output); this.studio.event('export', `成片已导出：${result.mediaInfo.duration.toFixed(3)}秒，保留原声`); this.studio.save(); return structuredClone(output);
    });
  }
}
module.exports = { Workflows };
