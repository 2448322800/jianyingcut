import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { BadRequestError } from '../shared/errors.js';
import { reqLogger } from '../shared/logger.js';
import { saveAsset } from './service.js';
import { importFromDisk } from './import.js';
import { projectRepo } from '../project/repo.js';
import { registerAsset, registerAssets } from '../project/service.js';

const ImportBodySchema = z.object({
  /** 要导入的目录或单个文件，必须在 IMPORT_ROOTS 白名单内 */
  root: z.string().min(1),
  recursive: z.boolean().optional(),
  groupBy: z.enum(['parentFolder', 'none']).optional(),
  /** 只导入这些分组，例如 ["E01","E02"] */
  groups: z.array(z.string().min(1)).max(200).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
});

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  /** 上传素材。字段名固定为 file。 */
  app.post('/api/assets', async (req) => {
    const data = await req.file({ limits: { fileSize: env.maxUploadBytes, files: 1 } });
    if (!data) throw new BadRequestError('缺少上传字段 file');

    const asset = await saveAsset({
      stream: data.file,
      filename: data.filename,
      mimetype: data.mimetype,
      isTruncated: () => data.file.truncated,
    });

    const project = registerAsset(asset);
    reqLogger(req).info('POST /api/assets', { assetId: asset.id, rev: project.rev });

    return { asset, project };
  });

  /**
   * 按路径原地导入 —— 外置剪辑台接入别的工程（如漫剧）的主力接口。
   * 不复制文件，直接引用磁盘上的原素材。
   *
   *   { "root": "/path/to/02_数据/05_视频片段", "groupBy": "parentFolder" }
   *
   * 目录结构的第一层文件夹名就是分组名，所以漫剧那边一次导入就按 E01/E02 分好了。
   */
  app.post('/api/assets/import', async (req) => {
    const parsed = ImportBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(
        '导入参数不合法',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    // 已导入过的源文件不重复收 —— 同一个目录可以放心重复调用
    const already = new Set(
      projectRepo
        .get()
        .assets.map((a) => a.sourcePath)
        .filter((p): p is string => typeof p === 'string'),
    );

    const outcome = await importFromDisk(parsed.data, already);
    const project = registerAssets(outcome.imported);

    reqLogger(req).info('POST /api/assets/import', {
      root: parsed.data.root,
      imported: outcome.imported.length,
      skipped: outcome.skipped,
      failed: outcome.failed.length,
      rev: project.rev,
    });

    return {
      project,
      imported: outcome.imported.length,
      scanned: outcome.scanned,
      skipped: outcome.skipped,
      groups: outcome.groups,
      failed: outcome.failed,
    };
  });

  app.get('/api/assets', async () => ({ assets: projectRepo.get().assets }));

  /** 前端拿它显示「可以从哪些目录导入」，外部调用方也可用它判断某路径是否可访问 */
  app.get('/api/import-roots', async () => ({ roots: env.importRoots }));
}
