import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from '@ai-cut/shared';
import { env } from '../config/env.js';
import { logger } from '../shared/logger.js';

/**
 * 仓储层：工程状态的落盘与读取。M1 不引入数据库，一个 JSON 文件足够，
 * 且零迁移成本。所有写入走「临时文件 + rename」，保证不会读到半个文件。
 */

const projectFile = path.join(env.dataDir, 'project.json');

export function createDefaultProject(): Project {
  return {
    id: 'default',
    name: '未命名工程',
    fps: 30,
    width: 1920,
    height: 1080,
    assets: [],
    tracks: [
      { id: 'V1', type: 'video', name: '主视频', clips: [] },
      { id: 'V2', type: 'video', name: '覆盖层', clips: [] },
      { id: 'A1', type: 'audio', name: '音频', clips: [] },
    ],
    rev: 0,
    updatedAt: Date.now(),
  };
}

/** 宽松校验：结构不对就重建，不让一个坏文件把服务搞挂。 */
function isValidProject(v: unknown): v is Project {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<Project>;
  return (
    typeof p.id === 'string' &&
    typeof p.rev === 'number' &&
    Array.isArray(p.assets) &&
    Array.isArray(p.tracks) &&
    p.tracks.every((t) => t && typeof t.id === 'string' && Array.isArray(t.clips))
  );
}

class ProjectRepo {
  private project: Project = createDefaultProject();
  /** 串行化写入，避免并发 rename 互相踩 */
  private writeChain: Promise<void> = Promise.resolve();

  async init(): Promise<Project> {
    await mkdir(env.dataDir, { recursive: true });
    try {
      const raw = await readFile(projectFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isValidProject(parsed)) {
        this.project = parsed;
        logger.info('已载入工程状态', { rev: parsed.rev, assets: parsed.assets.length });
        return this.project;
      }
      logger.warn('工程文件结构异常，重建为空工程');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') logger.warn('工程文件读取失败，重建为空工程', { code });
    }
    this.project = createDefaultProject();
    this.project = { ...this.project, rev: 1, updatedAt: Date.now() };
    this.schedulePersist();
    return this.project;
  }

  get(): Project {
    return this.project;
  }

  set(next: Project): void {
    this.project = next;
    this.schedulePersist();
  }

  private schedulePersist(): void {
    const snapshot = this.project;
    this.writeChain = this.writeChain
      .then(async () => {
        const tmp = `${projectFile}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
        await rename(tmp, projectFile);
      })
      .catch((err: unknown) => {
        logger.error('工程状态落盘失败', { message: (err as Error).message });
      });
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}

export const projectRepo = new ProjectRepo();
