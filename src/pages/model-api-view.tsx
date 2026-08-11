import { Cpu, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  ASR_VAD_PRESET_PARAMETERS,
  ASR_VAD_RECOMMENDED_PARAMETERS,
  effectiveAsrVadParameters,
} from "../../shared/asr-vad-config.mjs";
import ConfirmDialog from "../components/feature/project-overview/ConfirmDialog";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";
import Tabs from "../components/ui/Tabs";
import PageHeader from "../layout/PageHeader";
import { isDesktopRuntime } from "../services/desktop-client";
import type { ModelApiController } from "./model-api-controller";

/**
 * 只做展示：入口的中文名与一句话定位。
 * 这里刻意不再放「模型能力」「使用统计」——那两块是写死的常量，
 * 永远全是 ✓，既不是探测结果也不随配置变化，只会把 API Key 和「测试连接」
 * 隔开几百像素，逼用户上下滚动。能力与用量只应由真实运行结果给出。
 */
const PROVIDER_DISPLAY: Record<string, { label: string; note: string }> = {
  OpenAI: { label: "OpenAI", note: "官方入口" },
  Anthropic: { label: "Anthropic", note: "官方入口" },
  Gemini: { label: "Gemini", note: "兼容入口" },
  DeepSeek: { label: "DeepSeek", note: "官方入口" },
  "智谱 GLM": { label: "智谱 GLM", note: "官方入口" },
  Kimi: { label: "Kimi", note: "官方入口" },
  Grok: { label: "Grok", note: "官方入口" },
  "OpenAI Compatible": { label: "自定义接口", note: "任意兼容端点" },
  DeepL: { label: "DeepL", note: "尚未接入" },
  "Whisper.cpp": { label: "Whisper.cpp", note: "稳定 · 本地识别" },
  "本地 ASR": { label: "本地 ASR", note: "Whisper 稳定 · Qwen Preview" },
};

const STATUS_VIEW = {
  ready: { label: "已连接", tone: "green" },
  untested: { label: "未验证", tone: "gold" },
  failed: { label: "失败", tone: "red" },
} as const;

const ASR_DOWNLOAD_SOURCES = [
  { id: "auto" as const, label: "自动选择", title: "按健康度自动选择可用下载源" },
  { id: "official" as const, label: "官方源", title: "固定使用官方源" },
  { id: "mirror" as const, label: "国内镜像", title: "固定使用国内镜像" },
];

const ASR_MODEL_FAMILIES = [
  { id: "small", label: "Small", note: "兼容模式" },
  { id: "large-v3-turbo", label: "Large V3 Turbo", note: "推荐模式" },
  { id: "large-v3", label: "Large V3", note: "最高精度" },
  { id: "qwen3-asr", label: "Qwen3-ASR", note: "Preview · 仅 CUDA" },
] as const;

const ASR_VARIANT_LABELS = {
  q5_0: "Q5",
  q8_0: "Q8",
  full: "完整版",
  "0.6b": "0.6B",
  "1.7b": "1.7B",
} as const;

/** 与 Select.tsx 同一套控件外观，但这里需要 option 的 value ≠ 显示文本。 */
const FIELD =
  "control-surface h-8 w-full rounded-[6px] border border-line-strong bg-card px-2.5 text-[13px] text-[var(--color-text-main)] outline-none transition hover:border-gold focus:border-gold disabled:opacity-50";

function providerLabel(name?: string) {
  return (name && PROVIDER_DISPLAY[name]?.label) || name || "—";
}

/** 只显示主机名，避免把完整地址（可能带路径）塞进窄卡片。地址本身来自注册表。 */
function providerEndpointHint(baseUrl?: string | null) {
  if (!baseUrl) return "需自行填写地址";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function ProviderCard({
  name,
  hint,
  active,
  onSelect,
}: {
  name: string;
  hint: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`flex min-w-0 flex-col gap-0.5 rounded-[6px] border px-3 py-2 text-left transition ${
        active ? "border-gold bg-gold-wash" : "border-line bg-card hover:border-gold"
      }`}
    >
      <span
        className={`truncate text-[13px] font-medium ${active ? "text-gold-dark" : "text-[var(--color-text-main)]"}`}
      >
        {providerLabel(name)}
      </span>
      <span className="truncate text-[11.5px] text-[var(--color-text-muted)]" title={hint}>
        {hint}
      </span>
    </button>
  );
}

function ProviderGrid({ controller }: { controller: ModelApiController }) {
  const isAsrTab = controller.tab === "语音识别模型";
  return (
    <Card
      data-testid={isAsrTab ? "asr-engine" : undefined}
      title={isAsrTab ? "识别引擎" : "服务商"}
      description={
        isAsrTab
          ? "whisper.cpp 1.9.1 稳定版与 Qwen3-ASR Preview，本地运行，不需要联网凭据。"
          : "先选服务商，下方只显示这一个入口的连接配置。"
      }
      dense
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {controller.visibleProviders.map((provider) => (
          <ProviderCard
            key={provider.id}
            name={provider.name}
            hint={
              provider.kind === "llm" && provider.status !== "unavailable"
                ? providerEndpointHint(provider.baseUrlDisplay)
                : PROVIDER_DISPLAY[provider.name]?.note ?? provider.summary
            }
            active={provider.id === controller.selectedProvider?.id}
            onSelect={() => controller.setSelectedProviderId(provider.id)}
          />
        ))}
        {isAsrTab ? (
          <div className="flex min-w-0 flex-col gap-0.5 rounded-[6px] border border-dashed border-line bg-card-soft px-3 py-2">
            <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--color-text-main)]">
              SenseVoice <Badge tone="gray">评估中</Badge>
            </span>
            <span className="truncate text-[11.5px] text-[var(--color-text-muted)]">尚未接入，不可选择</span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function ModelField({ controller }: { controller: ModelApiController }) {
  const freeForm = controller.providerDefinition?.profile === "openai_compatible_custom";
  const canFetch = isDesktopRuntime() && !controller.modelsBusy && !controller.connectionBusy;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[12.5px] text-[var(--color-text-muted)]">模型</span>
        <span className="ml-auto text-[11.5px] text-[var(--color-text-muted)]">
          {controller.modelsFetched
            ? `服务商返回 ${controller.modelOptions.length} 个`
            : `内置兜底 ${controller.modelOptions.length} 个`}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {freeForm ? (
            <>
              <Input
                value={controller.selectedModel}
                list="model-api-fetched-models"
                spellCheck={false}
                placeholder="点右侧「拉取」后从列表挑选，或直接填写模型 ID"
                onChange={(event) => controller.setSelectedModel(event.target.value)}
              />
              <datalist id="model-api-fetched-models">
                {controller.modelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </datalist>
            </>
          ) : (
            <select
              aria-label="模型"
              className={FIELD}
              value={controller.selectedModel}
              onChange={(event) => controller.setSelectedModel(event.target.value)}
            >
              {controller.modelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCw size={14} className={controller.modelsBusy ? "animate-spin" : ""} />}
          disabled={!canFetch}
          title="用当前地址与密钥向服务商查询可用型号，结果直接填进左边的下拉"
          onClick={() => void controller.fetchModels()}
        >
          {controller.modelsBusy ? "拉取中…" : "拉取"}
        </Button>
      </div>
      {controller.modelsMessage ? (
        <p role="status" className="mt-1 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
          {controller.modelsMessage}
        </p>
      ) : null}
      {controller.modelWarning ? (
        <p role="alert" className="mt-1 text-[11.5px] leading-5 text-stop">
          {controller.modelWarning}
        </p>
      ) : null}
    </div>
  );
}

function ConnectionActions({ controller }: { controller: ModelApiController }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
      {/*
        保存和测试是两件事，必须分开：
        测试会真的发一次请求（花 token），用户可能只想改个地址存下来，不该被强制联网。
      */}
      <Button
        variant="primary"
        disabled={!isDesktopRuntime() || controller.connectionBusy}
        title={isDesktopRuntime() ? "保存 API Key，并把当前服务商和模型设为全局默认；不发送测试请求" : "该操作只能在桌面应用里执行"}
        onClick={() => void controller.saveConfiguration()}
      >
        保存配置
      </Button>
      <Button
        variant="outline"
        disabled={!isDesktopRuntime() || controller.connectionBusy || !controller.credentialConfigured}
        title={
          !isDesktopRuntime()
            ? "该操作只能在桌面应用里执行"
            : controller.credentialConfigured
              ? "发送一次很短的请求，验证地址和密钥是否可用（会消耗少量 token）"
              : "请先保存 API Key"
        }
        onClick={() => void controller.testConnection()}
      >
        {controller.connectionBusy ? "测试中…" : "测试连接"}
      </Button>
      <Button
        variant="ghost"
        disabled={!isDesktopRuntime() || !controller.credentialConfigured || controller.connectionBusy}
        title="从系统安全凭据里移除这个入口的密钥"
        onClick={() => void controller.deleteCredential()}
      >
        删除 API Key
      </Button>
      <Badge tone={controller.credentialConfigured ? "green" : "gray"}>
        {controller.credentialConfigured ? "密钥已保存" : "密钥未保存"}
      </Badge>
    </div>
  );
}

function ConnectionCard({ controller }: { controller: ModelApiController }) {
  const definition = controller.providerDefinition;
  if (!definition) return null;
  if (!definition.v1TranslationEnabled) {
    return (
      <Card title="连接配置" description="这个入口在当前版本只保留界面位置。">
        <p className="rounded-[6px] border border-line bg-card-soft px-3 py-2.5 text-[12.5px] leading-5 text-[var(--color-text-muted)]">
          {definition.unavailableReason ?? "该服务商当前不可用。"}
        </p>
      </Card>
    );
  }
  return (
    <Card title="连接配置" description="填地址、填密钥、拉模型、测一下，四步在同一张卡里完成。">
      <div className="space-y-3">
        <Input
          label="接口地址"
          value={controller.baseUrl}
          spellCheck={false}
          placeholder="填写服务商提供的接口地址"
          hint="预置服务商已自动填好；只有自建或代理入口才需要改。"
          onChange={(event) => controller.setBaseUrl(event.target.value)}
        />
        <Input
          label="API Key"
          type="password"
          autoComplete="off"
          inputRef={controller.secretInputRef}
          placeholder={controller.credentialConfigured ? "已保存；填入新值可替换" : "只在保存时提交一次"}
          hint="密钥写入系统安全凭据，不进日志、不进错误信息。"
        />
        <ModelField controller={controller} />
        <ConnectionActions controller={controller} />
        {controller.connectionMessage ? (
          <p
            role={controller.connectionStatus === "failed" ? "alert" : "status"}
            className={`rounded-[6px] border px-3 py-2 text-[12.5px] leading-5 ${
              controller.connectionStatus === "failed"
                ? "border-stop bg-stop-wash text-[var(--color-text-main)]"
                : "border-line bg-card-soft text-[var(--color-text-muted)]"
            }`}
          >
            {controller.connectionMessage}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="shrink-0 text-[11.5px] text-[var(--color-text-muted)]">{label}</dt>
      <dd className="ml-auto min-w-0 truncate text-[12.5px] text-[var(--color-text-main)]" title={value}>
        {value}
      </dd>
    </div>
  );
}

function ConnectionStatusCard({ controller }: { controller: ModelApiController }) {
  const definition = controller.providerDefinition;
  const usable = Boolean(definition?.v1TranslationEnabled);
  const view = usable ? STATUS_VIEW[controller.connectionStatus] : ({ label: "不可用", tone: "gray" } as const);
  const testable = isDesktopRuntime() && usable && !controller.connectionBusy;
  return (
    <Card title="连接状态" actions={<Badge tone={view.tone}>{view.label}</Badge>}>
      <dl className="space-y-2">
        <StatusRow label="服务商" value={providerLabel(definition?.name)} />
        <StatusRow label="响应时间" value={controller.latencyMs === null ? "尚未测试" : `${controller.latencyMs} ms`} />
        <StatusRow
          label="可用模型"
          value={`${controller.modelOptions.length} 个${controller.modelsFetched ? "（服务商返回）" : "（内置兜底）"}`}
        />
        <StatusRow label="当前模型" value={controller.selectedModel || "尚未选择"} />
      </dl>
      <Button
        className="mt-3 w-full"
        variant="secondary"
        disabled={!testable}
        title={testable ? "用当前配置再测一次" : "该入口暂时无法测试"}
        onClick={() => void controller.testConnection()}
      >
        {controller.connectionBusy ? "测试中…" : "重新测试"}
      </Button>
      <p className="mt-2 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        响应时间是一次真实请求的往返耗时，未测试前不做任何推断。
      </p>
    </Card>
  );
}

function deviceDetectionLabel(status: ModelApiController["asrDeviceStatus"], device: "cpu" | "cuda") {
  const detection = status?.detection[device];
  if (!detection || detection.status === "not_detected") return "尚未检测";
  if (detection.status === "available") return `可用 · runtime ${detection.runtimeVersion}`;
  const reasons = {
    runtime_not_ready: "运行时未就绪",
    probe_failed: "运行时探测失败",
    initialization_failed: "初始化失败",
  };
  return `不可用 · ${detection.reason ? reasons[detection.reason] : "原因未知"}`;
}

function AsrDevicePanel({ controller }: { controller: ModelApiController }) {
  const status = controller.asrDeviceStatus;
  const requested = status?.requestedDevice ?? "auto";
  const fallbackLabels = {
    cuda_not_ready: "CUDA runtime 未就绪，使用 CPU",
    cuda_probe_failed: "CUDA 探测失败，使用 CPU",
    cuda_initialization_failed: "CUDA 初始化失败，已从头改用 CPU",
  };
  return (
    <Card
      data-testid="asr-device-policy"
      title="设备策略"
      description="选择识别使用的计算设备，并显式控制回退行为。"
      actions={<Cpu size={14} className="text-gold-dark" />}
    >
      <div className="grid grid-cols-3 gap-2">
        {(["auto", "cpu", "cuda"] as const).map((device) => (
          <Button
            key={device}
            variant={requested === device ? "primary" : "outline"}
            disabled={!isDesktopRuntime() || controller.asrDeviceBusy}
            title={`把识别设备固定为 ${device === "auto" ? "Auto" : device.toUpperCase()}`}
            aria-pressed={requested === device}
            onClick={() => void controller.selectAsrDevice(device)}
          >
            {device === "auto" ? "Auto" : device.toUpperCase()}
          </Button>
        ))}
      </div>
      <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-[6px] border border-line bg-card-soft px-3 py-2 text-[12.5px] text-[var(--color-text-main)]">
        <input
          type="checkbox"
          checked={status?.allowCudaFallback ?? false}
          disabled={!isDesktopRuntime() || controller.asrDeviceBusy}
          onChange={(event) => void controller.setAsrCudaFallback(event.target.checked)}
        />
        显式选择 CUDA 时，初始化失败后回退 CPU
      </label>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {(["cpu", "cuda"] as const).map((device) => (
          <div key={device} className="rounded-[6px] border border-line bg-card-soft px-3 py-2">
            <p className="text-[12.5px] font-medium text-[var(--color-text-main)]">{device.toUpperCase()}</p>
            <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
              {deviceDetectionLabel(status, device)}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={!isDesktopRuntime() || controller.asrDeviceBusy}
          title="真实探测本机 CPU 与 CUDA 运行时"
          onClick={() => void controller.detectAsrDevices()}
        >
          检测设备
        </Button>
        <Button
          variant="ghost"
          disabled={!isDesktopRuntime() || !controller.asrDeviceBusy}
          title="中止正在进行的设备检测"
          onClick={() => void controller.cancelAsrDeviceDetection()}
        >
          取消检测
        </Button>
        <span className="text-[11.5px] text-[var(--color-text-muted)]">
          上次实际运行设备：{status?.actualDevice?.toUpperCase() ?? "尚未运行"}
          {status?.actualRuntimeVersion ? ` · runtime ${status.actualRuntimeVersion}` : ""}
        </span>
      </div>
      {status?.fallbackReason ? (
        <p className="mt-2 text-[11.5px] text-warn">{fallbackLabels[status.fallbackReason]}</p>
      ) : null}
      <p
        role={controller.asrDeviceError ? "alert" : "status"}
        className={`mt-2 text-[11.5px] leading-5 ${controller.asrDeviceError ? "text-stop" : "text-[var(--color-text-muted)]"}`}
      >
        {controller.asrDeviceMessage}
      </p>
    </Card>
  );
}

function installStateLabel(state?: string, reason?: string) {
  if (state === "corrupt") {
    return ({
      missing_file: "文件缺失",
      size_mismatch: "大小不符",
      hash_mismatch: "哈希不符",
      undeclared_file: "含未知文件",
      invalid_file: "文件无效",
      reparse_point: "目录异常",
      reparse_or_invalid_root: "目录异常",
      reparse_root: "存储目录异常",
      verification_failed: "无法校验",
    } as Record<string, string>)[reason ?? ""] ?? "文件损坏";
  }
  return ({
    not_installed: "未安装",
    installing: "安装中",
    ready: "已验证",
    incompatible: "版本不兼容",
  } as Record<string, string>)[state ?? ""] ?? "未知";
}

function installStateDescription(state?: string, reason?: string) {
  if (state === "ready") return "模型文件完整，SHA-256 校验通过";
  if (state === "not_installed") return "没有找到模型目录或模型文件";
  if (state === "incompatible") return "本地文件存在，但版本与当前应用不兼容";
  return ({
    missing_file: "模型目录存在，但必需文件缺失",
    size_mismatch: "模型文件大小与清单不符，可能下载不完整",
    hash_mismatch: "模型文件内容与清单不符，可能已损坏",
    undeclared_file: "模型目录包含清单之外的文件",
    invalid_file: "模型路径不是有效的普通文件",
    reparse_point: "模型目录包含不受支持的链接",
    reparse_or_invalid_root: "模型目录不是有效的普通目录",
    reparse_root: "全局模型存储目录异常",
    verification_failed: "读取模型文件时失败，无法完成校验",
  } as Record<string, string>)[reason ?? ""] ?? "模型文件存在异常，需要卸载后重新下载";
}

function hasRemovableAsset(state?: string) {
  return state === "ready" || state === "corrupt" || state === "incompatible";
}

function AsrAssetActions({ controller }: { controller: ModelApiController }) {
  const modelId = controller.asrDefaultModelId;
  const busy = !isDesktopRuntime() || controller.asrModelBusy;
  const model = controller.asrCapability?.models.find((entry) => entry.id === modelId);
  const qwen = model?.engineId === "qwen3-asr";
  const runtimeId = qwen ? "qwen3-asr-transformers-cu128-x64" : "whisper-cpp-cuda-12.4-x64";
  const cuda = controller.asrCapability?.optionalRuntimes.find((runtime) =>
    runtime.device === "cuda" && (runtime.engineId ?? "whisper.cpp") === (qwen ? "qwen3-asr" : "whisper.cpp"));
  const [selectedSource, setSelectedSource] = useState<"auto" | "official" | "mirror">("auto");
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-[12.5px] font-medium text-[var(--color-text-main)]">选择下载源</p>
        <div role="group" aria-label="语音识别模型下载源" className="grid gap-2 sm:grid-cols-3">
          {ASR_DOWNLOAD_SOURCES.map((source) => (
            <Button
              key={source.id}
              variant={selectedSource === source.id ? "primary" : "outline"}
              disabled={busy}
              title={source.title}
              aria-pressed={selectedSource === source.id}
              onClick={() => setSelectedSource(source.id)}
            >
              {source.label}
            </Button>
          ))}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
          选择下载源不会立即下载；确认后再点击下面的开始按钮。
        </p>
      </div>
      <div>
        <p className="mb-1.5 text-[12.5px] font-medium text-[var(--color-text-main)]">模型操作</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy} title={`从已选择的来源下载并校验 ${modelId} 模型`} onClick={() => void controller.installAsrModel(modelId, selectedSource)}>开始下载 / 继续下载</Button>
          {!qwen ? <Button variant="outline" disabled={busy} title={`选择本地 ${modelId} 文件并按清单校验`} onClick={() => void controller.importAsrModel(modelId)}>手动导入</Button> : null}
          <Button
            variant="danger"
            disabled={busy || !hasRemovableAsset(model?.installState)}
            title={hasRemovableAsset(model?.installState) ? `删除 ${modelId} 的本地文件或损坏残留` : `${modelId} 没有可卸载的本地文件`}
            onClick={() => setConfirmingUninstall(true)}
          >
            卸载模型
          </Button>
          <Button variant="dark" disabled={!isDesktopRuntime() || !controller.asrModelBusy} title="暂停当前下载，断点保留" onClick={() => void controller.cancelAsrAssetOperation()}>暂停下载</Button>
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[12.5px] font-medium text-[var(--color-text-main)]">CUDA 操作</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} title={`安装 ${runtimeId}`} onClick={() => void controller.installAsrRuntime(runtimeId)}>安装 CUDA runtime</Button>
          {!qwen ? <Button variant="outline" disabled={busy} title="选择本地 CUDA runtime 并校验" onClick={() => void controller.importAsrRuntime(runtimeId)}>手动导入 CUDA runtime</Button> : null}
          <Button variant="danger" disabled={busy || !hasRemovableAsset(cuda?.installState)} title="删除已安装或损坏残留的 CUDA runtime" onClick={() => void controller.uninstallAsrRuntime(runtimeId)}>卸载 CUDA runtime</Button>
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[12.5px] font-medium text-[var(--color-text-main)]">资料</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" disabled={!isDesktopRuntime()} title="打开引擎来源说明" onClick={() => void controller.openAsrInfo("engine-source", modelId)}>引擎来源</Button>
          <Button variant="ghost" disabled={!isDesktopRuntime()} title="打开引擎许可证" onClick={() => void controller.openAsrInfo("engine-license", modelId)}>引擎许可证</Button>
          <Button variant="ghost" disabled={!isDesktopRuntime()} title={`打开 ${modelId} 来源说明`} onClick={() => void controller.openAsrInfo("model-source", modelId)}>模型来源</Button>
          <Button variant="ghost" disabled={!isDesktopRuntime()} title={`打开 ${modelId} 许可证`} onClick={() => void controller.openAsrInfo("model-license", modelId)}>模型许可证</Button>
        </div>
      </div>
      {controller.asrModelMessageArea === "maintenance" ? (
        <p
          role={controller.asrModelError ? "alert" : "status"}
          className={`text-[11.5px] leading-5 ${controller.asrModelError ? "text-stop" : "text-[var(--color-text-muted)]"}`}
        >
          {controller.asrModelMessage}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmingUninstall}
        tone="danger"
        title={`卸载 ${model?.displayName ?? modelId}？`}
        description="将删除这个模型的本地文件。正在运行语音识别时会拒绝卸载；卸载后，依赖这个模型的项目需要重新安装模型才能继续。"
        confirmLabel="确认卸载"
        onCancel={() => setConfirmingUninstall(false)}
        onConfirm={() => {
          setConfirmingUninstall(false);
          void controller.uninstallAsrModel(modelId);
        }}
      />
    </div>
  );
}

function AsrVocalSeparationPanel({ controller }: { controller: ModelApiController }) {
  const enabled = controller.asrVocalSeparation === "on";
  const busy = controller.asrVocalSeparationBusy;
  return (
    <Card
      data-testid="asr-vocal-separation-panel"
      title="对话人声分离"
      description="处理顺序：人声分离 → 唱词处理 → VAD → 语音识别"
      actions={<Badge tone={enabled ? "green" : "gray"}>{enabled ? "已开启" : "已关闭"}</Badge>}
    >
      <div className="space-y-3">
        <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
          开启后会先从混合音轨中提取对话人声，适合对话与背景音乐重叠的素材；处理可能明显变慢，歌曲人声未必能过滤。
        </p>
        <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
          分离模型约 871 MB，推荐使用 NVIDIA CUDA；CPU 处理会明显更慢。组件缺失时任务会明确失败，不会静默改用原混音。
        </p>
        <div role="group" aria-label="对话人声分离" className="grid gap-2 sm:grid-cols-2">
          {(["off", "on"] as const).map((value) => (
            <Button
              key={value}
              variant={controller.asrVocalSeparation === value ? "primary" : "outline"}
              disabled={!isDesktopRuntime() || !controller.asrSettingsLoaded || busy}
              aria-pressed={controller.asrVocalSeparation === value}
              onClick={() => void controller.saveAsrVocalSeparation(value)}
            >
              {value === "off" ? "关闭" : "开启"}
            </Button>
          ))}
        </div>
        {controller.asrVocalSeparationMessage ? (
          <p
            role={controller.asrVocalSeparationError ? "alert" : "status"}
            className={`text-[11.5px] leading-5 ${controller.asrVocalSeparationError ? "text-stop" : "text-[var(--color-text-muted)]"}`}
          >
            {controller.asrVocalSeparationMessage}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function AsrSongHandlingPanel({ controller }: { controller: ModelApiController }) {
  const filtering = controller.asrSongHandling === "filter";
  const classifier = controller.asrCapability?.songClassifier;
  const ready = classifier?.installState === "ready";
  const sharedRuntime = controller.asrCapability?.optionalRuntimes.find((runtime) => runtime.engineId === "qwen3-asr");
  const sharedRuntimeReady = sharedRuntime?.installState === "ready";
  const busy = controller.asrSongHandlingBusy || controller.asrModelBusy;
  const uninstallClassifier = async () => {
    if (filtering && !(await controller.saveAsrSongHandling("preserve"))) return;
    await controller.uninstallSongClassifier();
  };
  return (
    <Card
      data-testid="asr-song-handling-panel"
      title="歌曲与唱词处理"
      description="在 VAD 和语音识别之前识别歌曲/音乐区间"
      actions={<Badge tone={filtering ? (ready ? "green" : "red") : "gray"}>{filtering ? "过滤唱词" : "保留唱词"}</Badge>}
    >
      <div className="space-y-3">
        <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
          默认保留歌曲与唱词，不增加处理时间。选择过滤后，只静音持续至少 2 秒且置信度达到 70% 的音乐/歌唱区间；无法确定的区间仍会识别，并标记为“疑似唱词”供复核。
        </p>
        <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
          分类模型约 3.1 MiB，并复用已有本地 Python/CUDA 运行时。它不会过滤音乐下的明确对白，也不会保证识别所有歌唱类型。
        </p>
        <div role="group" aria-label="歌曲与唱词处理" className="grid gap-2 sm:grid-cols-2">
          <Button
            variant={!filtering ? "primary" : "outline"}
            disabled={!isDesktopRuntime() || !controller.asrSettingsLoaded || busy}
            aria-pressed={!filtering}
            onClick={() => void controller.saveAsrSongHandling("preserve")}
          >
            保留歌曲/唱词（默认）
          </Button>
          <Button
            variant={filtering ? "primary" : "outline"}
            disabled={!isDesktopRuntime() || !controller.asrSettingsLoaded || busy || !ready}
            aria-pressed={filtering}
            title={ready ? "过滤高置信度歌曲区间" : "请先安装唱词分类组件"}
            onClick={() => void controller.saveAsrSongHandling("filter")}
          >
            过滤高置信度唱词
          </Button>
        </div>
        {!ready ? (
          <div className="flex flex-wrap items-center gap-2">
            {sharedRuntimeReady ? (
              <Button variant="outline" disabled={busy} onClick={() => void controller.installSongClassifier()}>
                安装唱词分类组件（约 3.1 MiB）
              </Button>
            ) : (
              <Button variant="outline" disabled={busy} onClick={() => void controller.installAsrRuntime("qwen3-asr-transformers-cu128-x64")}>
                先安装共享 Python/CUDA runtime
              </Button>
            )}
            <span className="text-[11.5px] text-[var(--color-text-muted)]">
              {classifier?.installState === "corrupt" ? "组件校验失败，请重新安装。" : "过滤模式需要可选分类组件。"}
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="green">组件已校验</Badge>
            <span className="text-[11px] text-[var(--color-text-muted)]">MIT · {formatBinarySize(classifier.sizeBytes)}</span>
            <Button
              variant="danger"
              disabled={busy}
              title={filtering ? "卸载后会自动切换为保留歌曲/唱词" : "卸载唱词分类组件"}
              onClick={() => void uninstallClassifier()}
            >
              卸载分类组件
            </Button>
          </div>
        )}
        {controller.asrSongHandlingMessage ? (
          <p role={controller.asrSongHandlingError ? "alert" : "status"} className={`text-[11.5px] leading-5 ${controller.asrSongHandlingError ? "text-stop" : "text-[var(--color-text-muted)]"}`}>
            {controller.asrSongHandlingMessage}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

const VAD_PARAMETER_FIELDS = [
  { key: "threshold", label: "阈值", min: 0, max: 0.99, step: 0.01 },
  { key: "minSpeechDurationMs", label: "最短语音（ms）", min: 0, max: 60_000, step: 1 },
  { key: "minSilenceDurationMs", label: "最短静音（ms）", min: 0, max: 60_000, step: 1 },
  { key: "maxSpeechDurationSeconds", label: "最长语音（秒，0=无限制）", min: 0, max: 86_400, step: 0.1 },
  { key: "speechPadMs", label: "语音填充（ms）", min: 0, max: 60_000, step: 1 },
  { key: "samplesOverlapSeconds", label: "样本重叠（秒）", min: 0, max: 60, step: 0.01 },
] as const;

type VadPreset = "off" | "gentle" | "balanced" | "strong";

function AsrVadPresetButtons({
  activePreset,
  busy,
  onApply,
}: {
  activePreset: VadPreset | "custom";
  busy: boolean;
  onApply: (preset: VadPreset) => void;
}) {
  return (
    <div role="group" aria-label="背景音过滤强度" className="grid gap-2 sm:grid-cols-4">
      {(["off", "gentle", "balanced", "strong"] as const).map((preset) => (
        <Button
          key={preset}
          variant={activePreset === preset ? "primary" : "outline"}
          disabled={!isDesktopRuntime() || busy}
          aria-pressed={activePreset === preset}
          onClick={() => onApply(preset)}
        >
          {{ off: "关闭", gentle: "保守", balanced: "标准（推荐）", strong: "强力" }[preset]}
        </Button>
      ))}
    </div>
  );
}

function AsrVadPanel({ controller }: { controller: ModelApiController }) {
  const [draft, setDraft] = useState({ ...controller.asrVad.customParameters });
  const [showAdvanced, setShowAdvanced] = useState(controller.asrVad.mode === "custom");
  const model = controller.asrCapability?.vadModel;
  useEffect(() => setDraft({ ...controller.asrVad.customParameters }), [controller.asrVad.customParameters]);
  const effective = effectiveAsrVadParameters(controller.asrVad);
  const sameParameters = (left: typeof draft, right: typeof draft) =>
    VAD_PARAMETER_FIELDS.every(({ key }) => left[key] === right[key]);
  const activePreset = controller.asrVad.mode === "off"
    ? "off"
    : controller.asrVad.mode === "auto"
      ? "balanced"
      : sameParameters(controller.asrVad.customParameters, ASR_VAD_PRESET_PARAMETERS.gentle)
        ? "gentle"
        : sameParameters(controller.asrVad.customParameters, ASR_VAD_PRESET_PARAMETERS.strong)
          ? "strong"
          : "custom";
  const applyPreset = (preset: VadPreset) => {
    if (preset === "off") {
      void controller.saveAsrVad({ ...controller.asrVad, mode: "off" });
      return;
    }
    const customParameters = { ...ASR_VAD_PRESET_PARAMETERS[preset] };
    setDraft(customParameters);
    void controller.saveAsrVad({
      mode: preset === "balanced" ? "auto" : "custom",
      customParameters,
    });
  };
  return (
    <Card
      data-testid="asr-vad-panel"
      title="背景音过滤（VAD）"
      description={`Whisper 与 Qwen 共用 Silero v6.2.0 · ${installStateLabel(model?.installState)}`}
      actions={
        <Badge tone={model?.installState === "ready" || controller.asrVad.mode === "off" ? "green" : "red"}>
          {{ off: "已关闭", gentle: "保守过滤", balanced: "标准过滤", strong: "强力过滤", custom: "自定义" }[activePreset]}
        </Badge>
      }
    >
      <div className="space-y-3">
      <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        只把检测为人声的区间送入识别，可减少纯音乐和环境声产生的无效字幕；对话与音乐重叠时仍会保留对话，不会承诺消除歌曲人声。
      </p>
      <AsrVadPresetButtons activePreset={activePreset} busy={controller.asrVadBusy} onApply={applyPreset} />
      <Button variant={activePreset === "custom" ? "primary" : "ghost"} onClick={() => setShowAdvanced((value) => !value)}>
        {showAdvanced ? "收起高级参数" : "高级参数"}
      </Button>
      {showAdvanced ? (
        <div className="grid gap-2 rounded-[6px] border border-line bg-card-soft p-3 sm:grid-cols-2">
          <p id="asr-vad-custom-help" className="text-[11.5px] leading-5 text-[var(--color-text-muted)] sm:col-span-2">
            每个字段都受输入框声明的范围约束；超出范围时不会保存或启动识别。
          </p>
          {VAD_PARAMETER_FIELDS.map((field) => (
            <label key={field.key} className="block text-[11.5px] text-[var(--color-text-muted)]">
              <span className="mb-1 block">{field.label}</span>
              <input
                aria-label={`VAD ${field.label}`}
                aria-describedby="asr-vad-custom-help"
                aria-invalid={!Number.isFinite(draft[field.key]) || draft[field.key] < field.min || draft[field.key] > field.max || (field.step === 1 && !Number.isSafeInteger(draft[field.key]))}
                className={FIELD}
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={draft[field.key]}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  setDraft((current) => ({ ...current, [field.key]: value }));
                }}
              />
            </label>
          ))}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button
              variant="primary"
              disabled={!isDesktopRuntime() || controller.asrVadBusy}
              onClick={() => void controller.saveAsrVad({ mode: "custom", customParameters: draft })}
            >
              保存自定义参数
            </Button>
            <Button variant="ghost" disabled={controller.asrVadBusy} onClick={() => setDraft({ ...ASR_VAD_RECOMMENDED_PARAMETERS })}>
              恢复推荐值
            </Button>
          </div>
        </div>
      ) : null}
      <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        {effective
          ? <>实际生效：阈值 {effective.threshold} · 语音/静音 {effective.minSpeechDurationMs}/{effective.minSilenceDurationMs} ms · 最长语音 {effective.maxSpeechDurationSeconds === 0 ? "无限制" : `${effective.maxSpeechDurationSeconds} 秒`} · 填充 {effective.speechPadMs} ms · 重叠 {effective.samplesOverlapSeconds} 秒</>
          : <>实际生效：VAD 关闭；识别后的 PCM 静音边界校正仍保留。</>}
      </p>
      {controller.asrVad.mode !== "off" && model?.installState !== "ready" ? (
        <p role="alert" className="text-[11.5px] leading-5 text-stop">
          VAD 辅助资源缺失或校验失败；重启应用会尝试从随包副本修复，也可先切换为“关闭”继续识别。
        </p>
      ) : null}
      {model?.modelHash ? <p className="break-any text-[11px] text-[var(--color-text-muted)]">verified hash: {model.modelHash}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" disabled={!isDesktopRuntime()} onClick={() => void controller.openAsrInfo("vad-source")}>VAD 来源</Button>
        <Button variant="ghost" disabled={!isDesktopRuntime()} onClick={() => void controller.openAsrInfo("vad-license")}>VAD 许可证</Button>
      </div>
      <p
        role={controller.asrVadError ? "alert" : "status"}
        className={`text-[11.5px] leading-5 ${controller.asrVadError ? "text-stop" : "text-[var(--color-text-muted)]"}`}
      >
        {controller.asrVadMessage}
      </p>
      {controller.asrModelMessageArea === "vad" ? (
        <p
          role={controller.asrModelError ? "alert" : "status"}
          className={`text-[11.5px] leading-5 ${controller.asrModelError ? "text-stop" : "text-[var(--color-text-muted)]"}`}
        >
          {controller.asrModelMessage}
        </p>
      ) : null}
      </div>
    </Card>
  );
}

function formatBinarySize(sizeBytes?: number) {
  return sizeBytes ? `${Math.round(sizeBytes / 1024 / 1024)} MiB` : "大小待校验";
}

function AsrCurrentConfiguration({ controller }: { controller: ModelApiController }) {
  const capability = controller.asrCapability;
  const model = capability?.models.find((entry) => entry.id === controller.asrDefaultModelId);
  const qwen = model?.engineId === "qwen3-asr";
  const cuda = capability?.optionalRuntimes.find((runtime) => runtime.device === "cuda" &&
    (runtime.engineId ?? "whisper.cpp") === (qwen ? "qwen3-asr" : "whisper.cpp"));
  const modelInstalled = model?.installState === "ready";
  const modelInstallProblem = model?.installState === "corrupt" || model?.installState === "incompatible";
  const vadReady = controller.asrVad.mode === "off" || (
    capability?.vadModel?.installState === "ready" && (!qwen || capability?.runtime.installState === "ready")
  );
  const requested = controller.asrDeviceStatus?.requestedDevice ?? "auto";
  const cudaRequired = qwen || (requested === "cuda" && !controller.asrDeviceStatus?.allowCudaFallback);
  const cudaReady = cuda?.installState === "ready";
  const runtimeReady = qwen ? cudaReady && capability?.qwenAligner?.installState === "ready" : capability?.runtime.installState === "ready";
  const songReady = controller.asrSongHandling !== "filter" || capability?.songClassifier?.installState === "ready";
  const ready = !controller.asrCapabilityError && controller.asrSettingsLoaded && Boolean(controller.asrDeviceStatus) && runtimeReady && model?.installState === "ready" && vadReady && songReady && (!cudaRequired || cudaReady);
  const requestedDevice = ({ auto: "Auto", cpu: "CPU", cuda: "CUDA" } as const)[requested];
  const vadMode = ({ auto: "自动", off: "关闭", custom: "自定义" } as const)[controller.asrVad.mode];
  const vocalSeparation = controller.asrVocalSeparation === "on" ? "开启" : "关闭";
  const songHandling = controller.asrSongHandling === "filter" ? "过滤高置信度唱词" : "保留唱词";
  const actualDevice = controller.asrDeviceStatus?.actualDevice;
  return (
    <Card
      data-testid="asr-current-config"
      title="当前配置"
      actions={
        <>
          <ShieldCheck size={14} className="text-gold-dark" />
          <Badge tone={ready ? "green" : "gold"}>{ready ? "已就绪" : "尚未就绪"}</Badge>
        </>
      }
      dense
    >
      <p className="text-[13px] font-medium text-[var(--color-text-main)]">
        {model?.engineId ?? "whisper.cpp"} · {model?.displayName ?? controller.asrDefaultModelId} · 请求设备 {qwen ? "CUDA" : requestedDevice} · 人声分离 {vocalSeparation} · 唱词 {songHandling} · VAD {vadMode}
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <div data-state-kind="selected" className="flex min-w-0 items-center gap-2 rounded-[6px] bg-gold-wash px-2.5 py-1.5">
          <Badge tone="gold">已选择</Badge>
          <span className="min-w-0 truncate text-[11.5px] text-[var(--color-text-main)]" title={model?.displayName ?? controller.asrDefaultModelId}>
            {model?.displayName ?? controller.asrDefaultModelId}
          </span>
        </div>
        <div data-state-kind="installed" className="flex min-w-0 items-center gap-2 rounded-[6px] bg-card-soft px-2.5 py-1.5">
          <Badge tone={modelInstalled ? "green" : modelInstallProblem ? "red" : "gray"}>{modelInstalled ? "已安装" : installStateLabel(model?.installState, model?.reason)}</Badge>
          <span className="min-w-0 truncate text-[11.5px] text-[var(--color-text-muted)]" title={installStateDescription(model?.installState, model?.reason)}>{installStateDescription(model?.installState, model?.reason)}</span>
        </div>
        <div data-state-kind="actual" className="flex min-w-0 items-center gap-2 rounded-[6px] bg-card-soft px-2.5 py-1.5">
          <Badge tone={actualDevice ? "blue" : "gray"}>实际运行</Badge>
          <span className="min-w-0 truncate text-[11.5px] text-[var(--color-text-muted)]">
            {actualDevice ? `${actualDevice.toUpperCase()} · 模型见项目记录` : "尚无运行记录"}
          </span>
        </div>
      </div>
      {controller.asrSettingsError ? (
        <p role="alert" className="mt-2 text-[11.5px] leading-5 text-stop">{controller.asrSettingsError}</p>
      ) : !controller.asrSettingsLoaded ? (
        <p role="status" className="mt-2 text-[11.5px] leading-5 text-[var(--color-text-muted)]">正在读取全局 ASR 设置。</p>
      ) : null}
    </Card>
  );
}

function AsrModelSelector({ controller }: { controller: ModelApiController }) {
  const models = controller.asrCapability?.models ?? [];
  return (
    <Card
      data-testid="asr-model-selector"
      title="选择模型"
      description="按家族比较，再在卡片内选择变体；选择不会自动下载。"
      dense
    >
      <div role="radiogroup" aria-label="全局默认 ASR 模型" className="grid items-start gap-2 lg:grid-cols-4">
        {ASR_MODEL_FAMILIES.map((family) => (
          <div
            key={family.id}
            role="group"
            aria-label={`${family.label} 模型变体`}
            className="min-w-0 rounded-[7px] border border-line bg-card-soft p-2.5"
          >
            <div className="mb-2 flex items-center gap-2">
              <p className="text-[12.5px] font-semibold text-[var(--color-text-main)]">{family.label}</p>
              <Badge tone={family.id === "large-v3-turbo" ? "gold" : "gray"}>{family.note}</Badge>
            </div>
            <div className="space-y-1.5">
              {models.filter((entry) => entry.family === family.id).map((entry) => {
                const selected = entry.id === controller.asrDefaultModelId;
                return (
                  <label
                    key={entry.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-[6px] border px-2.5 py-2 transition focus-within:border-gold focus-within:ring-2 focus-within:ring-gold ${selected ? "border-gold bg-gold-wash" : "border-line bg-card hover:border-gold"}`}
                  >
                    <input
                      className="sr-only"
                      type="radio"
                      name="asr-default-model"
                      value={entry.id}
                      aria-label={`全局默认 ASR 模型：${entry.displayName}`}
                      checked={selected}
                      disabled={!isDesktopRuntime() || controller.asrModelBusy}
                      onChange={(event) => event.currentTarget.checked && void controller.selectAsrModel(entry.id as typeof controller.asrDefaultModelId)}
                    />
                    <span className="shrink-0 text-[12.5px] font-medium text-[var(--color-text-main)]">{ASR_VARIANT_LABELS[entry.variant]}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{formatBinarySize(entry.sizeBytes)}</span>
                    <Badge tone={entry.installState === "ready" ? "green" : entry.installState === "corrupt" || entry.installState === "incompatible" ? "red" : "gray"}>{installStateLabel(entry.installState, entry.reason)}</Badge>
                    {selected ? <Badge tone="gold">已选择</Badge> : null}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {controller.asrModelSelectionMessage ? (
        <p
          role={controller.asrModelSelectionError ? "alert" : "status"}
          className={`mt-2 text-[11.5px] leading-5 ${controller.asrModelSelectionError ? "text-stop" : "text-[var(--color-text-muted)]"}`}
        >
          {controller.asrModelSelectionMessage}
        </p>
      ) : null}
    </Card>
  );
}

function AsrComponentStatus({ controller }: { controller: ModelApiController }) {
  const capability = controller.asrCapability;
  const model = capability?.models.find((entry) => entry.id === controller.asrDefaultModelId);
  const qwen = model?.engineId === "qwen3-asr";
  const cuda = capability?.optionalRuntimes.find((runtime) => runtime.device === "cuda" &&
    (runtime.engineId ?? "whisper.cpp") === (qwen ? "qwen3-asr" : "whisper.cpp"));
  return (
    <Card
      data-testid="asr-component-status"
      title="本地组件状态"
      description="运行时与当前所选模型分别校验。"
      dense
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-[6px] border border-line bg-card-soft px-2.5 py-2">
          <p className="text-[12.5px] font-medium text-[var(--color-text-main)]">CPU runtime</p>
          <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">{installStateLabel(capability?.runtime.installState, capability?.runtime.reason)}</p>
          <p className="mt-1 truncate text-[10.5px] text-[var(--color-text-muted)]" title="whisper-cpp-cpu-x64">whisper-cpp-cpu-x64</p>
        </div>
        <div className="min-w-0 rounded-[6px] border border-line bg-card-soft px-2.5 py-2">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--color-text-main)]">当前模型</p>
            <Badge tone={model?.installState === "ready" ? "green" : model?.installState === "corrupt" || model?.installState === "incompatible" ? "red" : "gray"}>{installStateLabel(model?.installState, model?.reason)}</Badge>
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-[var(--color-text-muted)]" title={model?.displayName ?? controller.asrDefaultModelId}>{model?.displayName ?? controller.asrDefaultModelId} · {formatBinarySize(model?.sizeBytes)}</p>
          <p className="mt-1 text-[10.5px] leading-4 text-[var(--color-text-muted)]">{installStateDescription(model?.installState, model?.reason)}</p>
          <p className="break-all mt-1 text-[10.5px] leading-4 text-[var(--color-text-muted)]">清单期望大小：{model?.sizeBytes ?? 0} bytes · 清单 SHA-256：{model?.modelHash ?? "未知"}</p>
        </div>
        <div className="rounded-[6px] border border-line bg-card-soft px-2.5 py-2">
          <p className="text-[12.5px] font-medium text-[var(--color-text-main)]">{qwen ? "Qwen CUDA runtime" : "CUDA runtime"}</p>
          <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">{installStateLabel(cuda?.installState, cuda?.reason)}</p>
          <p className="mt-1 truncate text-[10.5px] text-[var(--color-text-muted)]" title={cuda?.id}>{cuda?.id ?? (qwen ? "qwen3-asr-transformers-cu128-x64" : "whisper-cpp-cuda-12.4-x64")}</p>
        </div>
      </div>
      <p
        role={controller.asrCapabilityError ? "alert" : "status"}
        className={`mt-2 text-[11.5px] leading-5 ${controller.asrCapabilityError ? "text-stop" : "text-[var(--color-text-muted)]"}`}
      >
        {controller.asrCapabilityMessage}
      </p>
    </Card>
  );
}

function AsrMaintenancePanel({ controller }: { controller: ModelApiController }) {
  return (
    <Card
      data-testid="asr-maintenance-panel"
      title="模型下载与维护"
      description="下方操作直接作用于上方已选择的全局模型。"
    >
      <AsrAssetActions controller={controller} />
    </Card>
  );
}

function AsrWorkspace({ controller }: { controller: ModelApiController }) {
  return (
    <div data-testid="asr-model-page" className="space-y-3">
      <AsrCurrentConfiguration controller={controller} />
      <ProviderGrid controller={controller} />
      <AsrModelSelector controller={controller} />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <AsrComponentStatus controller={controller} />
        <AsrDevicePanel controller={controller} />
      </div>
      <AsrMaintenancePanel controller={controller} />
      <AsrVocalSeparationPanel controller={controller} />
      <AsrSongHandlingPanel controller={controller} />
      <AsrVadPanel controller={controller} />
    </div>
  );
}

export function ModelApiView({ controller }: { controller: ModelApiController }) {
  const isAsrTab = controller.tab === "语音识别模型";
  return (
    <>
      <PageHeader
        title="模型与连接"
        description={isAsrTab ? "管理本地识别引擎、模型、计算设备与语音活动检测。" : "填入接口地址与 API Key，拉取模型后测试连接。"}
        actions={<Tabs items={["翻译模型", "语音识别模型"]} value={controller.tab} onChange={controller.setTab} />}
      />
      {isAsrTab ? (
        <AsrWorkspace controller={controller} />
      ) : (
        <div className="space-y-4">
          <ProviderGrid controller={controller} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <ConnectionCard controller={controller} />
            <ConnectionStatusCard controller={controller} />
          </div>
        </div>
      )}
    </>
  );
}
