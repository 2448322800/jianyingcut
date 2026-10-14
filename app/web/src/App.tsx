import { useEffect } from 'react';
import { projectDuration } from '@ai-cut/shared';
import { API_BASE } from './core/api.js';
import { useEditor } from './core/store.js';
import { useProjectSync } from './core/useProjectSync.js';
import { humanDuration } from './core/format.js';
import { MediaPanel } from './features/media/MediaPanel.js';
import { Preview } from './features/preview/Preview.js';
import { Inspector } from './features/inspector/Inspector.js';
import { Timeline } from './features/timeline/Timeline.js';
import { CommandConsole } from './features/console/CommandConsole.js';

const CONNECTION_LABEL = {
  connecting: '连接中',
  open: '已连接',
  closed: '已断开',
} as const;

function Toast(): React.JSX.Element | null {
  const toast = useEditor((s) => s.toast);
  const dismiss = useEditor((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(dismiss, toast.tone === 'error' ? 5000 : 2500);
    return () => window.clearTimeout(timer);
  }, [toast, dismiss]);

  if (!toast) return null;
  return (
    <div className={`toast ${toast.tone}`} role="status" onClick={dismiss}>
      {toast.message}
    </div>
  );
}

export function App(): React.JSX.Element {
  useProjectSync();

  const project = useEditor((s) => s.project);
  const connection = useEditor((s) => s.connection);
  const notify = useEditor((s) => s.notify);
  const importFromPath = useEditor((s) => s.importFromPath);

  // 一键接入：外部系统用 ?import=<目录绝对路径> 拉起本页，自动把该目录的素材导进来。
  //   http://127.0.0.1:5173/?import=%2Fpath%2Fto%2F02_%E6%95%B0%E6%8D%AE%2F05_%E8%A7%86%E9%A2%91%E7%89%87%E6%AE%B5
  // 参数用掉就清掉，刷新页面不会重复导入（导入接口本身也是幂等的，双保险）。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const target = params.get('import');
    if (!target) return;

    params.delete('import');
    const rest = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
    void importFromPath(target);
  }, [importFromPath]);

  const total = project ? projectDuration(project) : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <b>剪映Cut</b>
        </div>
        <div className="topbar-meta">
          <span>{project?.name ?? '—'}</span>
          <span className="sep" />
          <span>
            {project ? `${project.width}×${project.height} @ ${project.fps}fps` : '—'}
          </span>
          <span className="sep" />
          <span>总时长 {humanDuration(total)}</span>
        </div>
        <div className="topbar-right">
          <span className={`conn ${connection}`}>{CONNECTION_LABEL[connection]}</span>
          <code className="api-hint" title="命令 API 地址">
            {API_BASE}
          </code>
          <button
            type="button"
            className="ghost"
            onClick={() => notify('导出功能排在 M2，本期先不做。', 'ok')}
            title="导出 MP4 —— 计划在 M2 交付"
          >
            导出 MP4
          </button>
        </div>
      </header>

      <main className="stage">
        <MediaPanel />
        <Preview />
        <Inspector />
      </main>

      <CommandConsole />

      <Timeline />

      <Toast />
    </div>
  );
}
