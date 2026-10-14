import { useEffect, useState } from 'react';
import { projectDuration } from '@ai-cut/shared';
import { API_BASE, ApiError, api } from './core/api.js';
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

/** 点过「关闭程序」之后停留的落地页 —— 服务已经没了，所以只给一句「怎么再打开」。 */
function ClosedScreen(): React.JSX.Element {
  return (
    <div className="closed-screen">
      <h2>剪辑台已关闭</h2>
      <p>工程状态是每条命令实时落盘的，时间线内容不会丢。</p>
      <p>
        要再次打开：双击项目里的「启动剪映Cut.command」，
        或点漫剧工作台顶栏的「剪辑台」。
      </p>
    </div>
  );
}

export function App(): React.JSX.Element {
  useProjectSync();

  const project = useEditor((s) => s.project);
  const connection = useEditor((s) => s.connection);
  const notify = useEditor((s) => s.notify);
  const importFromPath = useEditor((s) => s.importFromPath);

  // 关闭程序是两步：先点按钮，再确认。确认后服务会真的退出，所以要有这个「刹车」。
  const [askClose, setAskClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState(false);

  async function handleShutdown(): Promise<void> {
    setClosing(true);
    try {
      await api.shutdown();
      setClosed(true);
    } catch (err) {
      // 失败（比如后端已经不在了）就退回原状，别把页面卡在「正在关闭…」
      setClosing(false);
      setAskClose(false);
      notify(err instanceof ApiError ? err.message : '关闭失败', 'error');
    }
  }

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

  // 服务已经关掉了，再渲染编辑器也没意义（SSE 已断，任何操作都会失败）
  if (closed) return <ClosedScreen />;

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
          {askClose ? (
            <>
              <span className="close-ask">关闭剪辑台？</span>
              <button
                type="button"
                className="danger"
                onClick={() => void handleShutdown()}
                disabled={closing}
              >
                {closing ? '正在关闭…' : '确认关闭'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => setAskClose(false)}
                disabled={closing}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="ghost"
              onClick={() => setAskClose(true)}
              title="关掉剪辑台的服务进程（时间线实时落盘，不会丢）"
            >
              关闭程序
            </button>
          )}
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
