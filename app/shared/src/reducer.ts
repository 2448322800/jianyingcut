import type { Asset, Clip, Project, Track } from './domain.js';
import { clipDuration, clipEnd, round3 } from './domain.js';
import type { Command } from './commands.js';
import { clone, uuid } from './runtime.js';

/** 片段最短时长（秒）。低于此值认为无意义，用于挡住碎片与除零。 */
export const MIN_CLIP = 0.1;

/** 领域校验失败。服务端会映射为 422，绝不把堆栈暴露给客户端。 */
export class DomainError extends Error {
  readonly code: string;
  constructor(message: string, code = 'DOMAIN_ERROR') {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

const newId = (): string => uuid();
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
const byStart = (a: Clip, b: Clip): number => a.start - b.start;

function mustTrack(project: Project, trackId: string): Track {
  const t = project.tracks.find((x) => x.id === trackId);
  if (!t) throw new DomainError(`轨道不存在：${trackId}`, 'TRACK_NOT_FOUND');
  return t;
}

function mustAsset(project: Project, assetId: string): Asset {
  const a = project.assets.find((x) => x.id === assetId);
  if (!a) throw new DomainError(`素材不存在：${assetId}`, 'ASSET_NOT_FOUND');
  return a;
}

function mustClip(project: Project, clipId: string): { track: Track; clip: Clip } {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  throw new DomainError(`片段不存在：${clipId}`, 'CLIP_NOT_FOUND');
}

/**
 * 落位求解：目标位置若与已有片段重叠，向右顺延到最近的空位。
 * 永不失败——拖拽永远不会「放不下去」，也不会出现两个片段叠在一起看不清。
 */
function resolvePlacement(clips: Clip[], at: number, duration: number, excludeId?: string): number {
  const others = clips.filter((c) => c.id !== excludeId);
  let start = Math.max(0, round3(at));
  for (let guard = 0; guard < 1000; guard++) {
    const blocked = others.find((o) => start < clipEnd(o) && round3(start + duration) > o.start);
    if (!blocked) break;
    start = clipEnd(blocked);
  }
  return round3(start);
}

/** 左侧最近片段的结束时间，没有则 0 */
function prevEnd(clips: Clip[], clip: Clip): number {
  let end = 0;
  for (const o of clips) {
    if (o.id === clip.id) continue;
    if (clipEnd(o) <= clip.start + 1e-6) end = Math.max(end, clipEnd(o));
  }
  return end;
}

/** 右侧最近片段的开始时间，没有则 Infinity */
function nextStart(clips: Clip[], clip: Clip): number {
  let next = Number.POSITIVE_INFINITY;
  for (const o of clips) {
    if (o.id === clip.id) continue;
    if (o.start >= clip.start - 1e-6) next = Math.min(next, o.start);
  }
  return next;
}

/**
 * 在已克隆的 draft 上就地执行一条命令。
 * 三条不变量由这里统一维持：片段按 start 升序、start >= 0、时长 >= MIN_CLIP。
 */
function reduceOnce(project: Project, cmd: Command): void {
  switch (cmd.type) {
    case 'addClip': {
      const track = mustTrack(project, cmd.trackId);
      const asset = mustAsset(project, cmd.assetId);

      const inTime = clamp(cmd.in ?? 0, 0, Math.max(0, asset.duration - MIN_CLIP));
      const outTime = clamp(cmd.out ?? asset.duration, inTime + MIN_CLIP, asset.duration);
      const duration = round3(outTime - inTime);

      track.clips.push({
        id: newId(),
        assetId: asset.id,
        trackId: track.id,
        start: resolvePlacement(track.clips, cmd.start, duration),
        in: round3(inTime),
        out: round3(outTime),
      });
      track.clips.sort(byStart);
      return;
    }

    case 'moveClip': {
      const { track, clip } = mustClip(project, cmd.clipId);
      const target = cmd.trackId ? mustTrack(project, cmd.trackId) : track;
      const start = resolvePlacement(target.clips, cmd.start, clipDuration(clip), clip.id);

      if (target.id !== track.id) {
        track.clips = track.clips.filter((c) => c.id !== clip.id);
        clip.trackId = target.id;
        clip.start = start;
        target.clips.push(clip);
      } else {
        clip.start = start;
      }
      target.clips.sort(byStart);
      return;
    }

    case 'trimClip': {
      const { track, clip } = mustClip(project, cmd.clipId);
      const asset = mustAsset(project, clip.assetId);

      const newIn = round3(clamp(cmd.in ?? clip.in, 0, asset.duration - MIN_CLIP));
      let newOut = round3(clamp(cmd.out ?? clip.out, newIn + MIN_CLIP, asset.duration));
      const newStart = round3(Math.max(cmd.start ?? clip.start, prevEnd(track.clips, clip)));

      // 不许压到右邻居：超出可用空间就缩出点
      const room = round3(nextStart(track.clips, clip) - newStart);
      if (Number.isFinite(room) && newOut - newIn > room) {
        newOut = round3(clamp(newIn + Math.max(room, MIN_CLIP), newIn + MIN_CLIP, asset.duration));
      }

      clip.in = newIn;
      clip.out = newOut;
      clip.start = newStart;
      track.clips.sort(byStart);
      return;
    }

    case 'splitClip': {
      const { track, clip } = mustClip(project, cmd.clipId);
      const duration = clipDuration(clip);
      const offset = round3(cmd.at - clip.start);

      if (offset < MIN_CLIP || duration - offset < MIN_CLIP) {
        throw new DomainError(
          `分割点必须落在片段内部（距两端至少 ${MIN_CLIP}s），当前偏移 ${offset}s`,
          'SPLIT_OUT_OF_RANGE',
        );
      }

      const right: Clip = {
        id: newId(),
        assetId: clip.assetId,
        trackId: track.id,
        start: round3(clip.start + offset),
        in: round3(clip.in + offset),
        out: clip.out,
      };
      clip.out = round3(clip.in + offset);
      track.clips.push(right);
      track.clips.sort(byStart);
      return;
    }

    case 'deleteClip': {
      const { track, clip } = mustClip(project, cmd.clipId);
      track.clips = track.clips.filter((c) => c.id !== clip.id);
      return;
    }

    case 'concatTrack': {
      const track = mustTrack(project, cmd.trackId);
      let cursor = 0;
      track.clips.sort(byStart);
      for (const c of track.clips) {
        c.start = round3(cursor);
        cursor = round3(cursor + clipDuration(c));
      }
      return;
    }

    case 'clearTrack': {
      mustTrack(project, cmd.trackId).clips = [];
      return;
    }

    default: {
      throw new DomainError(`未知命令：${JSON.stringify(cmd)}`, 'UNKNOWN_COMMAND');
    }
  }
}

/** 批量应用。批次是原子的：任一条抛错，整体不生效。 */
export function applyCommands(project: Project, commands: Command[]): Project {
  const draft = clone(project);
  for (const cmd of commands) reduceOnce(draft, cmd);
  return draft;
}

export function applyCommand(project: Project, command: Command): Project {
  return applyCommands(project, [command]);
}
