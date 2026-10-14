import { useEffect, useState } from 'react';
import { clipDuration, findClip, round3 } from '@ai-cut/shared';
import { useEditor } from '../../core/store.js';
import { humanDuration, timecode } from '../../core/format.js';

/**
 * 属性面板：选中片段的精确数值编辑。
 * 拖拽负责手感，这里负责精确 —— 两者最终都落到同一条命令上。
 */

function NumberField({
  label,
  value,
  step = 0.1,
  min = 0,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  onCommit: (next: number) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value.toFixed(2));

  useEffect(() => {
    setDraft(value.toFixed(2));
  }, [value]);

  const commit = (): void => {
    const parsed = Number.parseFloat(draft);
    if (!Number.isFinite(parsed) || parsed === value) {
      setDraft(value.toFixed(2));
      return;
    }
    onCommit(round3(Math.max(min, parsed)));
  };

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(value.toFixed(2));
        }}
      />
    </label>
  );
}

export function Inspector(): React.JSX.Element {
  const project = useEditor((s) => s.project);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const playhead = useEditor((s) => s.playhead);
  const dispatch = useEditor((s) => s.dispatch);
  const setPlayhead = useEditor((s) => s.setPlayhead);

  const found = project && selectedClipId ? findClip(project, selectedClipId) : null;
  const asset = found && project ? project.assets.find((a) => a.id === found.clip.assetId) : undefined;

  if (!project) return <aside className="inspector" />;

  if (!found || !asset) {
    return (
      <aside className="inspector">
        <header className="panel-head">
          <h2>属性</h2>
        </header>
        <div className="inspector-empty">
          <p>未选中片段</p>
          <ul>
            <li>拖动片段改位置</li>
            <li>拖边缘改时长</li>
            <li>S 键在播放头处分割</li>
            <li>双击片段就地分割</li>
          </ul>
        </div>
        <div className="inspector-block">
          <div className="kv">
            <span>工程</span>
            <b>{project.name}</b>
          </div>
          <div className="kv">
            <span>分辨率</span>
            <b>
              {project.width}×{project.height} @ {project.fps}fps
            </b>
          </div>
          <div className="kv">
            <span>修订号</span>
            <b>rev {project.rev}</b>
          </div>
        </div>
      </aside>
    );
  }

  const { clip, track } = found;
  const duration = clipDuration(clip);

  return (
    <aside className="inspector">
      <header className="panel-head">
        <h2>属性</h2>
        <span className="panel-sub">{track.id}</span>
      </header>

      <div className="inspector-block">
        <div className="kv">
          <span>素材</span>
          <b title={asset.name}>{asset.name}</b>
        </div>
        <div className="kv">
          <span>时长</span>
          <b>{humanDuration(duration)}</b>
        </div>
        <div className="kv">
          <span>区间</span>
          <b>
            {timecode(clip.start)} → {timecode(clip.start + duration)}
          </b>
        </div>
      </div>

      <div className="inspector-block">
        <h3>时间</h3>
        <NumberField
          label="起点"
          value={clip.start}
          onCommit={(start) => dispatch([{ type: 'moveClip', clipId: clip.id, start }])}
        />
        <NumberField
          label="入点"
          value={clip.in}
          onCommit={(value) => dispatch([{ type: 'trimClip', clipId: clip.id, in: value }])}
        />
        <NumberField
          label="出点"
          value={clip.out}
          onCommit={(value) => dispatch([{ type: 'trimClip', clipId: clip.id, out: value }])}
        />
      </div>

      <div className="inspector-block">
        <h3>配合播放头</h3>
        <button
          type="button"
          onClick={() => dispatch([{ type: 'trimClip', clipId: clip.id, in: round3(playhead), start: round3(playhead) }])}
          disabled={playhead <= clip.in || playhead >= clip.out}
        >
          把入点移到播放头
        </button>
        <button
          type="button"
          onClick={() => dispatch([{ type: 'trimClip', clipId: clip.id, out: round3(playhead) }])}
          disabled={playhead <= clip.start + 0.1 || playhead >= clip.start + duration}
        >
          把出点移到播放头
        </button>
        <button type="button" onClick={() => setPlayhead(clip.start)}>
          播放头跳到片段开头
        </button>
      </div>

      <div className="inspector-block">
        <button
          type="button"
          className="danger"
          onClick={() => dispatch([{ type: 'deleteClip', clipId: clip.id }])}
        >
          删除这个片段
        </button>
      </div>
    </aside>
  );
}
