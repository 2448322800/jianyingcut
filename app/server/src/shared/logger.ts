import { env } from '../config/env.js';
import type { FastifyRequest } from 'fastify';

/**
 * 结构化 JSON 日志。
 * 每条一行 JSON，带 requestId，方便 grep / 采集。
 * 绝不记录请求体（可能含素材内容）与任何密钥。
 */

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const RANK: Record<Level, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

const threshold = RANK[env.logLevel];

export type LogFields = Record<string, unknown>;

function emit(level: Level, msg: string, bindings: LogFields, fields?: LogFields): void {
  if (RANK[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...bindings,
    ...fields,
  });
  if (level === 'fatal' || level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  fatal(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

function makeLogger(bindings: LogFields): Logger {
  return {
    fatal: (msg, f) => emit('fatal', msg, bindings, f),
    error: (msg, f) => emit('error', msg, bindings, f),
    warn: (msg, f) => emit('warn', msg, bindings, f),
    info: (msg, f) => emit('info', msg, bindings, f),
    debug: (msg, f) => emit('debug', msg, bindings, f),
    child: (extra) => makeLogger({ ...bindings, ...extra }),
  };
}

export const logger = makeLogger({});

/** 取请求级 logger，自动带上 requestId 与路由信息 */
export function reqLogger(req: FastifyRequest): Logger {
  return logger.child({
    requestId: req.id,
    method: req.method,
    url: req.url,
  });
}
