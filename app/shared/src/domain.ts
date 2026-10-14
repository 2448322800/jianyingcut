/**
 * 领域模型 —— 前后端共用的唯一真源。
 *
 * 关键设计：Asset 不可变，Clip 只持有 { assetId, in, out } 引用。
 * 同一份素材可以被切成 N 段、放到 N 个位置，磁盘上永远只有一份文件。
 * 这是剪切与拼接能成立的基石。
 */

export type TrackType = 'video' | 'audio';

/** 命令来源，用于审计与「AI 操作高亮」 */
export type CommandSource = 'user' | 'ai' | 'system';

/** 原始素材（不可变） */
export interface Asset {
  id: string;
  name: string;
  /** 服务端相对路径，如 /media/<id>/source.mp4 或 /imported/0/02_数据/.../E01_S001.mp4 */
  url: string;
  /** 缩略图相对路径，探测失败时为 null */
  thumbUrl: string | null;
  /** 秒 */
  duration: number;
  width: number;
  height: number;
  /** 字节 */
  size: number;
  mimeType: string;
  createdAt: number;
  /**
   * 分组名（素材库左侧按它分栏）。上传的素材为 null；
   * 从磁盘按目录导入时，取相对根目录的第一层文件夹名，例如漫剧的 E01 / E02。
   */
  group: string | null;
  /**
   * 原地引用模式下的源文件绝对路径（上传的素材为 null）。
   * 这类素材不在服务端复制副本，直接指向磁盘原文件 —— 漫剧那边重新生成片段后编辑器立刻看到新版。
   */
  sourcePath: string | null;
}

/** 时间线上的一段。start 是时间线坐标，in/out 是素材内坐标。 */
export interface Clip {
  id: string;
  assetId: string;
  trackId: string;
  /** 时间线起点（秒），>= 0 */
  start: number;
  /** 素材内入点（秒），>= 0 */
  in: number;
  /** 素材内出点（秒），> in */
  out: number;
}

export interface Track {
  id: string;
  type: TrackType;
  name: string;
  /** 始终按 start 升序（reducer 负责维持） */
  clips: Clip[];
}

export interface Project {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  assets: Asset[];
  tracks: Track[];
  /** 单调递增修订号，SSE 用它去重与保证顺序 */
  rev: number;
  updatedAt: number;
}

// ── 时间计算 ────────────────────────────────────────────────
// 全链路统一保留 3 位小数（毫秒级），避免浮点累积误差。

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export const clipDuration = (c: Clip): number => round3(c.out - c.in);

export const clipEnd = (c: Clip): number => round3(c.start + clipDuration(c));

/** 工程总时长 = 所有轨道最后一个片段的结束时间 */
export function projectDuration(project: Project): number {
  let max = 0;
  for (const t of project.tracks) {
    for (const c of t.clips) max = Math.max(max, clipEnd(c));
  }
  return round3(max);
}

/**
 * 在某一时刻，某条轨道上正在播放的片段。
 * 片段重叠时取 start 最大的那个（后放的盖住先放的）。
 */
export function activeClipAt(track: Track, t: number): Clip | null {
  let found: Clip | null = null;
  for (const c of track.clips) {
    if (t >= c.start && t < clipEnd(c)) {
      if (!found || c.start >= found.start) found = c;
    }
  }
  return found;
}

export function findClip(project: Project, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}
