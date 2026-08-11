import { getTranslationModelOptions } from "../domain/workspace";
import { useWorkspace } from "./WorkspaceContext";

/**
 * 模型下拉的选项，全应用（开始翻译 / 项目配置 / 批量默认）共用这一份取数规则。
 *
 * 优先用能力目录里的型号——那是用户在「模型与连接」点「拉取」后从服务商真实取回的列表。
 * 只读注册表的内置兜底列表，会出现「拉到了 deepseek-v4 系列，
 * 回到项目里却死活只能选 deepseek-chat」。
 *
 * 服务商不在注册表时 getTranslationModelOptions 会抛异常，兜底成空数组，
 * 页面不该因此整页白屏。
 */
export function useModelOptionsFor(provider: string): readonly string[] {
  const { capabilities } = useWorkspace();
  const fromCatalog = capabilities.providers.find((entry) => entry.name === provider)?.models;
  if (fromCatalog && fromCatalog.length > 0) return fromCatalog;
  try {
    return getTranslationModelOptions(provider);
  } catch {
    return [];
  }
}
