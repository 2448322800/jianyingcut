#!/usr/bin/env node
/**
 * 端到端冒烟测试：真起服务、真上传、真走命令。
 *
 *   node scripts/smoke.mjs [baseUrl]
 *
 * 覆盖：健康检查 → 生成测试视频 → 上传 → 加片段 → 拼接 → 分割 → SSE。
 * 每一步失败都返回非零退出码，可以直接挂 CI。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const BASE = (process.argv[2] ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
let passed = 0;

function ok(label, extra = '') {
  passed += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${label}${extra ? ` \x1b[90m${extra}\x1b[0m` : ''}`);
}

function assert(condition, message) {
  if (!condition) {
    console.error(`  \x1b[31m✗\x1b[0m ${message}`);
    process.exit(1);
  }
}

async function json(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function commands(cmds, source = 'ai') {
  const res = await json('POST', '/api/commands', { commands: cmds, source });
  if (res.status !== 200) {
    throw new Error(`命令失败 ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.project;
}

async function makeClip(file, seconds, color) {
  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=${seconds}:r=24`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    file,
  ]);
}

async function upload(file, name) {
  const buf = await readFile(file);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'video/mp4' }), name);
  const res = await fetch(`${BASE}/api/assets`, { method: 'POST', body: form });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`上传失败 ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function totalDuration(project) {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) max = Math.max(max, clip.start + (clip.out - clip.in));
  }
  return Math.round(max * 1000) / 1000;
}

const dir = await mkdtemp(path.join(tmpdir(), 'ai-cut-smoke-'));
console.log(`\n冒烟测试 → ${BASE}\n`);

try {
  // 1. 健康检查
  const health = await json('GET', '/health');
  assert(health.status === 200 && health.body?.status === 'ok', `/health 异常: ${JSON.stringify(health.body)}`);
  ok('GET /health', `uptime ${health.body.uptime}s · rev ${health.body.rev}`);

  const ready = await json('GET', '/ready');
  assert(ready.status === 200, `/ready 异常: ${JSON.stringify(ready.body)}`);
  ok('GET /ready');

  // 2. 生成并上传两个测试片段
  const fileA = path.join(dir, 'a.mp4');
  const fileB = path.join(dir, 'b.mp4');
  await makeClip(fileA, 1.5, 'navy');
  await makeClip(fileB, 2.0, 'darkgreen');
  ok('生成测试视频', 'a.mp4 1.5s / b.mp4 2.0s');

  const upA = await upload(fileA, 'a.mp4');
  const upB = await upload(fileB, 'b.mp4');
  assert(upA.asset?.duration > 1.4, `探测时长不对: ${JSON.stringify(upA.asset)}`);
  assert(upA.asset.thumbUrl, '未生成缩略图');
  ok('POST /api/assets', `元数据 ${upA.asset.width}x${upA.asset.height} · ${upA.asset.duration}s · 缩略图已生成`);

  // 3. 把素材登记进工程（上传走的是独立入口）
  let project = (await json('GET', '/api/project')).body.project;
  assert(project.assets.length >= 2, '素材未登记进工程');
  ok('GET /api/project', `${project.assets.length} 个素材 · ${project.tracks.length} 条轨道`);

  // 测试必须自包含：工程里可能已经有别人的片段（比如从漫剧导入后铺好的），先清空再断言
  project = await commands([{ type: 'clearTrack', trackId: 'V1' }], 'system');
  assert(project.tracks.find((t) => t.id === 'V1').clips.length === 0, '清空 V1 失败');
  ok('命令 clearTrack', 'V1 已清空，后续断言基于确定状态');

  // 4. 加片段
  project = await commands([
    { type: 'addClip', trackId: 'V1', assetId: upA.asset.id, start: 0 },
    { type: 'addClip', trackId: 'V1', assetId: upB.asset.id, start: 5 },
  ]);
  const v1 = project.tracks.find((t) => t.id === 'V1');
  assert(v1.clips.length === 2, `片段数不对: ${v1.clips.length}`);
  ok('命令 addClip ×2', `V1 共 ${v1.clips.length} 段`);

  // 5. 拼接：应当左对齐首尾相接
  project = await commands([{ type: 'concatTrack', trackId: 'V1' }]);
  const laid = project.tracks.find((t) => t.id === 'V1').clips;
  assert(laid[0].start === 0, `第一段起点应为 0，实际 ${laid[0].start}`);
  const firstDur = Math.round((laid[0].out - laid[0].in) * 1000) / 1000;
  assert(Math.abs(laid[1].start - firstDur) < 0.002, `第二段起点应为 ${firstDur}，实际 ${laid[1].start}`);
  ok('命令 concatTrack', `首尾相接：0 → ${laid[1].start}s → ${totalDuration(project)}s`);

  // 6. 分割
  const target = laid[1];
  const at = Math.round((target.start + (target.out - target.in) / 2) * 1000) / 1000;
  project = await commands([{ type: 'splitClip', clipId: target.id, at }]);
  const after = project.tracks.find((t) => t.id === 'V1').clips;
  assert(after.length === 3, `分割后应有 3 段，实际 ${after.length}`);
  const sum = after.reduce((acc, c) => acc + (c.out - c.in), 0);
  assert(Math.abs(sum - totalDuration(project)) < 0.01, '分割后总时长发生了漂移');
  ok('命令 splitClip', `在 ${at}s 一刀两段 · 总时长未漂移 ${totalDuration(project)}s`);

  // 7. 失败路径：越界分割必须被拒绝，且带规范化错误结构
  const bad = await json('POST', '/api/commands', {
    commands: [{ type: 'splitClip', clipId: after[0].id, at: 9999 }],
    source: 'ai',
  });
  assert(bad.status === 422, `越界分割应返回 422，实际 ${bad.status}`);
  assert(bad.body?.error?.code && bad.body.error.requestId, '错误结构不规范');
  ok('非法命令被拒绝', `${bad.status} ${bad.body.error.code} · 带 requestId`);

  // 8. SSE 首帧
  const controller = new AbortController();
  const sse = await fetch(`${BASE}/api/events`, { signal: controller.signal });
  assert(sse.status === 200, `SSE 状态码 ${sse.status}`);
  assert((sse.headers.get('content-type') ?? '').includes('text/event-stream'), 'SSE Content-Type 不对');
  const reader = sse.body.getReader();
  const chunk = await reader.read();
  controller.abort();
  const text = new TextDecoder().decode(chunk.value ?? new Uint8Array());
  assert(text.includes('event: project') && text.includes('"rev"'), `SSE 首帧异常: ${text.slice(0, 120)}`);
  ok('GET /api/events', 'SSE 握手成功且首帧带工程状态');

  console.log(`\n\x1b[32m全部 ${passed} 项通过\x1b[0m\n`);
} catch (err) {
  console.error(`\n\x1b[31m冒烟测试失败:\x1b[0m ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
