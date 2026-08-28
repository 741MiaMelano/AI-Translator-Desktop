/**
 * 翻译服务商注册表（唯一数据源 / SSOT）。
 *
 * 渲染层（src/domain/workspace.ts）、IPC 校验（electron/ipc/validate.mjs）、
 * 后端查表（backend/translation/provider-lookup.mjs）全部从这里派生，
 * 不允许任何一处再维护第二份副本，否则会出现「前端选得到、后端查不到」。
 *
 * profile 语义：
 * - openai_official        OpenAI 官方，支持 responses / chat_completions 两种传输。
 * - openai_compatible_preset  协议与 OpenAI 兼容，但 base URL 固定为厂商官方入口，
 *                          模型列表可通过「拉取模型」在线获取。
 * - openai_compatible_custom  完全自定义：base URL、模型 ID 都由用户填写。
 * - anthropic_messages     Anthropic 官方 /v1/messages 协议（与 OpenAI 不兼容）。
 * - deepl                  V1 仅保留入口，未接入。
 *
 * ⚠️ 关于 models 字段：
 * 下面每个厂商列出的型号只是「内置兜底列表」，用于用户还没点过「拉取模型」时
 * 有个可用的默认值。厂商会不断上下线型号，这份硬编码一定会过期；
 * **实际可用型号一律以运行时「拉取模型」（GET {baseUrl}/models）的结果为准**，
 * 不要把这里的列表当成能力清单，也不要因为某个型号不在列表里就拒绝用户。
 *
 * 除 OpenAI 官方沿用了展示用的友好 label 之外，新增厂商一律 `id === label`
 * 直接使用厂商 API 的原始模型 ID —— 这样「拉取模型」返回的 ID 可以直接被选中、
 * 保存、解析，不需要额外的 label ↔ id 映射表。
 */

/** 允许使用注册表之外的自由模型 ID 的 profile（拉取到的型号不在硬编码列表里）。 */
export const FREE_FORM_MODEL_PROFILES = Object.freeze([
  "openai_official",
  "openai_compatible_custom",
  "openai_compatible_preset",
  "anthropic_messages",
]);

export function allowsFreeFormModelId(profile) {
  return FREE_FORM_MODEL_PROFILES.includes(profile);
}

/**
 * 自由模型 ID 的边界校验。
 * 模型 ID 会进入请求体、run snapshot 与缓存键，必须限长且禁止控制字符 / 路径穿越片段，
 * 避免用户（或被污染的「拉取模型」响应）塞进换行、超长串或 `../`。
 *
 * 长度上限 200 与 backend/provider/model-list-client.mjs 的 MAX_MODEL_ID_CHARS 对齐：
 * 凡是「拉取模型」能列出来的 ID，都必须能被选中并保存，否则用户会遇到
 * 「列表里有、选了存不进去」。字符集收敛则由这里独立把关（拉取侧只限长不限字符集）。
 */
export function isSafeProviderModelId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/.test(value);
}

const OPENAI_COMPATIBLE_PARAMETERS = ["temperature", "top_p", "max_output_tokens"];

export const TRANSLATION_PROVIDER_CATALOG = Object.freeze([
  {
    id: "openai",
    name: "OpenAI",
    // 内置兜底列表，实际以「拉取模型」结果为准。
    models: [
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
      { id: "gpt-4o", label: "GPT-4o" },
    ],
    profile: "openai_official",
    v1TranslationEnabled: true,
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultTransport: "responses",
    supportedTransports: ["responses", "chat_completions"],
    supportedParameters: [...OPENAI_COMPATIBLE_PARAMETERS],
    credentialId: "openai-default",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    // 内置兜底列表，实际以「拉取模型」结果为准。
    models: [
      { id: "claude-opus-5", label: "claude-opus-5" },
      { id: "claude-sonnet-5", label: "claude-sonnet-5" },
      { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
    ],
    profile: "anthropic_messages",
    v1TranslationEnabled: true,
    defaultBaseUrl: "https://api.anthropic.com",
    defaultTransport: "messages",
    supportedTransports: ["messages"],
    supportedParameters: [...OPENAI_COMPATIBLE_PARAMETERS],
    credentialId: "anthropic-default",
  },
  {
    id: "gemini",
    name: "Gemini",
    // 内置兜底列表，实际以「拉取模型」结果为准。
    models: [
      { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
      { id: "gemini-2.5-flash", label: "gemini-2.5-flash" },
      { id: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite" },
    ],
    profile: "openai_compatible_preset",
    v1TranslationEnabled: true,
    // Google 的 OpenAI 兼容端点，不是原生 generateContent 接口。
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultTransport: "chat_completions",
    supportedTransports: ["chat_completions"],
    supportedParameters: [...OPENAI_COMPATIBLE_PARAMETERS],
    credentialId: "gemini-default",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    // 内置兜底列表，实际以「拉取模型」结果为准。
    models: [
      { id: "deepseek-chat", label: "deepseek-chat" },
      { id: "deepseek-reasoner", label: "deepseek-reasoner" },
    ],
    profile: "openai_compatible_preset",
    v1TranslationEnabled: true,
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultTransport: "chat_completions",
    supportedTransports: ["chat_completions"],
    supportedParameters: [...OPENAI_COMPATIBLE_PARAMETERS],
    credentialId: "deepseek-default",
  },
  {
    id: "zhipu-glm",
    name: "智谱 GLM",
    // 内置兜底列表，实际以「拉取模型」结果为准。
    models: [
      { id: "glm-4.6", label: "glm-4.6" },
      { id: "glm-4.5", label: "glm-4.5" },
      { id: "glm-4.5-air", label: "glm-4.5-air" },
    ],
    profile: "openai_compatible_preset",
    v1TranslationEnabled: true,
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultTransport: "chat_completions",
    supportedTransports: ["chat_completions"],
    supportedParameters: [...OPENAI_COMPATIBLE_PARAMETERS],
    credentialId: "zhipu-glm-default",
  },
  {
    id: "kimi",
    name: "Kimi",
    // 内置兜底列表，实际以「拉取模型」结果为准。
    models: [
      { id: "kimi-k2-0905-preview", label: "kimi-k2-0905-preview" },
      { id: "kimi-latest", label: "kimi-latest" },
      { id: "moonshot-v1-128k", label: "moonshot-v1-128k" },
    ],
    profile: "openai_compatible_preset",
    v1TranslationEnabled: true,
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    defaultTransport: "chat_completions",
    supportedTransports: ["chat_completions"],
    supportedParameters: [...OPENAI_COMPATIBLE_PARAMETERS],
    credentialId: "kimi-default",
  },
  {
    id: "grok",
    name: "Grok",
    // 内置兜底列表，实际以「拉取模型」结果为准。
    models: [
      { id: "grok-4", label: "grok-4" },
      { id: "grok-3", label: "grok-3" },
      { id: "grok-3-mini", label: "grok-3-mini" },
    ],
    profile: "openai_compatible_preset",
    v1TranslationEnabled: true,
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultTransport: "chat_completions",
    supportedTransports: ["chat_completions"],
    supportedParameters: [...OPENAI_COMPATIBLE_PARAMETERS],
    credentialId: "grok-default",
  },
  {
    id: "openai-compatible",
    name: "OpenAI Compatible",
    models: [{ id: "custom-model", label: "custom-model" }],
    profile: "openai_compatible_custom",
    v1TranslationEnabled: true,
    defaultBaseUrl: "",
    defaultTransport: "chat_completions",
    supportedTransports: ["responses", "chat_completions"],
    supportedParameters: [...OPENAI_COMPATIBLE_PARAMETERS],
    credentialId: "openai-compatible-default",
  },
  {
    id: "deepl",
    name: "DeepL",
    models: [{ id: "deepl-pro", label: "DeepL Pro" }],
    profile: "deepl",
    v1TranslationEnabled: false,
    unavailableReason:
      "DeepL 在 V1 仅保留界面入口，尚未接入：真实凭据、连接测试与翻译都未启用。",
    defaultBaseUrl: "",
    defaultTransport: null,
    supportedTransports: [],
    supportedParameters: [],
    credentialId: "deepl-default",
  },
]);
