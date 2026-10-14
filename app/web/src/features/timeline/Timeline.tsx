import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  MIN_CLIP,
  activeClipAt,
  clipDuration,
  findClip,
  projectDuration,
  round3,
  type Command,
  type Project,
} from '@ai-cut/shared';
import { ASSET_MIME } from '../../core/dnd.js';
import { tickInterval, timecode } from '../../core/format.js';
import { useEditor } from '../../core/store.js';
import { TimelineClip } from './TimelineClip.js';

/**
 * 时间线容器：标尺、播放头、多轨、拖放落位。
 * 只订阅 project 与 zoom —— 播放头走独立子组件，避免播放时整棵树 60fps 重渲染。
 */

/** 可供吸附的点：所有片段的首尾 + 播放头 + 0 */
function snapPoints(project: Project, exclude?: string | null): number[] {
  const points = [0, useEditor.getState().playhead];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id === exclude) continue;
      points.push(clip.start, clip.start + clipDuration(clip));
    }
  }
  return points;
}

function Playhead({ pxPerSecond }: { pxPerSecond: number }): React.JSX.Element {
  const playhead = useEditor((s) => s.playhead);
  return (
    <div className="tl-playhead" style={{ left: playhead * pxPerSecond }}>
      <div className="tl-playhead-head" />
    </div>
  );
}

function TimeReadout(): React.JSX.Element {
  const playhead = useEditor((s) => s.playhead);
  return <span className="tl-readout">{timecode(playhead)}</span>;
}

export function Timeline(): React.JSX.Element {
  const project = useEditor((s) => s.project);
  const pxPerSecond = useEditor((s) => s.pxPerSecond);
  const setZoom = useEditor((s) => s.setZoom);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const selectClip = useEditor((s) => s.selectClip);
  const dispatch = useEditor((s) => s.dispatch);
  const beginInteract = useEditor((s) => s.beginInteract);
  const endInteract = useEditor((s) => s.endInteract);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(800);
  const [dropTrackId, setDropTrackId] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setViewportWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const duration = project ? projectDuration(project) : 0;
  const contentWidth = Math.max(viewportWidth, (duration + 10) * pxPerSecond);

  /** 标尺拖动 = 走带定位 */
  const scrubFrom = (clientX: number): void => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    useEditor.getState().setPlayhead(round3(Math.max(0, x / pxPerSecond)));
  };

  const onRulerPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    useEditor.getState().setPlaying(false);
    scrubFrom(event.clientX);
  };

  const commit = (commands: Command[]): void => dispatch(commands);

  const splitAtPlayhead = (clipIdOverride?: string, atOverride?: number): void => {
    const state = useEditor.getState();
    const current = state.project;
    if (!current) return;
    const at = atOverride ?? state.playhead;

    const inside = (id: string): boolean => {
      const found = findClip(current, id);
      if (!found) return false;
      return at > found.clip.start + MIN_CLIP && at < found.clip.start + clipDuration(found.clip) - MIN_CLIP;
    };

    let clipId = clipIdOverride ?? state.selectedClipId;
    if (!clipId || !inside(clipId)) {
      clipId = null;
      for (const track of current.tracks) {
        const hit = activeClipAt(track, at);
        if (hit) {
          clipId = hit.id;
          break;
        }
      }
    }

    if (!clipId) {
      state.notify('播放头下面没有可分割的片段', 'error');
      return;
    }
    commit([{ type: 'splitClip', clipId, at: round3(at) }]);
  };

  const concatFirstVideoTrack = (): void => {
    const current = useEditor.getState().project;
    if (!current) return;
    const track = current.tracks.find((t) => t.type === 'video' && t.clips.length > 0);
    if (!track) {
      useEditor.getState().notify('没有可拼接的轨道', 'error');
      return;
    }
    commit([{ type: 'concatTrack', trackId: track.id }]);
  };

  const deleteSelected = (): void => {
    if (!selectedClipId) {
      useEditor.getState().notify('先选中一个片段', 'error');
      return;
    }
    commit([{ type: 'deleteClip', clipId: selectedClipId }]);
    selectClip(null);
  };

  // 快捷键：空格播放/暂停、S 分割、Delete 删除、左右方向键逐帧
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const state = useEditor.getState();
      const fps = state.project?.fps ?? 30;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          state.togglePlay();
          break;
        case 's':
        case 'S':
          event.preventDefault();
          splitAtPlayhead();
          break;
        case 'Delete':
        case 'Backspace':
          if (state.selectedClipId) {
            event.preventDefault();
            deleteSelected();
          }
          break;
        case 'ArrowLeft':
          event.preventDefault();
          state.setPlaying(false);
          state.setPlayhead(Math.max(0, state.playhead - 1 / fps));
          break;
        case 'ArrowRight':
          event.preventDefault();
          state.setPlaying(false);
          state.setPlayhead(state.playhead + 1 / fps);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const interval = tickInterval(pxPerSecond);
  const tickCount = Math.ceil(contentWidth / pxPerSecond / interval) + 1;

  if (!project) {
    return (
      <section className="timeline">
        <header className="panel-head">
          <h2>时间线</h2>
        </header>
        <div className="tl-empty">正在载入工程…</div>
      </section>
    );
  }

  return (
    <section className="timeline">
      <header className="panel-head">
        <h2>时间线</h2>
        <TimeReadout />
        <div className="panel-actions">
          <button type="button" onClick={concatFirstVideoTrack} title="把视频轨上的片段左对齐、首尾相接">
            拼接
          </button>
          <button type="button" onClick={() => splitAtPlayhead()} title="在播放头处一刀两段（S）">
            分割
          </button>
          <button type="button" onClick={deleteSelected} disabled={!selectedClipId} title="删除选中片段（Delete）">
            删除
          </button>
          <span className="divider" />
          <button type="button" onClick={() => setZoom(pxPerSecond / 1.4)} title="缩小">
            −
          </button>
          <button type="button" onClick={() => setZoom(pxPerSecond * 1.4)} title="放大">
            +
          </button>
          <button
            type="button"
            onClick={() => setZoom(Math.max(6, Math.min(400, (viewportWidth - 40) / Math.max(duration, 1))))}
            title="缩放到适应窗口"
          >
            适应
          </button>
        </div>
      </header>

      <div className="tl-body">
        <div className="tl-labels">
          <div className="tl-label-ruler" />
          {project.tracks.map((track) => (
            <div key={track.id} className="tl-label">
              <span className="tl-label-name">{track.id}</span>
              <span className="tl-label-type">{track.type === 'video' ? '视频' : '音频'}</span>
            </div>
          ))}
        </div>

        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-content" style={{ width: contentWidth }}>
            <div
              className="tl-ruler"
              onPointerDown={onRulerPointerDown}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubFrom(e.clientX);
              }}
            >
              {Array.from({ length: tickCount }, (_, i) => i * interval).map((seconds) => (
                <div key={seconds} className="tl-tick" style={{ left: seconds * pxPerSecond }}>
                  <span>{timecode(seconds)}</span>
                </div>
              ))}
            </div>

            {project.tracks.map((track) => (
              <div
                key={track.id}
                data-track-id={track.id}
                className={`tl-track${dropTrackId === track.id ? ' drop-active' : ''}`}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(ASSET_MIME)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                  setDropTrackId(track.id);
                }}
                onDragLeave={() => setDropTrackId((id) => (id === track.id ? null : id))}
                onDrop={(event) => {
                  const assetId = event.dataTransfer.getData(ASSET_MIME);
                  setDropTrackId(null);
                  if (!assetId) return;
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  const start = round3(Math.max(0, (event.clientX - rect.left) / pxPerSecond));
                  commit([{ type: 'addClip', trackId: track.id, assetId, start }]);
                }}
                onPointerDown={(event) => {
                  // 点空白处取消选中
                  if (event.target === event.currentTarget) selectClip(null);
                }}
              >
                {track.clips.length === 0 && <span className="tl-track-hint">把素材拖到这里</span>}
                {track.clips.map((clip) => (
                  <TimelineClip
                    key={clip.id}
                    clip={clip}
                    asset={project.assets.find((a) => a.id === clip.assetId)}
                    pxPerSecond={pxPerSecond}
                    selected={clip.id === selectedClipId}
                    snapPoints={snapPoints(project, clip.id)}
                    onSelect={selectClip}
                    onCommit={(command) => commit([command])}
                    onSplitAt={splitAtPlayhead}
                    onInteractStart={beginInteract}
                    onInteractEnd={endInteract}
                  />
                ))}
              </div>
            ))}

            <Playhead pxPerSecond={pxPerSecond} />
          </div>
        </div>
      </div>
    </section>
  );
}
