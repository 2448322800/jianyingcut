import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Command } from '@ai-cut/shared';
import { env } from '../config/env.js';
import { BadRequestError } from '../shared/errors.js';
import { logger, reqLogger } from '../shared/logger.js';
import { eventHub, type ProjectEvent } from './events.js';
import { projectRepo } from './repo.js';
import { runCommands } from './service.js';

/**
 * 控制器层：解析请求 → 调用服务 → 格式化响应。这里不写业务逻辑。
 */

const CommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('addClip'),
    trackId: z.string().min(1).max(64),
    assetId: z.string().min(1).max(64),
    start: z.number().min(0),
    in: z.number().min(0).optional(),
    out: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal('moveClip'),
    clipId: z.string().min(1).max(64),
    start: z.number().min(0),
    trackId: z.string().min(1).max(64).optional(),
  }),
  z.object({
    type: z.literal('trimClip'),
    clipId: z.string().min(1).max(64),
    in: z.number().min(0).optional(),
    out: z.number().min(0).optional(),
    start: z.number().min(0).optional(),
  }),
  z.object({
    type: z.literal('splitClip'),
    clipId: z.string().min(1).max(64),
    at: z.number().min(0),
  }),
  z.object({ type: z.literal('deleteClip'), clipId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('concatTrack'), trackId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('clearTrack'), trackId: z.string().min(1).max(64) }),
]);

const CommandsBodySchema = z.object({
  commands: z.array(CommandSchema).min(1).max(500),
  /** 外部调用者（AI）不声明身份时按 ai 记账 */
  source: z.enum(['user', 'ai', 'system']).default('ai'),
  clientId: z.string().max(64).nullish(),
});

/** SSE 必须手动处理 CORS —— reply.hijack() 之后插件设的响应头不会生效 */
function allowedOrigin(req: FastifyRequest): string {
  const origin = req.headers.origin;
  if (origin && env.corsOrigins.includes(origin)) return origin;
  return env.corsOrigins[0] ?? 'null';
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/project', async () => ({ project: projectRepo.get() }));

  app.post('/api/commands', async (req) => {
    const parsed = CommandsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(
        '命令格式不合法',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const { commands, source, clientId } = parsed.data;
    const result = runCommands(commands as Command[], source, clientId ?? null);
    reqLogger(req).info('POST /api/commands', {
      source,
      clientId: clientId ?? null,
      count: result.applied,
      rev: result.project.rev,
    });

    return { project: result.project, applied: result.applied };
  });

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': allowedOrigin(req),
      Vary: 'Origin',
    });

    const write = (event: ProjectEvent): void => {
      reply.raw.write(`event: project\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // 连上先推一次当前状态，客户端不用额外拉一次
    const current = projectRepo.get();
    write({ type: 'project', rev: current.rev, project: current, originId: null, commands: [], source: 'system' });

    const unsubscribe = eventHub.subscribe(write);
    const heartbeat = setInterval(() => {
      // 心跳，防止中间层掐掉空闲连接
      reply.raw.write(': ping\n\n');
    }, 20_000);

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        // 连接已经没了，忽略
      }
      logger.debug('SSE 连接关闭', { subscribers: eventHub.size });
    };

    req.raw.on('close', close);
    req.raw.on('error', close);
    logger.debug('SSE 连接建立', { subscribers: eventHub.size });
  });
}
