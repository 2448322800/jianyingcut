import type { CommandSource } from './domain.js';

/**
 * 编辑命令 —— 整个系统的唯一变更入口。
 *
 * UI 拖拽发命令，AI 发同一条命令。禁止在组件里直接改状态。
 * 全部使用「绝对值」而非「增量」（in/out/start 都是目标值），
 * 这样命令幂等、可重放、AI 也容易生成。
 */
export type Command =
  /** 把素材放到某轨道的某位置。in/out 省略则取整段素材。 */
  | { type: 'addClip'; trackId: string; assetId: string; start: number; in?: number; out?: number }
  /** 改位置，可跨轨道 */
  | { type: 'moveClip'; clipId: string; start: number; trackId?: string }
  /** 改入点/出点（裁剪）。start 可选，用于左边缘裁剪时同步锚定画面。 */
  | { type: 'trimClip'; clipId: string; in?: number; out?: number; start?: number }
  /** 在时间线绝对时刻 at 处一刀两段 */
  | { type: 'splitClip'; clipId: string; at: number }
  | { type: 'deleteClip'; clipId: string }
  /** 把轨道上所有片段左对齐、首尾相接 —— 这就是「拼接」 */
  | { type: 'concatTrack'; trackId: string }
  /** 清空某轨道 */
  | { type: 'clearTrack'; trackId: string };

export type CommandType = Command['type'];

/** 命令信封：记录谁在什么时候发了它 */
export interface CommandEnvelope {
  id: string;
  source: CommandSource;
  at: number;
  command: Command;
}

/** 人类可读的命令描述，用于命令流日志 */
export function describeCommand(c: Command): string {
  switch (c.type) {
    case 'addClip':
      return `添加片段到 ${c.trackId}，起点 ${fmt(c.start)}s`;
    case 'moveClip':
      return `移动片段 ${c.clipId.slice(0, 6)} 到 ${fmt(c.start)}s${c.trackId ? ` / ${c.trackId}` : ''}`;
    case 'trimClip': {
      const bits: string[] = [];
      if (c.in !== undefined) bits.push(`入点 ${fmt(c.in)}s`);
      if (c.out !== undefined) bits.push(`出点 ${fmt(c.out)}s`);
      if (c.start !== undefined) bits.push(`起点 ${fmt(c.start)}s`);
      return `裁剪片段 ${c.clipId.slice(0, 6)}：${bits.join('，')}`;
    }
    case 'splitClip':
      return `在 ${fmt(c.at)}s 分割片段 ${c.clipId.slice(0, 6)}`;
    case 'deleteClip':
      return `删除片段 ${c.clipId.slice(0, 6)}`;
    case 'concatTrack':
      return `拼接轨道 ${c.trackId}（左对齐首尾相接）`;
    case 'clearTrack':
      return `清空轨道 ${c.trackId}`;
  }
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
