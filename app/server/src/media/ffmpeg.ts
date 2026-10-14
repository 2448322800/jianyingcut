import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config/env.js';

const run = promisify(execFile);

/**
 * 仓储层：唯一直接调用 ffmpeg / ffprobe 的地方。
 * 上层服务只拿到结构化的结果，不知道命令行长什么样。
 */

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  hasVideo: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

export async function probe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await run(
    env.ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: 16 * 1024 * 1024 },
  );

  const data = JSON.parse(stdout) as FfprobeOutput;
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');

  const duration = Number(data.format?.duration ?? video?.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('无法读取媒体时长，文件可能损坏或不是音视频');
  }
  if (!video && !audio) {
    throw new Error('文件中既没有视频流也没有音频流');
  }

  return {
    duration: Math.round(duration * 1000) / 1000,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasVideo: Boolean(video),
  };
}

/** 抽一帧当缩略图。纯音频没有视频流，返回 false 是正常情况。 */
export async function makeThumbnail(src: string, dest: string, atSeconds = 0.5): Promise<boolean> {
  try {
    await run(
      env.ffmpegPath,
      ['-y', '-ss', String(atSeconds), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', dest],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return true;
  } catch {
    return false;
  }
}
