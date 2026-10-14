import { useEffect, useRef, useState } from 'react';
import type { Command, CommandSource } from '@ai-cut/shared';
import { useEditor } from '../../core/store.js';

/**
 * 命令台：命令流的可视日志 + 手工下发命令的入口。
 *
 * 这个面板的意义是「证明命令层真的通了」——
 * 鼠标拖出来的命令和这里手写的命令，走的是完全相同的路径。
 * M3 的自然语言 → 命令解析器接上之后，这里就是它的输入框。
 */

const PRESETS: Array<{ label: string; make: () => Command[] | null }> = [
  {
    label: '拼接主视频轨',
    make: () => {
      const project = useEditor.getState().project;
      const track = project?.tracks.find((t) => t.type === 'video' && t.clips.length > 0);
      return track ? [{ type: 'concatTrack', trackId: track.id }] : null;
    },
  },
  {
    label: '清空主视频轨',
    make: () => {
      const project = useEditor.getState().project;
      const track = project?.tracks.find((t) => t.type === 'video');
      return track ? [{ type: 'clearTrack', trackId: track.id }] : null;
    },
  },
  {
    label: '播放头处分割',
    make: () => {
      const state = useEditor.getState();
      const project = state.project;
      if (!project || !state.selectedClipId) return null;
      return [{ type: 'splitClip', clipId: state.selectedClipId, at: Math.round(state.playhead * 1000) / 1000 }];
    },
  },
];

export function CommandConsole(): React.JSX.Element {
  const log = useEditor((s) => s.log);
  const dispatch = useEditor((s) => s.dispatch);
  const clearLog = useEditor((s) => s.clearLog);
  const notify = useEditor((s) => s.notify);

  const [text, setText] = useState('');
  const [source, setSource] = useState<CommandSource>('ai');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [log.length]);

  const run = (commands: Command[]): void => {
    if (commands.length === 0) return;
    dispatch(commands, { source });
  };

  const submit = (): void => {
    const raw = text.trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      notify(`JSON 解析失败：${(err as Error).message}`, 'error');
      return;
    }
    const commands = (Array.isArray(parsed) ? parsed : [parsed]) as Command[];
    run(commands);
    setText('');
  };

  return (
    <div className="console">
      <div className="console-head">
        <span className="console-title">命令台</span>
        <span className="console-count">{log.length}</span>
        <button type="button" onClick={clearLog} disabled={log.length === 0}>
          清空
        </button>
      </div>

      <div className="console-log" ref={logRef}>
        {log.length === 0 && <span className="console-empty">操作一次就会出现在这里 —— 鼠标和 AI 走的是同一条命令通道</span>}
        {log.map((entry) => (
          <span key={entry.id} className={`chip ${entry.source}${entry.ok ? '' : ' failed'}`} title={new Date(entry.at).toLocaleTimeString()}>
            {entry.text}
          </span>
        ))}
      </div>

      <div className="console-input">
        <select value={source} onChange={(e) => setSource(e.target.value as CommandSource)} title="命令来源标记，仅用于审计与高亮">
          <option value="ai">AI</option>
          <option value="user">用户</option>
          <option value="system">系统</option>
        </select>
        <input
          type="text"
          value={text}
          placeholder='命令 JSON，例如 {"type":"concatTrack","trackId":"V1"}'
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <button type="button" className="primary" onClick={submit} disabled={!text.trim()}>
          执行
        </button>
      </div>

      <div className="console-presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => {
              const commands = preset.make();
              if (!commands) {
                notify('当前工程状态不支持这个预设命令', 'error');
                return;
              }
              run(commands);
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}
