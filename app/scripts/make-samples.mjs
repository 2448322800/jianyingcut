#!/usr/bin/env node
/**
 * 生成演示素材（纯色/测试图案的短视频 + 一段音频），方便第一次打开时就有东西可拖。
 *
 *   node scripts/make-samples.mjs
 *
 * 产物落在 samples/。
 */

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'samples');
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';

await mkdir(outDir, { recursive: true });

const jobs = [
  {
    name: 'aerial.mp4',
    args: [
      '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=4:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    ],
  },
  {
    name: 'street.mp4',
    args: [
      '-f', 'lavfi', '-i', 'smptebars=s=1280x720:d=3:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    ],
  },
  {
    name: 'bgm.m4a',
    args: ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'aac'],
  },
];

for (const job of jobs) {
  const target = path.join(outDir, job.name);
  await run(ffmpeg, ['-y', '-loglevel', 'error', ...job.args, target]);
  console.log(`  ✓ samples/${job.name}`);
}

console.log(`\n演示素材已生成 → ${outDir}\n`);
