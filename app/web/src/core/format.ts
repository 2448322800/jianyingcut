/** 时间与尺寸的格式化工具。时间线里到处要用，集中一处避免各处各写法。 */

/** 00:12.34 —— 时间线标尺、片段标签用 */
export function timecode(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}

/** 12.3s / 1m23s —— 人类读的时长 */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m${String(rest).padStart(2, '0')}s`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/**
 * 吸附：把 target 拉到最近的候选点上，前提是距离小于阈值。
 * 拖拽时手感的关键——没有它，片段永远对不齐。
 */
export function snap(target: number, candidates: number[], threshold: number): number {
  let best = target;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - target);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** 根据缩放挑一个好看的标尺刻度间隔（1/2/5/10/15/30/60 秒） */
export function tickInterval(pxPerSecond: number): number {
  const candidates = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const minPx = 70;
  for (const c of candidates) {
    if (c * pxPerSecond >= minPx) return c;
  }
  return 600;
}
