#!/usr/bin/env node
/**
 * 领域逻辑自检：不起服务、不装测试框架，直接跑纯函数。
 *
 *   node shared/test/check.mjs
 *
 * 覆盖剪切与拼接的边界条件 —— 这几条逻辑一旦错，
 * 前端「拖一下」和后端「AI 改一下」就会各说各话。
 */

import { applyCommands, applyCommand, clipDuration, clipEnd, DomainError, MIN_CLIP } from '../dist/index.js';

let passed = 0;
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } catch (err) {
    console.error(`  \x1b[31m✗\x1b[0m ${label}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

const eq = (actual, expected, what) => {
  if (Math.abs(actual - expected) > 0.002) {
    throw new Error(`${what}：期望 ${expected}，实际 ${actual}`);
  }
};

const asset = (id, duration) => ({
  id,
  name: `${id}.mp4`,
  url: `/media/${id}/source.mp4`,
  thumbUrl: null,
  duration,
  width: 1920,
  height: 1080,
  size: 1000,
  mimeType: 'video/mp4',
  createdAt: 0,
  group: null,
  sourcePath: null,
});

const baseProject = () => ({
  id: 'test',
  name: '测试工程',
  fps: 30,
  width: 1920,
  height: 1080,
  assets: [asset('a', 10), asset('b', 4)],
  tracks: [
    { id: 'V1', type: 'video', name: '主视频', clips: [] },
    { id: 'V2', type: 'video', name: '覆盖层', clips: [] },
    { id: 'A1', type: 'audio', name: '音频', clips: [] },
  ],
  rev: 0,
  updatedAt: 0,
});

const v1 = (p) => p.tracks.find((t) => t.id === 'V1');

console.log('\n领域逻辑自检\n');

check('addClip：整段素材落到指定位置', () => {
  const p = applyCommand(baseProject(), { type: 'addClip', trackId: 'V1', assetId: 'a', start: 3 });
  eq(v1(p).clips.length, 1, '片段数');
  eq(v1(p).clips[0].start, 3, '起点');
  eq(clipDuration(v1(p).clips[0]), 10, '时长');
});

check('addClip：位置重叠时自动向右顺延，不叠在一起', () => {
  let p = applyCommand(baseProject(), { type: 'addClip', trackId: 'V1', assetId: 'a', start: 0 });
  p = applyCommand(p, { type: 'addClip', trackId: 'V1', assetId: 'b', start: 2 });
  const clips = v1(p).clips;
  eq(clips.length, 2, '片段数');
  eq(clips[1].start, 10, '第二段应被推到第一段之后');
});

check('addClip：起点为负数会被夹到 0', () => {
  const p = applyCommand(baseProject(), { type: 'addClip', trackId: 'V1', assetId: 'b', start: -5 });
  eq(v1(p).clips[0].start, 0, '起点');
});

check('splitClip：一刀两段，两段时长之和等于原时长', () => {
  let p = applyCommand(baseProject(), { type: 'addClip', trackId: 'V1', assetId: 'a', start: 0 });
  const original = v1(p).clips[0];
  p = applyCommand(p, { type: 'splitClip', clipId: original.id, at: 4 });
  const clips = v1(p).clips;
  eq(clips.length, 2, '片段数');
  eq(clips[0].out, 4, '左段出点');
  eq(clips[1].in, 4, '右段入点');
  eq(clips[1].start, 4, '右段起点');
  eq(clipDuration(clips[0]) + clipDuration(clips[1]), clipDuration(original), '总时长');
});

check('splitClip：分割点越界必须报错，不是静默吞掉', () => {
  let threw = false;
  try {
    const p = applyCommand(baseProject(), { type: 'addClip', trackId: 'V1', assetId: 'a', start: 0 });
    applyCommand(p, { type: 'splitClip', clipId: v1(p).clips[0].id, at: 99 });
  } catch (err) {
    threw = err instanceof DomainError && err.code === 'SPLIT_OUT_OF_RANGE';
  }
  if (!threw) throw new Error('越界分割没有抛出 SPLIT_OUT_OF_RANGE');
});

check('concatTrack：把散落的片段左对齐、首尾相接', () => {
  let p = baseProject();
  p = applyCommands(p, [
    { type: 'addClip', trackId: 'V1', assetId: 'a', start: 6 },
    { type: 'addClip', trackId: 'V1', assetId: 'b', start: 20 },
  ]);
  p = applyCommand(p, { type: 'concatTrack', trackId: 'V1' });
  const clips = v1(p).clips;
  eq(clips[0].start, 0, '第一段起点');
  eq(clips[1].start, clipDuration(clips[0]), '第二段起点');
  eq(clipEnd(clips[1]), 14, '总时长 10+4');
});

check('trimClip：右边缘不得越过右邻居', () => {
  // 把一段切开成左右两半，再把左半的出点往右拖 —— 必须停在右半的入点
  let p = applyCommand(baseProject(), { type: 'addClip', trackId: 'V1', assetId: 'a', start: 0 });
  p = applyCommand(p, { type: 'splitClip', clipId: v1(p).clips[0].id, at: 4 });
  const [left, right] = v1(p).clips;
  p = applyCommand(p, { type: 'trimClip', clipId: left.id, out: 8 });
  const after = v1(p).clips.find((c) => c.id === left.id);
  if (clipEnd(after) > right.start + 0.002) {
    throw new Error(`越过了右邻居：结束于 ${clipEnd(after)}，右邻居起点 ${right.start}`);
  }
  eq(clipEnd(after), right.start, '应停在右邻居起点');
});

check('trimClip：左边缘不得越过左邻居', () => {
  let p = baseProject();
  p = applyCommands(p, [
    { type: 'addClip', trackId: 'V1', assetId: 'b', start: 0 },
    { type: 'addClip', trackId: 'V1', assetId: 'a', start: 4 },
  ]);
  const second = v1(p).clips[1];
  p = applyCommand(p, { type: 'trimClip', clipId: second.id, in: 0, start: -10 });
  const after = v1(p).clips.find((c) => c.id === second.id);
  eq(after.start, 4, '起点应被左邻居挡住');
});

check('moveClip：跨轨道搬运后，两边的片段集合都正确', () => {
  let p = applyCommand(baseProject(), { type: 'addClip', trackId: 'V1', assetId: 'a', start: 0 });
  const clip = v1(p).clips[0];
  p = applyCommand(p, { type: 'moveClip', clipId: clip.id, trackId: 'V2', start: 2 });
  eq(v1(p).clips.length, 0, '原轨道片段数');
  const v2 = p.tracks.find((t) => t.id === 'V2');
  eq(v2.clips.length, 1, '目标轨道片段数');
  eq(v2.clips[0].start, 2, '新起点');
  if (v2.clips[0].trackId !== 'V2') throw new Error('trackId 没有跟着更新');
});

check('批量命令是原子的：一条不合法，整体不生效', () => {
  const before = applyCommand(baseProject(), { type: 'addClip', trackId: 'V1', assetId: 'a', start: 0 });
  const snapshot = JSON.stringify(before);
  let threw = false;
  try {
    applyCommands(before, [
      { type: 'addClip', trackId: 'V1', assetId: 'b', start: 30 },
      { type: 'splitClip', clipId: 'not-exist', at: 1 },
    ]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('非法批量命令未报错');
  if (JSON.stringify(before) !== snapshot) throw new Error('失败后原工程被改动了');
});

check('命令不修改入参（纯函数）', () => {
  const original = baseProject();
  const snapshot = JSON.stringify(original);
  applyCommands(original, [
    { type: 'addClip', trackId: 'V1', assetId: 'a', start: 0 },
    { type: 'addClip', trackId: 'V1', assetId: 'b', start: 1 },
  ]);
  if (JSON.stringify(original) !== snapshot) throw new Error('入参被就地修改了');
});

check('float 不累积误差：连续 20 次分割后总时长仍精确', () => {
  let p = applyCommand(baseProject(), { type: 'addClip', trackId: 'V1', assetId: 'a', start: 0 });
  for (let i = 0; i < 20; i++) {
    const clips = v1(p).clips;
    const target = clips[clips.length - 1];
    const dur = clipDuration(target);
    if (dur < MIN_CLIP * 2.2) break;
    p = applyCommand(p, { type: 'splitClip', clipId: target.id, at: target.start + dur / 2 });
  }
  const sum = v1(p).clips.reduce((acc, c) => acc + clipDuration(c), 0);
  eq(sum, 10, `总时长（分成 ${v1(p).clips.length} 段）`);
});

console.log(`\n${process.exitCode ? '\x1b[31m有失败项\x1b[0m' : `\x1b[32m全部 ${passed} 项通过\x1b[0m`}\n`);
