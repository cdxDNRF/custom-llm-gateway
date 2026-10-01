/**
 * MiniMax 适配器的运行时加载器。
 *
 * 为什么存在：vendor 的 `minimax-adapter.ts` / `minimax-messages.ts` 与
 * `@deepseek-ai/dsh-llm@0.2.0-rc.2` 存在类型漂移（上游针对更早版本），
 * tsc 无法对「被 import 的文件」豁免检查。本模块用动态 import + 断言，
 * 把类型漂移隔离在运行时；升级上游后可整体删除本文件恢复静态 import。
 */
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'

interface MinimaxAdapterCtor {
  new (options: Record<string, unknown>): LlmAdapter
}

export async function loadMinimaxAdapter(): Promise<MinimaxAdapterCtor> {
  // @ts-expect-error vendor 类型漂移（见文件头说明）
  const mod = (await import('../../vendor/src/minimax-adapter.js')) as {
    MinimaxAdapter: MinimaxAdapterCtor
  }
  return mod.MinimaxAdapter
}
