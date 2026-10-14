import type { Command, CommandSource, Project } from '@ai-cut/shared';

/**
 * 类型化 API 客户端。Base URL 走环境变量，不硬编码。
 * 后端错误统一映射成 ApiError，调用方只管展示 message。
 */

const RAW_BASE = import.meta.env.VITE_API_BASE_URL as string | undefined;

/**
 * 开发时前端跑在 Vite(5173)、后端在 4000，所以显式指向后端；
 * 构建后由后端一起托管（同源），直接用当前 origin，这样只暴露一个地址。
 */
const FALLBACK_BASE = import.meta.env.DEV ? 'http://127.0.0.1:4000' : window.location.origin;

export const API_BASE = (RAW_BASE ?? FALLBACK_BASE).replace(/\/+$/, '');

/** 素材相对路径 → 可直接喂给 <video src> 的绝对地址 */
export const mediaUrl = (relative: string): string => `${API_BASE}${relative}`;

const FALLBACK_MESSAGE: Record<number, string> = {
  400: '请求参数有问题',
  404: '请求的资源不存在',
  413: '文件太大，超出上传上限',
  415: '不支持这种文件格式',
  422: '这个操作不被允许',
  429: '操作太频繁，稍后再试',
  500: '后端出错了，稍后重试',
  503: '后端暂时不可用',
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; requestId?: string };
}

const RETRYABLE_STATUS = (s: number): boolean => s >= 500 && s < 600;

async function parseError(res: Response): Promise<ApiError> {
  let body: ErrorBody | null = null;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    body = null;
  }
  const code = body?.error?.code ?? `HTTP_${res.status}`;
  const message = body?.error?.message ?? FALLBACK_MESSAGE[res.status] ?? `请求失败（${res.status}）`;
  return new ApiError(res.status, code, message, body?.error?.requestId ?? null);
}

/**
 * 只对「读」操作做重试。写操作（POST /api/commands）绝不自动重试 ——
 * addClip 这类命令不是幂等的，重试会凭空多出一个片段。
 */
async function requestGet<T>(path: string, attempts = 3): Promise<T> {
  let lastError: ApiError | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } });
      if (res.ok) return (await res.json()) as T;
      lastError = await parseError(res);
      if (!RETRYABLE_STATUS(res.status)) throw lastError;
    } catch (err) {
      if (err instanceof ApiError && !RETRYABLE_STATUS(err.status)) throw err;
      lastError = new ApiError(0, 'NETWORK_ERROR', '连不上后端服务，请确认它已启动');
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250 * 2 ** i));
  }
  throw lastError ?? new ApiError(0, 'UNKNOWN', '请求失败');
}

async function requestPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'OFFLINE', '连不上后端服务，改动未保存');
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export interface CommandBatch {
  project: Project;
  applied: number;
}

export interface ImportResult {
  project: Project;
  imported: number;
  scanned: number;
  skipped: number;
  /** 分组名 → 文件数 */
  groups: Record<string, number>;
  failed: Array<{ path: string; reason: string }>;
}

export const api = {
  getProject: (): Promise<{ project: Project }> => requestGet<{ project: Project }>('/api/project'),

  /** 允许按路径导入的根目录白名单 */
  importRoots: (): Promise<{ roots: string[] }> => requestGet<{ roots: string[] }>('/api/import-roots'),

  /**
   * 按路径原地导入磁盘上已有的素材。不复制文件，按第一层文件夹名自动分组。
   * 重复调用同一个目录是安全的：已导入过的源文件会被跳过。
   */
  importPath: (root: string, groups?: string[]): Promise<ImportResult> =>
    requestPost<ImportResult>('/api/assets/import', {
      root,
      groupBy: 'parentFolder',
      ...(groups && groups.length > 0 ? { groups } : {}),
    }),

  postCommands: (commands: Command[], source: CommandSource, clientId: string): Promise<CommandBatch> =>
    requestPost<CommandBatch>('/api/commands', { commands, source, clientId }),

  /**
   * 上传用 XHR 而不是 fetch —— 只有 XHR 能拿到上传进度，
   * 大文件没有进度条是不可接受的体验。
   */
  uploadAsset: (
    file: File,
    onProgress: (ratio: number) => void,
  ): Promise<{ project: Project }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/api/assets`);
      xhr.responseType = 'json';

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(1);
          resolve(xhr.response as { project: Project });
          return;
        }
        const body = xhr.response as ErrorBody | null;
        reject(
          new ApiError(
            xhr.status,
            body?.error?.code ?? `HTTP_${xhr.status}`,
            body?.error?.message ?? FALLBACK_MESSAGE[xhr.status] ?? '上传失败',
            body?.error?.requestId ?? null,
          ),
        );
      };

      xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', '上传中断，请检查后端服务'));
      xhr.onabort = () => reject(new ApiError(0, 'ABORTED', '上传已取消'));

      const form = new FormData();
      form.append('file', file, file.name);
      xhr.send(form);
    }),

  /** SSE 地址。EventSource 只能 GET，所以 CORS 由后端在 SSE 响应头里单独处理。 */
  eventsUrl: (): string => `${API_BASE}/api/events`,
};
