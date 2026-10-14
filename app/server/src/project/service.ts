import type { Asset, Command, CommandSource, Project } from '@ai-cut/shared';
import { applyCommands } from '@ai-cut/shared';
import { logger } from '../shared/logger.js';
import { eventHub } from './events.js';
import { projectRepo } from './repo.js';

/**
 * 业务层：编排「读状态 → 应用命令 → 推进修订号 → 落盘 → 广播」。
 * 不依赖 HTTP 请求/响应对象——同一条路径同时服务 Web 端和外部 AI 调用。
 */

export interface MutationResult {
  project: Project;
  applied: number;
}

/**
 * 推进修订号的唯一入口。
 * Node 单线程 + 这里没有任何 await，所以「读-改-写」天然是原子的，
 * 不需要额外的互斥锁。
 */
function commit(
  draft: Project,
  originId: string | null,
  commands: Command[],
  source: CommandSource,
): Project {
  const current = projectRepo.get();
  const committed: Project = { ...draft, rev: current.rev + 1, updatedAt: Date.now() };
  projectRepo.set(committed);
  eventHub.publish({ type: 'project', rev: committed.rev, project: committed, originId, commands, source });
  return committed;
}

/** 执行一批编辑命令。命令批次是原子的：任一条不合法，整体不生效。 */
export function runCommands(
  commands: Command[],
  source: CommandSource,
  originId: string | null = null,
): MutationResult {
  const current = projectRepo.get();
  const applied = applyCommands(current, commands); // 失败会抛 DomainError，状态未被触碰
  const committed = commit(applied, originId, commands, source);

  logger.info('命令已执行', { count: commands.length, source, rev: committed.rev, originId });
  return { project: committed, applied: commands.length };
}

/** 上传成功后把素材登记进工程（素材本身不是编辑命令，走独立入口） */
export function registerAsset(asset: Asset): Project {
  return registerAssets([asset]);
}

/** 批量登记。按路径导入一次可能带进来几十个素材，走同一个提交路径。 */
export function registerAssets(assets: Asset[]): Project {
  if (assets.length === 0) return projectRepo.get();
  const current = projectRepo.get();
  const next: Project = { ...current, assets: [...assets, ...current.assets] };
  return commit(next, null, [], 'system');
}
