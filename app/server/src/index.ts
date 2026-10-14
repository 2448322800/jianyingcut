import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { env } from './config/env.js';
import { normalizeError } from './shared/errors.js';
import { logger, reqLogger } from './shared/logger.js';
import { mediaRoutes } from './media/routes.js';
import { projectRepo } from './project/repo.js';
import { projectRoutes } from './project/routes.js';

let server: FastifyInstance | null = null;

async function build(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // 用自己的结构化 JSON logger，保证每条日志都带 requestId
    bodyLimit: 1024 * 1024,
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      if (typeof header === 'string' && header.length > 0 && header.length <= 64) return header;
      return globalThis.crypto.randomUUID();
    },
  });

  // CORS 使用显式来源白名单，绝不用通配符
  await app.register(cors, {
    origin: env.corsOrigins,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Request-Id'],
    maxAge: 86_400,
  });

  await app.register(multipart, {
    limits: { fileSize: env.maxUploadBytes, files: 1, fields: 10 },
  });

  // 素材静态托管。必须先建目录，否则 static 插件注册就报错。
  await mkdir(env.mediaDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: env.mediaDir,
    prefix: '/media/',
    index: false,
    cacheControl: true,
    maxAge: '1h',
  });

  // 原地导入的素材：每个白名单根目录挂一个静态服务，前缀 /imported/<序号>/。
  // 用静态插件而不是自己写流，是为了白拿 Range 支持 —— 视频拖动进度条必须有它。
  for (let i = 0; i < env.importRoots.length; i++) {
    const root = env.importRoots[i] as string;
    const isDir = await stat(root).then((s) => s.isDirectory()).catch(() => false);
    if (!isDir) {
      logger.warn('导入根目录不存在，已跳过', { index: i, root });
      continue;
    }
    await app.register(fastifyStatic, {
      root,
      prefix: `/imported/${i}/`,
      index: false,
      cacheControl: true,
      maxAge: '1h',
      decorateReply: false, // reply.sendFile 只能装饰一次
    });
    logger.info('已挂载导入根目录', { index: i, root, prefix: `/imported/${i}/` });
  }

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  // ── 健康检查 ──────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    rev: projectRepo.get().rev,
  }));

  app.get('/ready', async (_req, reply) => {
    try {
      await access(env.dataDir, constants.W_OK);
      await access(env.mediaDir, constants.W_OK);
    } catch {
      return reply.status(503).send({ status: 'not_ready', reason: '存储目录不可写' });
    }
    return { status: 'ready', rev: projectRepo.get().rev };
  });

  // ── 前端静态产物（可选）──────────────────────────────────
  // 跑过一次 `npm run build` 之后，后端把 web/dist 一起托管掉。
  // 这样对外只需要「一个进程 + 一个端口 + 一个地址」，被别的系统当外部平台调用时省事得多。
  const webDist = path.join(env.repoRoot, 'web', 'dist');
  let webIndexHtml: string | null = null;
  try {
    webIndexHtml = await readFile(path.join(webDist, 'index.html'), 'utf8');
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      index: ['index.html'],
      decorateReply: false,
    });
    logger.info('已挂载前端静态产物', { webDist });
  } catch {
    webIndexHtml = null;
    logger.info('未找到前端构建产物（web/dist），仅提供 API。开发时请让 Vite 单独跑起来');
  }

  // ── 全局错误处理 ──────────────────────────────────────────
  // 必须在注册路由之前设置：Fastify 的子上下文在创建时会快照父级错误处理器，
  // 放在 register 之后设置，路由就会继续用默认处理器（表现为 500 + 默认错误体）。
  app.setNotFoundHandler((req, reply) => {
    // 前端是 SPA：非 API 路径一律回 index.html，交给前端路由处理
    const isApiish =
      req.url.startsWith('/api/') || req.url.startsWith('/media/') || req.url.startsWith('/imported/');
    if (webIndexHtml !== null && req.method === 'GET' && !isApiish) {
      return reply.type('text/html; charset=utf-8').send(webIndexHtml);
    }
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `接口不存在：${req.method} ${req.url}`, requestId: req.id },
    });
  });

  app.setErrorHandler((err, req, reply) => {
    const norm = normalizeError(err);
    const log = reqLogger(req);
    if (norm.statusCode >= 500) {
      log.error('请求处理失败', {
        code: norm.code,
        statusCode: norm.statusCode,
        message: (err as Error).message,
        stack: (err as Error).stack,
      });
    } else {
      log.warn('请求被拒绝', { code: norm.code, statusCode: norm.statusCode, message: norm.message });
    }

    const body: Record<string, unknown> = {
      error: { code: norm.code, message: norm.message, requestId: req.id },
    };
    if (norm.details !== undefined) {
      (body.error as Record<string, unknown>).details = norm.details;
    }
    reply.status(norm.statusCode).send(body);
  });

  await app.register(projectRoutes);
  await app.register(mediaRoutes);

  return app;
}

async function main(): Promise<void> {
  await projectRepo.init();
  server = await build();
  await server.listen({ host: env.host, port: env.port });

  logger.info('服务已启动', {
    url: `http://${env.host}:${env.port}`,
    env: env.nodeEnv,
    corsOrigins: env.corsOrigins,
    mediaDir: env.mediaDir,
  });
}

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  logger.info('收到退出信号，开始优雅停机', { signal });

  // 兜底：10 秒还没关完就强退，避免进程挂死
  const force = setTimeout(() => {
    logger.error('停机超时，强制退出');
    process.exit(1);
  }, 10_000);
  force.unref();

  try {
    await server?.close();
    await projectRepo.flush();
    logger.info('停机完成');
    process.exit(0);
  } catch (err) {
    logger.error('停机过程出错', { message: (err as Error).message });
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise rejection', { message: String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.fatal('未捕获异常', { message: err.message, stack: err.stack });
  void shutdown('uncaughtException');
});

main().catch((err: unknown) => {
  logger.fatal('启动失败', { message: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
