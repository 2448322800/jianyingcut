import type { Command, CommandSource, Project } from '@ai-cut/shared';
import { logger } from '../shared/logger.js';

/**
 * SSE 广播中心。只做一件事：把「工程变了」推给所有连着的客户端。
 * 客户端因此不需要轮询，AI 在服务端改的东西也会即时出现在页面上。
 *
 * 载荷里同时带上「是谁、用什么命令改的」，前端才能把 AI 的操作
 * 和用户自己的操作区分开显示出来 —— 这是命令流审计能成立的前提。
 */

export interface ProjectEvent {
  type: 'project';
  rev: number;
  project: Project;
  /** 谁触发的。Web 端用 clientId 标识；外部 AI 调用为 null。 */
  originId: string | null;
  /** 本次变更由哪些命令造成。素材登记这类非命令变更为空数组。 */
  commands: Command[];
  source: CommandSource;
}

type Subscriber = (event: ProjectEvent) => void;

class EventHub {
  private readonly subscribers = new Set<Subscriber>();

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  get size(): number {
    return this.subscribers.size;
  }

  publish(event: ProjectEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        // 单个订阅者出错不能影响其他订阅者
        logger.warn('SSE 推送失败', { message: (err as Error).message });
      }
    }
  }
}

export const eventHub = new EventHub();
