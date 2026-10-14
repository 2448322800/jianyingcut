import { DomainError } from '@ai-cut/shared';

/**
 * 类型化错误体系。
 * 客户端只会看到 { error: { code, message, requestId } }，
 * 永远拿不到堆栈、文件路径或内部实现细节。
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** 可以安全暴露给客户端的补充信息 */
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, details?: unknown) {
    super(403, 'FORBIDDEN', message, details);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

export class UnsupportedMediaError extends AppError {
  constructor(message: string) {
    super(415, 'UNSUPPORTED_MEDIA_TYPE', message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, 'VALIDATION_FAILED', message, details);
  }
}

export interface NormalizedError {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

/** 把任意抛出物归一化成对外错误结构 */
export function normalizeError(err: unknown): NormalizedError {
  if (err instanceof DomainError) {
    // 领域规则不满足 —— 用户输入问题，不是服务器故障
    return { statusCode: 422, code: err.code, message: err.message };
  }
  if (err instanceof AppError) {
    const out: NormalizedError = { statusCode: err.statusCode, code: err.code, message: err.message };
    if (err.details !== undefined) out.details = err.details;
    return out;
  }

  // Fastify / 插件抛出的框架级错误（如上传超限）自带 statusCode
  const framework = err as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (typeof framework.statusCode === 'number' && framework.statusCode >= 400 && framework.statusCode < 500) {
    return {
      statusCode: framework.statusCode,
      code: typeof framework.code === 'string' ? framework.code : 'REQUEST_ERROR',
      message: typeof framework.message === 'string' ? framework.message : '请求不合法',
    };
  }

  return { statusCode: 500, code: 'INTERNAL_ERROR', message: '服务器内部错误' };
}
