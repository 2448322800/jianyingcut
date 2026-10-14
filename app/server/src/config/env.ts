import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * 配置集中管理：全部来自环境变量，启动时一次性校验，格式不对直接退出。
 * 宁可起不来，也不要在运行到一半时才发现配置错了。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录：server/src/config → ../../.. ；server/dist/config → ../../.. */
export const repoRoot = path.resolve(here, '../../..');

// Node 22 内置 .env 读取，不需要 dotenv 依赖。没有 .env 就只用系统环境变量。
try {
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
  // .env 不存在属于正常情况
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** 逗号分隔的显式来源白名单。同时含开发(5173)与单端口模式(4000)两种来源。 */
  CORS_ORIGINS: z
    .string()
    .default(
      'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4000,http://127.0.0.1:4000',
    ),
  MEDIA_DIR: z.string().min(1).default('server/media'),
  DATA_DIR: z.string().min(1).default('server/data'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(2 * 1024 ** 3),
  /** 留空则用 PATH 上的 ffmpeg / ffprobe */
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  /**
   * 允许「按路径原地导入」的根目录白名单，逗号分隔。
   * 这是安全边界：`POST /api/assets/import` 能读磁盘上的任意文件，
   * 不设白名单等于开放整个文件系统。默认只放开 WorkBuddy 工作区（项目都在这儿）。
   */
  IMPORT_ROOTS: z.string().default('$HOME/WorkBuddy'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // 此时 logger 还没初始化，直接写 stderr，然后快速失败。
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  process.stderr.write(`[config] 环境变量校验失败，进程退出：\n${lines.join('\n')}\n`);
  process.exit(1);
}

const raw = parsed.data;
const corsOrigins = raw.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const home = process.env.HOME ?? '';
const expandHome = (p: string): string => (p.startsWith('$HOME') ? path.join(home, p.slice(5)) : p);

const importRoots = raw.IMPORT_ROOTS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => path.resolve(expandHome(s)));

if (raw.NODE_ENV === 'production' && (corsOrigins.length === 0 || corsOrigins.includes('*'))) {
  process.stderr.write('[config] 生产环境 CORS_ORIGINS 必须显式列出来源，禁止使用 * \n');
  process.exit(1);
}

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProd: raw.NODE_ENV === 'production',
  host: raw.HOST,
  port: raw.PORT,
  corsOrigins,
  mediaDir: path.resolve(repoRoot, raw.MEDIA_DIR),
  dataDir: path.resolve(repoRoot, raw.DATA_DIR),
  logLevel: raw.LOG_LEVEL,
  maxUploadBytes: raw.MAX_UPLOAD_BYTES,
  ffmpegPath: raw.FFMPEG_PATH,
  ffprobePath: raw.FFPROBE_PATH,
  importRoots,
  repoRoot,
} as const;

export type Env = typeof env;
