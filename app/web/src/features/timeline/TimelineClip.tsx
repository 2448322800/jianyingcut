import { useRef, useState } from 'react';
import { MIN_CLIP, round3, type Asset, type Clip, type Command } from '@ai-cut/shared';
import { mediaUrl } from '../../core/api.js';
import { clamp, snap, timecode } from '../../core/format.js';

/**
 * 时间线上的一个片段。
 *
 * 三条交互：
 *  - 拖本体 → moveClip
 *  - 拖左边缘 → 改入点，同时把起点一起挪（画面内容保持锚定，这是剪辑软件的通行手感）
 *  - 拖右边缘 → 改出点
 *
 * 拖拽过程中只改本地显示，松手才 dispatch 一条命令 —— 一次拖拽 = 一条命令，
 * 命令流不会被鼠标移动刷屏，AI 侧看到的操作历史也是干净的。
 */

type DragKind = 'move' | 'trim-left' | 'trim-right';

interface DragBase {
  kind: DragKind;
  pointerId: number;
  originX: number;
  base: Clip;
}

interface Geometry {
  in: number;
  out: number;
  start: number;
}

interface Props {
  clip: Clip;
  asset: Asset | undefined;
  pxPerSecond: number;
  selected: boolean;
  snapPoints: number[];
  onSelect: (id: string) => void;
  onCommit: (command: Command) => void;
  onSplitAt: (clipId: string, at: number) => void;
  onInteractStart: () => void;
  onInteractEnd: () => void;
}

const SNAP_PX = 8;
const HANDLE_PX = 8;

export function TimelineClip({
  clip,
  asset,
  pxPerSecond,
  selected,
  snapPoints,
  onSelect,
  onCommit,
  onSplitAt,
  onInteractStart,
  onInteractEnd,
}: Props): React.JSX.Element {
  const dragRef = useRef<DragBase | null>(null);
  const [draft, setDraft] = useState<Geometry | null>(null);

  const shown: Geometry = draft ?? { in: clip.in, out: clip.out, start: clip.start };
  const duration = round3(shown.out - shown.in);
  const left = shown.start * pxPerSecond;
  const width = Math.max(8, duration * pxPerSecond);
  const thumb = asset?.thumbUrl ? mediaUrl(asset.thumbUrl) : null;
  const assetDuration = asset?.duration ?? clip.out;

  const begin = (event: React.PointerEvent<HTMLDivElement>, kind: DragKind): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind, pointerId: event.pointerId, originX: event.clientX, base: { ...clip } };
    setDraft({ in: clip.in, out: clip.out, start: clip.start });
    onSelect(clip.id);
    onInteractStart();
  };

  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaSeconds = (event.clientX - drag.originX) / pxPerSecond;
    const threshold = SNAP_PX / pxPerSecond;
    const base = drag.base;

    if (drag.kind === 'move') {
      const rawStart = Math.max(0, base.start + deltaSeconds);
      const rawEnd = rawStart + (base.out - base.in);
      // 头和尾都参与吸附，取更接近的那个
      const headSnap = snap(rawStart, snapPoints, threshold);
      const tailSnap = snap(rawEnd, snapPoints, threshold);
      let start = rawStart;
      if (Math.abs(headSnap - rawStart) <= Math.abs(tailSnap - rawEnd)) start = headSnap;
      else start = tailSnap - (base.out - base.in);
      setDraft({ in: base.in, out: base.out, start: round3(Math.max(0, start)) });
      return;
    }

    if (drag.kind === 'trim-left') {
      let newIn = clamp(base.in + deltaSeconds, 0, base.out - MIN_CLIP);
      let start = base.start + (newIn - base.in);
      const snappedStart = snap(start, snapPoints, threshold);
      if (snappedStart !== start) {
        newIn = clamp(base.in + (snappedStart - base.start), 0, base.out - MIN_CLIP);
        start = base.start + (newIn - base.in);
      }
      setDraft({ in: round3(newIn), out: base.out, start: round3(Math.max(0, start)) });
      return;
    }

    let newOut = clamp(base.out + deltaSeconds, base.in + MIN_CLIP, assetDuration);
    const end = base.start + (newOut - base.in);
    const snappedEnd = snap(end, snapPoints, threshold);
    if (snappedEnd !== end) newOut = clamp(base.in + (snappedEnd - base.start), base.in + MIN_CLIP, assetDuration);
    setDraft({ in: base.in, out: round3(newOut), start: base.start });
  };

  const finish = (): void => {
    const drag = dragRef.current;
    const geometry = draft;
    dragRef.current = null;
    setDraft(null);
    onInteractEnd();
    if (!drag || !geometry) return;

    const changed =
      Math.abs(geometry.start - drag.base.start) > 0.001 ||
      Math.abs(geometry.in - drag.base.in) > 0.001 ||
      Math.abs(geometry.out - drag.base.out) > 0.001;
    if (!changed) return;

    if (drag.kind === 'move') {
      onCommit({ type: 'moveClip', clipId: clip.id, start: geometry.start });
    } else {
      onCommit({
        type: 'trimClip',
        clipId: clip.id,
        in: geometry.in,
        out: geometry.out,
        start: geometry.start,
      });
    }
  };

  return (
    <div
      className={`clip${selected ? ' selected' : ''}${draft ? ' dragging' : ''}`}
      data-clip-id={clip.id}
      data-asset-id={clip.assetId}
      style={{ left, width }}
      onPointerDown={(e) => begin(e, 'move')}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={(event) => {
        // 双击片段：在播放头处分割（播放头不在片段内则忽略）
        const rect = event.currentTarget.getBoundingClientRect();
        const at = clip.start + (event.clientX - rect.left) / pxPerSecond;
        if (at > clip.start + MIN_CLIP && at < clip.start + (clip.out - clip.in) - MIN_CLIP) {
          onSplitAt(clip.id, round3(at));
        }
      }}
      title={`${asset?.name ?? '素材'} · ${timecode(clip.start)} → ${timecode(clip.start + (clip.out - clip.in))}`}
    >
      <div
        className="clip-handle left"
        style={{ width: HANDLE_PX }}
        onPointerDown={(e) => begin(e, 'trim-left')}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
      />
      {thumb && <img className="clip-thumb" src={thumb} alt="" draggable={false} />}
      <span className="clip-label">{asset?.name ?? '已丢失素材'}</span>
      <span className="clip-meta">{duration.toFixed(1)}s</span>
      <div
        className="clip-handle right"
        style={{ width: HANDLE_PX }}
        onPointerDown={(e) => begin(e, 'trim-right')}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
      />
    </div>
  );
}
