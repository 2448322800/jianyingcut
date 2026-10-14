import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { Asset } from '@ai-cut/shared';
import { env } from '../config/env.js';
import { UnsupportedMediaError, ValidationError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { makeThumbnail, probe } from './ffmpeg.js';

/**
 * 业务层：接收上传的流 → 落盘 → 探测元数据 → 抽缩略图 → 产出 Asset。
 * 不依赖 HTTP 请求对象，只吃 (stream, filename, mimetype)。
 */

const VIDEO_MIME = /^video\//;
const AUDIO_MIME = /^audio\//;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;

function extOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return /^\.(mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac|flac|ogg|opus)$/.test(ext) ? ext : '.mp4';
}

export interface SaveAssetInput {
  stream: Readable;
  filename: string;
  mimetype: string;
  /** 流是否因超出大小上限被截断 */
  isTruncated: () => boolean;
}

export async function saveAsset(input: SaveAssetInput): Promise<Asset> {
  const { stream, filename, mimetype } = input;

  const isAudio = AUDIO_MIME.test(mimetype) || AUDIO_EXT.test(filename);
  const isVideo = VIDEO_MIME.test(mimetype);
  if (!isAudio && !isVideo) {
    throw new UnsupportedMediaError(`只接受音视频文件，收到的是 ${mimetype || '未知类型'}`);
  }

  const id = globalThis.crypto.randomUUID();
  const dir = path.join(env.mediaDir, id);
  await mkdir(dir, { recursive: true });

  const ext = extOf(filename);
  const sourcePath = path.join(dir, `source${ext}`);

  try {
    await pipeline(stream, createWriteStream(sourcePath));

    if (input.isTruncated()) {
      throw new ValidationError(`文件超过上限 ${env.maxUploadBytes} 字节`);
    }

    const info = await probe(sourcePath);

    let thumbUrl: string | null = null;
    if (info.hasVideo) {
      const thumbPath = path.join(dir, 'thumb.jpg');
      const at = Math.min(0.5, info.duration / 2);
      const ok = await makeThumbnail(sourcePath, thumbPath, at);
      if (ok) thumbUrl = `/media/${id}/thumb.jpg`;
    }

    const { size } = await stat(sourcePath);

    const asset: Asset = {
      id,
      name: filename,
      url: `/media/${id}/source${ext}`,
      thumbUrl,
      duration: info.duration,
      width: info.width,
      height: info.height,
      size,
      mimeType: mimetype || (isAudio ? 'audio/mpeg' : 'video/mp4'),
      createdAt: Date.now(),
      group: null,
      sourcePath: null,
    };

    logger.info('素材已入库', { assetId: id, name: filename, duration: asset.duration, size });
    return asset;
  } catch (err) {
    // 失败就清理干净，不留半成品目录
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
