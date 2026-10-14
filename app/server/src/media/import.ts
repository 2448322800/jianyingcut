import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Asset } from '@ai-cut/shared';
import { env } from '../config/env.js';
import { BadRequestError, ForbiddenError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { makeThumbnail, probe } from './ffmpeg.js';

/**
 * 按路径原地导入。
 *
 * 这是「外置剪辑台直接访问漫剧工程素材」的入口：不复制文件，
 * 素材 URL 直接指向磁盘原路径，通过 /imported/<根序号>/<相对路径> 提供。
 * 好处有两条：不占双份磁盘；漫剧那边重新生成片段后，编辑器刷新就能看到新版。
 *
 * 安全边界：只允许读 env.importRoots 白名单内的路径。没有这道闸，
 * 这个接口等于把整个文件系统开放出去。
 */

const MEDIA_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi',
  '.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg',
]);

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg']);

/** 目录白名单校验。通过则返回该路径属于第几个根、以及相对该根的路径。 */
export function resolveImportRoot(target: string): { rootIndex: number; absolute: string; relative: string } {
  const absolute = path.resolve(target);
  for (let i = 0; i < env.importRoots.length; i++) {
    const root = env.importRoots[i] as string;
    if (absolute === root || absolute.startsWith(root + path.sep)) {
      return { rootIndex: i, absolute, relative: path.relative(root, absolute) };
    }
  }
  throw new ForbiddenError(
    '这个路径不在允许导入的范围内',
    { allowedRoots: env.importRoots, hint: '如需放开，把目录加进 .env 的 IMPORT_ROOTS（逗号分隔）后重启' },
  );
}

/** 原地引用模式下，素材对外暴露的 URL。中文与空格要编码，否则 <video> 取不到。 */
export function importedUrl(rootIndex: number, absolutePath: string): string {
  const root = env.importRoots[rootIndex] as string;
  const relative = path.relative(root, absolutePath);
  const encoded = relative
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/imported/${rootIndex}/${encoded}`;
}

/** 有界并发，避免几百个 ffprobe 一起把机器打满 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

interface FoundFile {
  absolute: string;
  group: string | null;
}

/** 递归扫目录。只认音视频扩展名，跳过隐藏目录与 __pycache__ 之类的噪音。 */
async function scan(root: string, recursive: boolean, groupBy: 'parentFolder' | 'none'): Promise<FoundFile[]> {
  const found: FoundFile[] = [];
  const walk = async (dir: string, group: string | null, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name.startsWith('_废弃')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!recursive || depth >= 4) continue;
        // 相对导入根的第一层文件夹名就是分组名（漫剧那边正好是 E01 / E02 …）
        const nextGroup = groupBy === 'none' ? null : (group ?? entry.name);
        await walk(full, nextGroup, depth + 1);
      } else if (entry.isFile() && MEDIA_EXT.has(path.extname(entry.name).toLowerCase())) {
        found.push({ absolute: full, group });
      }
    }
  };
  await walk(root, null, 0);
  return found;
}

async function toAsset(file: FoundFile, rootIndex: number, existing: Set<string>): Promise<Asset | null> {
  if (existing.has(file.absolute)) return null;

  const info = await stat(file.absolute);
  const id = globalThis.crypto.randomUUID();
  const name = path.basename(file.absolute);

  const probed = await probe(file.absolute);

  let thumbUrl: string | null = null;
  if (probed.hasVideo) {
    const dir = path.join(env.mediaDir, id);
    await mkdir(dir, { recursive: true });
    const ok = await makeThumbnail(file.absolute, path.join(dir, 'thumb.jpg'), Math.min(0.5, probed.duration / 2));
    if (ok) thumbUrl = `/media/${id}/thumb.jpg`;
  }

  const isAudio = AUDIO_EXT.has(path.extname(name).toLowerCase()) || !probed.hasVideo;

  return {
    id,
    name,
    url: importedUrl(rootIndex, file.absolute),
    thumbUrl,
    duration: probed.duration,
    width: probed.width,
    height: probed.height,
    size: info.size,
    mimeType: isAudio ? 'audio/mpeg' : 'video/mp4',
    createdAt: Date.now(),
    group: file.group,
    sourcePath: file.absolute,
  };
}

export interface ImportInput {
  /** 要导入的目录或单个文件 */
  root: string;
  /** 是否递归子目录，默认 true */
  recursive?: boolean;
  /** 分组方式：按第一层文件夹名 / 不分组。默认 parentFolder */
  groupBy?: 'parentFolder' | 'none';
  /** 只导入这些分组（例如 ["E01","E02"]），不传表示全部 */
  groups?: string[];
  /** 单次导入上限，默认 400，挡住手滑指向一个巨大目录 */
  limit?: number;
}

export interface ImportOutcome {
  imported: Asset[];
  scanned: number;
  skipped: number;
  /** 分组 → 文件数 */
  groups: Record<string, number>;
  /** 扫描过程中探测失败的文件（不阻断整体导入） */
  failed: Array<{ path: string; reason: string }>;
}

export async function importFromDisk(input: ImportInput, alreadyImported: Set<string>): Promise<ImportOutcome> {
  const { rootIndex } = resolveImportRoot(input.root);

  const info = await stat(path.resolve(input.root)).catch(() => null);
  if (!info) throw new BadRequestError(`路径不存在：${input.root}`);

  const recursive = input.recursive ?? true;
  const groupBy = input.groupBy ?? 'parentFolder';
  const limit = Math.min(Math.max(input.limit ?? 400, 1), 2000);

  let files: FoundFile[];
  if (info.isFile()) {
    if (!MEDIA_EXT.has(path.extname(input.root).toLowerCase())) {
      throw new BadRequestError(`不是支持的音视频文件：${path.basename(input.root)}`);
    }
    files = [{ absolute: path.resolve(input.root), group: null }];
  } else {
    files = await scan(path.resolve(input.root), recursive, groupBy);
  }

  if (input.groups && input.groups.length > 0) {
    const wanted = new Set(input.groups);
    files = files.filter((f) => f.group !== null && wanted.has(f.group));
  }

  const truncated = files.length > limit;
  if (truncated) files = files.slice(0, limit);

  const assets: Asset[] = [];
  const failed: ImportOutcome['failed'] = [];
  const seen = new Set(alreadyImported);

  await mapLimit(files, 4, async (file) => {
    try {
      const asset = await toAsset(file, rootIndex, seen);
      if (asset) {
        seen.add(file.absolute);
        assets.push(asset);
      }
    } catch (err) {
      failed.push({ path: path.basename(file.absolute), reason: (err as Error).message });
    }
  });

  const groups: Record<string, number> = {};
  for (const asset of assets) {
    const key = asset.group ?? '(未分组)';
    groups[key] = (groups[key] ?? 0) + 1;
  }

  logger.info('按路径导入完成', {
    root: input.root,
    imported: assets.length,
    scanned: files.length,
    skipped: files.length - assets.length,
    failed: failed.length,
    truncated,
  });

  return {
    imported: assets,
    scanned: files.length,
    skipped: files.length - assets.length,
    groups,
    failed,
  };
}
