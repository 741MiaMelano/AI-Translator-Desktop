import {
  TRANSLATION_PROVIDER_CATALOG,
  allowsFreeFormModelId,
  isSafeProviderModelId,
} from "../../shared/provider-registry.mjs";

export const TRANSLATION_PROVIDER_RUNTIME = TRANSLATION_PROVIDER_CATALOG;

export function getTranslationProviderByName(name) {
  return TRANSLATION_PROVIDER_RUNTIME.find((provider) => provider.name === name) ?? null;
}

export function getTranslationProviderById(id) {
  return TRANSLATION_PROVIDER_RUNTIME.find((provider) => provider.id === id) ?? null;
}

export function resolveTranslationModelId(provider, model) {
  const requested = model || provider?.models?.[0]?.label;
  const matched = provider?.models?.find(
    (candidate) => candidate.id === requested || candidate.label === requested,
  );
  if (matched) return matched.id;
  // 自定义 / 预置兼容厂商 / Anthropic：模型列表来自运行时「拉取模型」，
  // 不可能全部预置在注册表里，因此放行注册表之外的模型 ID（仍要过边界校验）。
  if (allowsFreeFormModelId(provider?.profile) && isSafeProviderModelId(requested)) {
    return requested;
  }
  const error = new Error("Model is not available for this provider");
  error.code = "INVALID_INPUT";
  error.providerErrorClass = "invalid_config";
  throw error;
}
