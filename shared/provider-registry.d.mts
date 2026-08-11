export type ProviderTransportMode = "responses" | "chat_completions" | "messages";
export type TranslationProviderProfile =
  | "openai_official"
  | "openai_compatible_preset"
  | "openai_compatible_custom"
  | "anthropic_messages"
  | "deepl";

export interface ProviderModelDefinition {
  readonly id: string;
  readonly label: string;
}

export interface SharedTranslationProviderDefinition {
  readonly id: string;
  readonly name: string;
  readonly models: readonly ProviderModelDefinition[];
  readonly profile: TranslationProviderProfile;
  readonly v1TranslationEnabled: boolean;
  readonly unavailableReason?: string;
  readonly defaultBaseUrl: string;
  readonly defaultTransport: ProviderTransportMode | null;
  readonly supportedTransports: readonly ProviderTransportMode[];
  readonly supportedParameters: readonly string[];
  readonly credentialId: string;
}

export const TRANSLATION_PROVIDER_CATALOG: readonly SharedTranslationProviderDefinition[];

/** profile 白名单：这些 profile 允许使用注册表之外的模型 ID（来自「拉取模型」）。 */
export const FREE_FORM_MODEL_PROFILES: readonly TranslationProviderProfile[];

export function allowsFreeFormModelId(profile: string | undefined | null): boolean;

export function isSafeProviderModelId(value: unknown): boolean;
