const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { assert } = require('./core.cjs');

function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true }); let stderr = '', stdout = '', size = 0;
    child.stderr.on('data', x => { stderr = (stderr + x).slice(-5000); });
    child.stdout.on('data', x => { size += x.length; if (size > 1024 ** 2) child.kill(); else stdout += x; });
    child.on('error', e => reject(new Error(`无法运行 ${command}：${e.message}`)));
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${command} 失败：${size > 1024 ** 2 ? '输出超过限制' : stderr}`)));
  });
}
async function videoInfo(file) {
  const probe = JSON.parse(await execute('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate,duration,nb_frames', '-of', 'json', file]));
  const video = probe.streams?.find(s => s.codec_type === 'video');
  assert(video, '素材没有视频画面');
  const duration = Number(video.duration || probe.format?.duration), rate = video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video.r_frame_rate;
  const [top, bottom = 1] = String(rate || '24/1').split('/').map(Number), fps = top / bottom;
  assert(Number.isFinite(duration) && duration > 0 && Number.isFinite(fps) && fps > 0, '视频时长或帧率无法识别');
  return { duration, width: video.width, height: video.height, fps, frameRate: rate || '24/1', frames: Number(video.nb_frames) || null, hasAudio: probe.streams.some(s => s.codec_type === 'audio') };
}
async function extractFrame(studio, { assetId, time = 0, position }) {
  const asset = studio.find('assets', assetId); assert(asset.kind === 'video', '抽帧素材必须是视频');
  assert(Number.isFinite(time) && time >= 0 && time < 86400, '抽帧时间不正确');
  assert(!position || ['first', 'last'].includes(position), '未知抽帧位置');
  const info = await videoInfo(asset.file);
  const last = position === 'last', second = last ? Math.max(0, info.duration - 2) : position === 'first' ? 0 : time;
  assert(second < info.duration, `抽帧时间必须小于视频时长 ${info.duration.toFixed(2)} 秒`);
  const temp = path.join(studio.directory, 'assets', `frame-${randomUUID()}.png`);
  try {
    // 解码末尾两秒再反转，第一张输出即真实最后一张可解码画面，兼容可变帧率。
    await execute('ffmpeg', ['-v', 'error', '-y', '-ss', String(second), '-i', asset.file, '-map', '0:v:0', ...(last ? ['-vf', 'reverse'] : []), '-frames:v', '1', '-update', '1', temp]);
    assert(fs.existsSync(temp) && fs.statSync(temp).size > 0, '没有可解码的画面');
    const image = studio.registerAsset(temp, { name: `${asset.name}-${last ? '最后一帧' : position === 'first' ? '首帧' : `${time.toFixed(2)}s`}.png`, kind: 'image' });
    const original = studio.find('assets', image.id);
    original.sourceFrame = { assetId, position: position || 'time', ...(last ? { selection: 'last_decodable' } : { time: second }), extractedAt: studio.clock() };
    original.sourceTaskId = studio.state.tasks.find(t => t.outputAssetId === assetId)?.id;
    studio.save(); return structuredClone(original);
  } finally { if (fs.existsSync(temp)) fs.rmSync(temp); }
}
async function concatenate(studio, { assetIds, targetDuration, name = '合并成片' }) {
  assert(Array.isArray(assetIds) && assetIds.length >= 2 && assetIds.length <= 32, '请按顺序选择2–32段视频');
  const assets = assetIds.map(id => { const a = studio.find('assets', id); assert(a.kind === 'video', '拼接素材必须是视频'); return a; });
  const infos = await Promise.all(assets.map(a => videoInfo(a.file)));
  const availableDuration = infos.reduce((sum, i) => sum + i.duration, 0), first = infos[0], tolerance = 1 / first.fps;
  if (targetDuration !== undefined) {
    assert(Number.isFinite(targetDuration) && targetDuration > 0 && targetDuration <= 3600, '目标时长必须在0–3600秒之间');
    assert(availableDuration + tolerance >= targetDuration, `视频总长${availableDuration.toFixed(3)}秒，不足目标${targetDuration}秒；请补充片段，不会自动重新生成`);
  }
  const duration = targetDuration ?? availableDuration, width = first.width - first.width % 2, height = first.height - first.height % 2;
  const file = path.join(studio.directory, 'outputs', `export-${randomUUID()}.mp4`), temporary = file.replace(/\.mp4$/, '.part.mp4');
  const filters = [], inputs = [];
  for (let i = 0; i < assets.length; i++) {
    inputs.push('-i', assets[i].file);
    filters.push(`[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${first.frameRate},setpts=PTS-STARTPTS[v${i}]`);
    filters.push(`${infos[i].hasAudio ? `[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo,apad` : 'anullsrc=r=48000:cl=stereo'},atrim=duration=${infos[i].duration},asetpts=PTS-STARTPTS[a${i}]`);
  }
  filters.push(`${assets.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${assets.length}:v=1:a=1[v][a]`);
  try {
    await execute('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-t', String(duration), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', temporary]);
    const output = await videoInfo(temporary);
    assert(Math.abs(output.duration - duration) <= tolerance + .002, '导出时长偏差超过一帧，保留原片等待处理');
    fs.renameSync(temporary, file);
    const asset = studio.registerAsset(file, { kind: 'video', name: `${name}.mp4` });
    Object.assign(studio.find('assets', asset.id), { mediaInfo: output, sourceSegments: [...assetIds], targetDuration: duration, source: 'concatenation' }); studio.save();
    return { asset: structuredClone(studio.find('assets', asset.id)), file, mediaInfo: output, availableDuration, trimmed: Math.max(0, availableDuration - duration) };
  } catch (e) { if (fs.existsSync(file)) fs.rmSync(file); throw e; }
  finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
}
module.exports = { execute, videoInfo, extractFrame, concatenate };
