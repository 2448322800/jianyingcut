import { create } from 'zustand';
import {
  applyCommands,
  describeCommand,
  type Command,
  type CommandSource,
  type Project,
} from '@ai-cut/shared';
import { ApiError, api } from './api.js';

/**
 * 编辑器状态树 + 命令总线。
 *
 * 同步策略（这是本项目的核心）：
 *  - 本地状态是 UI 真源，拖拽因此永远跟手（乐观更新）。
 *  - 每条命令同时 POST 给后端，后端是持久化真源，并把它广播给所有客户端。
 *  - 收到广播时，若本地正在交互或有请求在飞，先攒着（pendingRemote），
 *    等空闲了再一次性对齐，避免把用户的当前操作冲掉。
 *  - AI 在服务端发的命令走的是完全相同的广播通道，所以前端不需要为 AI 做任何特殊处理。
 */

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface LogEntry {
  id: string;
  at: number;
  source: CommandSource;
  text: string;
  ok: boolean;
}

export interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'error';
}

export interface UploadTask {
  id: string;
  name: string;
  ratio: number;
  status: 'uploading' | 'done' | 'error';
  message?: string;
}

/** 服务端经 SSE 推来的变更事件 */
export interface ServerEvent {
  type: 'project';
  rev: number;
  project: Project;
  originId: string | null;
  commands: Command[];
  source: CommandSource;
}

interface EditorState {
  project: Project | null;
  clientId: string;
  selectedClipId: string | null;
  playhead: number;
  isPlaying: boolean;
  pxPerSecond: number;
  connection: ConnectionState;

  /** 拖拽中：暂停接受远端状态，避免手正在动的时候被覆盖 */
  isInteracting: boolean;
  /** 待对齐的服务端状态 */
  pendingRemote: Project | null;
  /** 本地已发出、尚未返回的写请求数 */
  inflight: number;

  log: LogEntry[];
  toast: Toast | null;
  uploads: UploadTask[];

  load: () => Promise<void>;
  dispatch: (commands: Command[], opts?: { source?: CommandSource; silent?: boolean }) => void;
  applyServerEvent: (event: ServerEvent) => void;
  applyServerProject: (project: Project) => void;
  flushRemote: () => void;

  setConnection: (c: ConnectionState) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;
  togglePlay: () => void;
  selectClip: (id: string | null) => void;
  setZoom: (pxPerSecond: number) => void;
  beginInteract: () => void;
  endInteract: () => void;

  addUpload: (file: File) => void;
  importFromPath: (root: string) => Promise<void>;
  clearLog: () => void;
  notify: (message: string, tone?: 'ok' | 'error') => void;
  dismissToast: () => void;
}

const uid = (): string => globalThis.crypto.randomUUID();

const pushLog = (log: LogEntry[], entries: LogEntry[]): LogEntry[] => [...log, ...entries].slice(-300);

export const useEditor = create<EditorState>()((set, get) => ({
  project: null,
  clientId: uid(),
  selectedClipId: null,
  playhead: 0,
  isPlaying: false,
  pxPerSecond: 60,
  connection: 'connecting',

  isInteracting: false,
  pendingRemote: null,
  inflight: 0,

  log: [],
  toast: null,
  uploads: [],

  load: async () => {
    try {
      const { project } = await api.getProject();
      set((s) => (s.project && s.project.rev > project.rev ? {} : { project }));
    } catch (err) {
      get().notify(err instanceof ApiError ? err.message : '载入工程失败', 'error');
    }
  },

  dispatch: (commands, opts) => {
    const state = get();
    const project = state.project;
    if (!project || commands.length === 0) return;

    const source: CommandSource = opts?.source ?? 'user';

    // 先在本地跑一遍同一个 reducer —— 与后端跑的是同一份代码，结果必然一致
    let next: Project;
    try {
      next = applyCommands(project, commands);
    } catch (err) {
      get().notify(err instanceof Error ? err.message : '操作不合法', 'error');
      return;
    }

    if (!opts?.silent) {
      set((s) => ({
        project: next,
        log: pushLog(
          s.log,
          commands.map((c) => ({ id: uid(), at: Date.now(), source, text: describeCommand(c), ok: true })),
        ),
      }));
    } else {
      set({ project: next });
    }

    set((s) => ({ inflight: s.inflight + 1 }));
    void api
      .postCommands(commands, source, state.clientId)
      .then((res) => {
        get().applyServerProject(res.project);
      })
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? err.message : '保存失败';
        set((s) => ({
          log: pushLog(
            s.log,
            commands.map((c) => ({
              id: uid(),
              at: Date.now(),
              source,
              text: `${describeCommand(c)} · 未保存`,
              ok: false,
            })),
          ),
        }));
        get().notify(`改动未保存：${message}`, 'error');
        // 用服务端权威状态回滚本地乐观改动
        void get().load();
      })
      .finally(() => {
        set((s) => ({ inflight: Math.max(0, s.inflight - 1) }));
        get().flushRemote();
      });
  },

  /**
   * SSE 事件入口。除了对齐工程状态，还把「别人（或 AI）下的命令」记进命令流，
   * 这样页面上能直接看到 AI 到底动了什么 —— 这是命令层可审计的地方。
   */
  applyServerEvent: (event) => {
    const self = get();
    if (event.commands.length > 0 && event.originId !== self.clientId) {
      set((s) => ({
        log: pushLog(
          s.log,
          event.commands.map((c) => ({
            id: uid(),
            at: Date.now(),
            source: event.source,
            text: `远端 · ${describeCommand(c)}`,
            ok: true,
          })),
        ),
      }));
    }
    get().applyServerProject(event.project);
  },

  applyServerProject: (project) => {
    const s = get();
    if (s.isInteracting || s.inflight > 0) {
      // 手正在动 / 请求在飞，先攒着
      if (!s.pendingRemote || project.rev > s.pendingRemote.rev) set({ pendingRemote: project });
      return;
    }
    if (!s.project || project.rev > s.project.rev) {
      set({ project, pendingRemote: null });
    }
  },

  flushRemote: () => {
    const s = get();
    if (s.isInteracting || s.inflight > 0 || !s.pendingRemote) return;
    if (!s.project || s.pendingRemote.rev > s.project.rev) {
      set({ project: s.pendingRemote, pendingRemote: null });
    } else {
      set({ pendingRemote: null });
    }
  },

  setConnection: (connection) => set({ connection }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  selectClip: (selectedClipId) => set({ selectedClipId }),
  setZoom: (pxPerSecond) => set({ pxPerSecond: Math.min(400, Math.max(6, pxPerSecond)) }),

  beginInteract: () => set({ isInteracting: true }),
  endInteract: () => {
    set({ isInteracting: false });
    get().flushRemote();
  },

  addUpload: (file) => {
    const id = uid();
    set((s) => ({ uploads: [...s.uploads, { id, name: file.name, ratio: 0, status: 'uploading' }] }));

    void api
      .uploadAsset(file, (ratio) => {
        set((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ratio } : u)) }));
      })
      .then((res) => {
        set((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, status: 'done', ratio: 1 } : u)) }));
        get().applyServerProject(res.project);
        get().notify(`已导入 ${file.name}`, 'ok');
      })
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? err.message : '上传失败';
        set((s) => ({
          uploads: s.uploads.map((u) => (u.id === id ? { ...u, status: 'error', message } : u)),
        }));
        get().notify(`${file.name} 导入失败：${message}`, 'error');
      })
      .finally(() => {
        // 3 秒后自动清掉已完成的条目，失败条目保留给用户看
        setTimeout(() => {
          set((s) => ({ uploads: s.uploads.filter((u) => u.id !== id || u.status === 'error') }));
        }, 3000);
      });
  },

  /**
   * 按路径导入磁盘上已有工程的素材（漫剧那套片段走这条路）。
   * 不复制文件，按第一层文件夹名自动分组。重复调用同一目录是安全的。
   */
  importFromPath: async (root) => {
    try {
      const res = await api.importPath(root);
      get().applyServerProject(res.project);

      const groupCount = Object.keys(res.groups).length;
      if (res.imported === 0 && res.skipped > 0) {
        get().notify(`这里 ${res.skipped} 个素材之前已经导入过了`, 'ok');
      } else if (res.imported === 0) {
        get().notify('这个目录里没有找到音视频文件', 'error');
      } else {
        const parts = [`已导入 ${res.imported} 个素材`];
        if (groupCount > 0) parts.push(`分 ${groupCount} 组`);
        if (res.failed.length > 0) parts.push(`${res.failed.length} 个探测失败`);
        get().notify(parts.join('，'), res.failed.length > 0 ? 'error' : 'ok');
      }
    } catch (err) {
      get().notify(err instanceof ApiError ? err.message : '导入失败', 'error');
    }
  },

  clearLog: () => set({ log: [] }),

  notify: (message, tone = 'error') => set({ toast: { id: Date.now(), message, tone } }),
  dismissToast: () => set({ toast: null }),
}));
