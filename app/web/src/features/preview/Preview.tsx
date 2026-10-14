import { useEffect, useMemo, useRef } from 'react';
import { activeClipAt, clipEnd, projectDuration, type Asset, type Clip, type Project, type Track } from '@ai-cut/shared';
import { mediaUrl } from '../../core/api.js';
import { useEditor } from '../../core/store.js';
import { timecode } from '../../core/format.js';

/**
 * 预览播放器。
 *
 * 「拼接」在预览里的体现：只用一个 <video>，播放头跨过片段边界时换源。
 * 所以拖拽排序之后立刻就能连着播出来，不需要先生成文件。
 * 时间以视频自身的 currentTime 为准（requestVideoFrameCallback / rAF 采样），
 * 不用 setInterval 累加，避免长时间播放后漂移。
 */

interface Resolved {
  clip: Clip;
  asset: Asset;
}

function topVisualClip(project: Project, t: number): Resolved | null {
  const videoTracks = project.tracks.filter((tr) => tr.type === 'video');
  for (let i = videoTracks.length - 1; i >= 0; i--) {
    const track = videoTracks[i] as Track;
    const clip = activeClipAt(track, t);
    if (clip) {
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (asset) return { clip, asset };
    }
  }
  return null;
}

function activeAudioClip(project: Project, t: number): Resolved | null {
  for (const track of project.tracks) {
    if (track.type !== 'audio') continue;
    const clip = activeClipAt(track, t);
    if (clip) {
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (asset) return { clip, asset };
    }
  }
  return null;
}

/**
 * 从 t 起，时间线上下一个有画面的时刻。
 * 片段之间留了空白时，播放必须跳过这段空隙，否则会停在那儿一动不动。
 * 返回 null 表示后面没有片段了 —— 该收尾了。
 */
function nextStartFrom(project: Project, t: number, excludeClipId?: string): number | null {
  let best: number | null = null;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      if (clip.start >= t - 0.001 && (best === null || clip.start < best)) best = clip.start;
    }
  }
  return best;
}

export function Preview(): React.JSX.Element {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const isPlaying = useEditor((s) => s.isPlaying);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setPlaying = useEditor((s) => s.setPlaying);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadedVideo = useRef<string | null>(null);
  const loadedAudio = useRef<string | null>(null);
  const pendingVideoSeek = useRef<number | null>(null);
  const pendingAudioSeek = useRef<number | null>(null);
  const visualRef = useRef<Resolved | null>(null);
  const projectRef = useRef<Project | null>(null);
  const totalRef = useRef(0);

  const visual = useMemo(() => (project ? topVisualClip(project, playhead) : null), [project, playhead]);
  const audio = useMemo(() => (project ? activeAudioClip(project, playhead) : null), [project, playhead]);
  const total = useMemo(() => (project ? projectDuration(project) : 0), [project]);

  visualRef.current = visual;
  projectRef.current = project;
  totalRef.current = total;

  // ── 播放头 / 片段切换 → 驱动播放器 ─────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    if (!visual) {
      if (loadedVideo.current !== null) {
        loadedVideo.current = null;
        v.pause();
        v.removeAttribute('src');
        v.load();
      }
      return;
    }

    const target = Math.max(0, visual.clip.in + (playhead - visual.clip.start));

    if (loadedVideo.current !== visual.clip.id) {
      loadedVideo.current = visual.clip.id;
      pendingVideoSeek.current = target;
      v.src = mediaUrl(visual.asset.url);
      v.load();
      if (isPlaying) void v.play().catch(() => undefined);
      return;
    }

    // 同一片段：暂停时才校正，播放中交给视频自己的时钟
    if (!isPlaying && v.readyState >= 1 && Math.abs(v.currentTime - target) > 0.04) {
      v.currentTime = target;
    }
  }, [visual, playhead, isPlaying]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a || !audio) return;
    const target = Math.max(0, audio.clip.in + (playhead - audio.clip.start));
    if (loadedAudio.current !== audio.clip.id) {
      loadedAudio.current = audio.clip.id;
      pendingAudioSeek.current = target;
      a.src = mediaUrl(audio.asset.url);
      a.load();
      if (isPlaying) void a.play().catch(() => undefined);
      return;
    }
    if (!isPlaying && a.readyState >= 1 && Math.abs(a.currentTime - target) > 0.06) {
      a.currentTime = target;
    }
  }, [audio, playhead, isPlaying]);

  // ── 播放 / 暂停 ────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    const a = audioRef.current;
    if (isPlaying) {
      if (v && v.src) void v.play().catch(() => undefined);
      if (a && a.src) void a.play().catch(() => undefined);
    } else {
      v?.pause();
      a?.pause();
    }
  }, [isPlaying, visual?.clip.id, audio?.clip.id]);

  // ── 采样循环：用真实播放进度回写播放头 ─────────────────────
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;

    const sample = (): void => {
      raf = requestAnimationFrame(sample);
      const v = videoRef.current;
      const cur = visualRef.current;
      const project = projectRef.current;
      const state = useEditor.getState();

      const advanceTo = (t: number): void => {
        const next = project ? nextStartFrom(project, t, cur?.clip.id) : null;
        if (next === null) {
          state.setPlayhead(totalRef.current);
          state.setPlaying(false);
          return;
        }
        state.setPlayhead(next);
      };

      // 播放头卡在片段之间的空白里：直接跳到下一个有画面的时刻
      if (!cur) {
        advanceTo(state.playhead);
        return;
      }
      if (!v) return;

      if (v.currentTime >= cur.clip.out - 0.03) {
        advanceTo(clipEnd(cur.clip));
        return;
      }

      state.setPlayhead(Math.max(cur.clip.start, cur.clip.start + (v.currentTime - cur.clip.in)));
    };

    raf = requestAnimationFrame(sample);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, setPlayhead, setPlaying]);

  const step = (frames: number): void => {
    setPlaying(false);
    setPlayhead(Math.max(0, playhead + frames / (project?.fps ?? 30)));
  };

  const aspect = project ? `${project.width} / ${project.height}` : '16 / 9';
  const activeLabel = visual ? visual.asset.name : null;

  return (
    <section className="preview">
      <header className="panel-head">
        <h2>预览</h2>
        <span className="panel-sub">{activeLabel ?? '播放头处没有片段'}</span>
      </header>

      <div className="preview-stage">
        <div className="preview-frame" style={{ aspectRatio: aspect }}>
          <video
            ref={videoRef}
            playsInline
            preload="auto"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (pendingVideoSeek.current !== null) {
                v.currentTime = pendingVideoSeek.current;
                pendingVideoSeek.current = null;
              }
              if (useEditor.getState().isPlaying) void v.play().catch(() => undefined);
            }}
          />
          <audio
            ref={audioRef}
            preload="auto"
            onLoadedMetadata={(e) => {
              const a = e.currentTarget;
              if (pendingAudioSeek.current !== null) {
                a.currentTime = pendingAudioSeek.current;
                pendingAudioSeek.current = null;
              }
              if (useEditor.getState().isPlaying) void a.play().catch(() => undefined);
            }}
          />
          {!visual && <div className="preview-empty">把素材拖到时间线上开始</div>}
        </div>
      </div>

      <div className="transport">
        <button type="button" className="tbtn" onClick={() => setPlayhead(0)} title="回到开头">
          ⏮
        </button>
        <button type="button" className="tbtn" onClick={() => step(-1)} title="上一帧">
          ◀|
        </button>
        <button type="button" className="tbtn primary" onClick={() => setPlaying(!isPlaying)}>
          {isPlaying ? '暂停' : '播放'}
        </button>
        <button type="button" className="tbtn" onClick={() => step(1)} title="下一帧">
          |▶
        </button>
        <span className="timecode">
          {timecode(playhead)} <em>/ {timecode(total)}</em>
        </span>
      </div>
    </section>
  );
}
