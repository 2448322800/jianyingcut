import { useEffect } from 'react';
import { API_BASE } from './api.js';
import { useEditor, type ServerEvent } from './store.js';

/**
 * SSE 订阅：接收服务端广播的工程状态。
 * AI 在服务端发的命令、其它标签页的改动，都从这里流进来，
 * 前端不需要为「谁改的」做任何区别处理。
 * 断线自动重连，指数退避，最长 10 秒一次。
 */
export function useProjectSync(): void {
  const setConnection = useEditor((s) => s.setConnection);
  const applyServerEvent = useEditor((s) => s.applyServerEvent);
  const load = useEditor((s) => s.load);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry = 0;
    let timer: number | undefined;
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      setConnection('connecting');
      source = new EventSource(`${API_BASE}/api/events`);

      source.onopen = () => {
        retry = 0;
        setConnection('open');
      };

      source.addEventListener('project', (event) => {
        try {
          applyServerEvent(JSON.parse((event as MessageEvent<string>).data) as ServerEvent);
        } catch {
          // 单条脏数据不该打断整个连接，忽略
        }
      });

      source.onerror = () => {
        setConnection('closed');
        source?.close();
        source = null;
        if (disposed) return;
        const delay = Math.min(10_000, 500 * 2 ** retry);
        retry += 1;
        timer = window.setTimeout(connect, delay);
      };
    };

    // 首屏先直接拉一次，避免等 SSE 握手造成的空白
    void load();
    connect();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      source?.close();
      source = null;
    };
  }, [setConnection, applyServerEvent, load]);
}
