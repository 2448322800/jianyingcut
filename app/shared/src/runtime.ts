/**
 * 运行环境适配。
 *
 * shared 是前后端同构的零依赖包，不能假设宿主是 Node 还是浏览器，
 * 所以不引入 DOM / @types/node 的 lib，而是把用到的两个标准能力显式声明出来。
 * 两者在 Node 17+ 与所有现代浏览器里都是全局可用的。
 */

declare const structuredClone: <T>(value: T) => T;

const cryptoRef = globalThis as unknown as { crypto: { randomUUID(): string } };

export const uuid = (): string => cryptoRef.crypto.randomUUID();

export const clone = <T>(value: T): T => structuredClone(value);
