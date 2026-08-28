import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { allowsFreeFormModelId } from "../../shared/provider-registry.mjs";
import type {
  AsrCapabilityStatusResponse,
  AsrModelId,
  AsrRuntimeCapability,
  AsrVadSettings,
} from "../contracts/desktop-api";
import { useModelApiController } from "../controllers/model-api-controller";
import { useFrontend } from "./state";
import { Icon } from "./visuals";

type ProviderConfirmation = "fetch-models" | "test-connection" | "delete-credential" | null;
type OptionalRuntimeId = "whisper-cpp-cuda-12.4-x64" | "qwen3-asr-transformers-cu128-x64";
type AsrConfirmation =
  | { kind: "download-model" | "remove-model"; assetId: AsrModelId }
  | { kind: "download-runtime" | "remove-runtime"; assetId: OptionalRuntimeId }
  | { kind: "download-song" | "remove-song" }
  | null;

function statusLabel(value: string | undefined) {
  return ({
    ready: "可用",
    attention: "待配置",
    offline: "离线",
    unavailable: "不可用",
    untested: "未测试",
    failed: "失败",
    not_installed: "未安装",
    installing: "处理中",
    corrupt: "校验失败",
    incompatible: "不兼容",
  } as Record<string, string>)[value ?? ""] ?? value ?? "读取中";
}

function stateTone(value: string | undefined) {
  if (value === "ready") return "done";
  if (value === "failed" || value === "corrupt" || value === "incompatible" || value === "unavailable") return "danger";
  if (value === "installing") return "running";
  return "waiting";
}

function formatBytes(value: number | undefined) {
  if (!value || value < 1) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current >= 10 || unit === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[unit]}`;
}

/**
 * 核心 CPU 运行时随安装包交付，没有用户可执行的安装动作——所以这里不摆一个点了
 * 没反应的下载按钮，而是说清它为什么是这个状态、以及真正能解决问题的动作是什么。
 * 原来那句开发者黑话对用户没有任何信息量。
 */
function coreRuntimeNote(runtime: AsrRuntimeCapability | undefined) {
  const ready = runtime?.installState === "ready";
  if (ready) return "语音识别的核心运行时，随应用安装包交付，已就位。";
  if (runtime?.installState === "incompatible") return "随包交付的核心运行时与当前引擎版本不匹配，请安装与本应用配套的版本。";
  if (runtime?.bundled) return "核心运行时应当随安装包一起交付，现在却缺失或损坏——说明这份安装不完整。重新安装应用即可恢复；不需要你单独下载。";
  return "当前运行的是未打包的开发版，核心运行时只在正式安装包里交付，所以本机识别不可用。正式版无需任何额外下载。";
}

function optionalRuntimeId(value: string): OptionalRuntimeId | null {
  return value === "whisper-cpp-cuda-12.4-x64" || value === "qwen3-asr-transformers-cu128-x64" ? value : null;
}

interface AsrNextStep {
  title: string;
  detail: string;
  action: { label: string; confirmation: AsrConfirmation } | null;
}

/**
 * 从"本地语音识别尚未就绪"跳到这一页的用户面对的是五块并排的面板，下载按钮藏在模型清单
 * 第五列，而且清单里有好几个模型——他没法知道该装哪一个。这里把 capability.ready 为假的
 * 原因翻译成一句"下一步做什么"，并且只给一个动作。
 */
function asrNextStep(capability: AsrCapabilityStatusResponse | null, defaultModelId: string): AsrNextStep | null {
  if (!capability || capability.ready) return null;
  if (capability.runtime.installState !== "ready") {
    return { title: "核心运行时不可用，先装模型也没用", detail: coreRuntimeNote(capability.runtime), action: null };
  }
  // capability.model 的声明类型不带 engineId/displayName/sizeBytes，从目录里取同一条。
  const model = capability.models.find((entry) => entry.id === defaultModelId);
  if (!model) {
    return {
      title: "默认模型不在后端目录里",
      detail: `设置里记的默认模型是 ${defaultModelId}，但后端返回的模型清单里没有它。请在下面的模型清单里重新选一个默认模型。`,
      action: null,
    };
  }
  if (model.installState !== "ready") {
    const qwen = model.engineId === "qwen3-asr"
      ? capability.optionalRuntimes.find((runtime) => runtime.engineId === "qwen3-asr")
      : undefined;
    if (qwen && qwen.installState !== "ready") {
      const assetId = optionalRuntimeId(qwen.id);
      return {
        title: `下一步：安装 ${qwen.id}`,
        detail: `默认模型 ${model.id} 跑在 Qwen3 引擎上，需要先装它的运行时，再装模型。下载会从官方源取件并逐个校验。`,
        action: assetId ? { label: "下载运行时", confirmation: { kind: "download-runtime", assetId } } : null,
      };
    }
    return {
      title: `下一步：下载默认模型 ${model.displayName}`,
      detail: `本机识别需要一份模型文件，当前默认是 ${model.id}（约 ${formatBytes(model.sizeBytes)}）。下载并校验完成后就能开始转写。想省流量可以在下面的模型清单里换一个更小的，或者用“本地导入”指向已经下好的文件。`,
      action: { label: "下载并校验", confirmation: { kind: "download-model", assetId: model.id as AsrModelId } },
    };
  }
  const aligner = capability.qwenAligner;
  if (model.engineId === "qwen3-asr" && aligner && aligner.installState !== "ready") {
    const qwen = capability.optionalRuntimes.find((runtime) => runtime.engineId === "qwen3-asr");
    const assetId = qwen ? optionalRuntimeId(qwen.id) : null;
    return {
      title: "下一步：补齐 Qwen3 对齐组件",
      detail: `模型已就位，但对齐组件 ${aligner.id} 还是“${statusLabel(aligner.installState)}”，缺它无法产出时间轴。它随 Qwen3 运行时一起安装。`,
      action: assetId ? { label: "重新安装运行时", confirmation: { kind: "download-runtime", assetId } } : null,
    };
  }
  return {
    title: "还有组件没有就绪",
    detail: "后端报告本机识别栈不完整，但没有指向某个可下载的组件。请看下面各面板的状态列，或重新检测设备。",
    action: null,
  };
}

function Feedback({ message, error }: { message: string; error: boolean }) {
  if (!message) return null;
  return <div className={`capability-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}><Icon name={error ? "warning" : "check"}/><span>{message}</span></div>;
}

export function ProviderPage() {
  const app = useFrontend();
  const navigate = useNavigate();
  const controller = useModelApiController();
  const [confirmation, setConfirmation] = useState<ProviderConfirmation>(null);
  const [secretPending, setSecretPending] = useState(false);
  const definition = controller.providerDefinition;
  const provider = controller.selectedProvider;
  const enabled = Boolean(definition?.v1TranslationEnabled && app.desktopAvailable);
  const freeFormModel = Boolean(definition && allowsFreeFormModelId(definition.profile));

  useEffect(() => controller.setTab("翻译模型"), []);
  useEffect(() => setSecretPending(false), [definition?.id]);

  const runConfirmed = async () => {
    const action = confirmation;
    setConfirmation(null);
    if (action === "fetch-models") {
      await controller.fetchModels();
      setSecretPending(false);
    }
    if (action === "test-connection" && await controller.saveConfiguration()) {
      setSecretPending(false);
      await controller.testConnection();
    }
    if (action === "delete-credential") {
      await controller.deleteCredential();
      setSecretPending(false);
    }
  };

  const saveConfiguration = async () => {
    if (await controller.saveConfiguration()) setSecretPending(false);
  };

  const confirmationCopy = confirmation === "delete-credential"
    ? { title: "删除已保存的 API Key？", text: "密钥会从系统安全凭据中移除；现有项目配置仍保留，但之后无法调用此 Provider。", label: "确认删除" }
    : confirmation === "fetch-models"
      ? { title: "连接 Provider 拉取模型？", text: `将向 ${definition?.name ?? "当前 Provider"} 发送一次联网请求，并可能保存输入框中的新 API Key。不会开始翻译，但服务商可能记录或限制该请求。`, label: "确认并拉取" }
      : { title: "测试真实 Provider 连接？", text: `将使用当前 API Key、接口地址和模型连接 ${definition?.name ?? "当前 Provider"}。测试可能消耗服务商额度或产生少量费用。`, label: "确认并测试" };

  return (
    <div className="page-stage capability-page secondary-page" data-fr03-view="provider-maintenance">
      <header className="page-header"><div><button type="button" className="back-button" onClick={() => navigate("/system")}><Icon name="arrow"/> 返回系统</button><h1>翻译 Provider</h1><p>凭据只进入系统安全存储；模型目录、连接状态与可用性均来自真实桌面后端。</p></div><span className={`state-tag ${stateTone(controller.connectionStatus)}`}>{statusLabel(controller.connectionStatus)}</span></header>

      <div className="capability-layout provider-layout">
        <aside className="production-panel capability-rail" aria-label="Provider 列表">
          <header><span>可用 Provider</span><strong>翻译服务</strong></header>
          <div className="capability-rail-list">{controller.visibleProviders.map((item) => <button type="button" key={item.id} className={item.id === controller.selectedProviderId ? "is-active" : ""} onClick={() => { controller.setSelectedProviderId(item.id); app.play("click"); }}><i className={`capability-lamp ${stateTone(item.status)}`}/><span><strong>{item.name}</strong><small>{item.summary}</small></span><em>{statusLabel(item.status)}</em></button>)}</div>
        </aside>

        <section className="production-panel capability-sheet">
          <header className="capability-sheet-head"><div><span>凭据与连接</span><h2>{definition?.name ?? "没有可配置的 Provider"}</h2></div><div className="capability-badges"><span className={`state-tag ${definition?.v1TranslationEnabled ? "done" : "danger"}`}>{definition?.v1TranslationEnabled ? "V1 已接入" : "仅保留能力记录"}</span><span className={`state-tag ${controller.credentialConfigured ? "done" : "waiting"}`}>{controller.credentialConfigured ? "凭据已保存" : "缺少凭据"}</span></div></header>

          {!definition ? <div className="production-empty panel-empty"><span className="empty-seal">00</span><div><strong>后端没有返回 Provider</strong><p>请重新读取桌面后端的 Provider 列表。</p></div></div> : <>
            {!definition.v1TranslationEnabled ? <div className="runtime-alert"><Icon name="warning"/><div><strong>当前版本不可调用</strong><p>{definition.unavailableReason ?? provider?.unavailableReason ?? "后端尚未实现此 Provider。"}</p></div></div> : null}
            <div className="provider-form-grid">
              <label className="field-wide"><span>接口地址</span><input value={controller.baseUrl} onChange={(event) => controller.setBaseUrl(event.target.value)} readOnly={definition.profile !== "openai_compatible_custom"} disabled={!definition.v1TranslationEnabled || !app.desktopAvailable} placeholder="https://…"/><small>{definition.profile === "openai_compatible_custom" ? "自定义兼容服务允许修改；后端仍会校验协议和地址。" : "注册表固定入口，界面不会把它伪装成可编辑。"}</small></label>
              <label><span>API Key</span><input ref={controller.secretInputRef} type="password" autoComplete="new-password" onChange={(event) => setSecretPending(Boolean(event.currentTarget.value))} disabled={!definition.v1TranslationEnabled || !app.desktopAvailable} placeholder={controller.credentialConfigured ? "已安全保存；留空保持不变" : "输入后保存到系统安全凭据"}/><small>{secretPending ? "新 Key 尚未保存；只记录待保存状态，不读取或回显内容。" : "密钥不进入 React 状态，也不会回显。"}</small></label>
              <label><span>模型 ID</span>{freeFormModel ? <><input list="provider-model-options" value={controller.selectedModel} onChange={(event) => controller.setSelectedModel(event.target.value)} disabled={!definition.v1TranslationEnabled || !app.desktopAvailable} placeholder="选择或填写真实模型 ID"/><datalist id="provider-model-options">{controller.modelOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist></> : <select value={controller.selectedModel} onChange={(event) => controller.setSelectedModel(event.target.value)} disabled={!definition.v1TranslationEnabled || !app.desktopAvailable}>{controller.modelOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select>}<small>{controller.modelsFetched ? "当前列表来自 Provider 实时返回。" : "当前为注册表兜底列表，可先联网拉取。"}</small></label>
              <div className="provider-protocol-card"><span>传输协议</span><strong>{definition.defaultTransport ?? "未接入"}</strong><small>{definition.supportedTransports.length ? definition.supportedTransports.join(" / ") : "没有可用传输"}</small></div>
              <div className="provider-protocol-card"><span>参数边界</span><strong>{definition.supportedParameters.length || 0} 项</strong><small>{definition.supportedParameters.join(" · ") || "后端未开放参数"}</small></div>
            </div>
            {controller.modelWarning ? <div className="field-warning"><Icon name="warning"/><span>{controller.modelWarning}</span></div> : null}
            <Feedback message={controller.modelsMessage} error={/失败|错误|请先|没有返回/.test(controller.modelsMessage)}/>
            <Feedback message={controller.connectionMessage} error={controller.connectionStatus === "failed"}/>
            <footer className="capability-actions"><div><button type="button" className="text-button danger-link" onClick={() => setConfirmation("delete-credential")} disabled={!controller.credentialConfigured || controller.connectionBusy}>删除凭据</button>{controller.latencyMs !== null ? <span>最近测试 {controller.latencyMs} ms</span> : null}</div><div><button type="button" className="btn btn-secondary" onClick={() => setConfirmation("fetch-models")} disabled={!enabled || controller.modelsBusy} title={!app.desktopAvailable ? "仅桌面应用可用" : !definition.v1TranslationEnabled ? definition.unavailableReason : undefined}>{controller.modelsBusy ? "正在拉取" : "拉取真实模型"}</button><button type="button" className="btn btn-secondary" onClick={() => void saveConfiguration()} disabled={!enabled || controller.connectionBusy}>保存配置</button><button type="button" className="btn btn-primary" onClick={() => setConfirmation("test-connection")} disabled={!enabled || controller.connectionBusy || Boolean(controller.modelWarning)}>{controller.connectionBusy ? "测试中" : "测试真实连接"}</button></div></footer>
          </>}
        </section>
      </div>

      {confirmation ? <div className="production-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConfirmation(null); }}><section className="production-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-confirm-title"><span className="dialog-seal"><Icon name="warning"/></span><div><h2 id="provider-confirm-title">{confirmationCopy.title}</h2><p>{confirmationCopy.text}</p></div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setConfirmation(null)}>取消</button><button type="button" className="btn btn-primary" onClick={() => void runConfirmed()}>{confirmationCopy.label}</button></div></section></div> : null}
    </div>
  );
}

const vadFields: Array<{ key: keyof AsrVadSettings["customParameters"]; label: string; min: number; max: number; step: number; unit: string }> = [
  { key: "threshold", label: "检测阈值", min: 0.05, max: 0.95, step: 0.05, unit: "" },
  { key: "minSpeechDurationMs", label: "最短语音", min: 0, max: 5000, step: 50, unit: "ms" },
  { key: "minSilenceDurationMs", label: "最短静音", min: 0, max: 5000, step: 50, unit: "ms" },
  { key: "maxSpeechDurationSeconds", label: "最长语音", min: 1, max: 600, step: 1, unit: "s" },
  { key: "speechPadMs", label: "语音边距", min: 0, max: 2000, step: 10, unit: "ms" },
  { key: "samplesOverlapSeconds", label: "分片重叠", min: 0, max: 30, step: 0.1, unit: "s" },
];

export function AsrMaintenancePage() {
  const app = useFrontend();
  const navigate = useNavigate();
  const controller = useModelApiController();
  const [confirmation, setConfirmation] = useState<AsrConfirmation>(null);
  const [vadDraft, setVadDraft] = useState<AsrVadSettings>(controller.asrVad);
  const capability = controller.asrCapability;
  const device = controller.asrDeviceStatus;
  const classifierReady = capability?.songClassifier?.installState === "ready";
  const nextStep = useMemo(
    () => asrNextStep(capability, controller.asrDefaultModelId),
    [capability, controller.asrDefaultModelId],
  );
  const persistedVadSignature = JSON.stringify(controller.asrVad);

  useEffect(() => setVadDraft(controller.asrVad), [persistedVadSignature]);

  const executeConfirmed = async () => {
    const action = confirmation;
    setConfirmation(null);
    if (!action) return;
    if (action.kind === "download-model") await controller.installAsrModel(action.assetId, "auto");
    if (action.kind === "remove-model") await controller.uninstallAsrModel(action.assetId);
    if (action.kind === "download-runtime") await controller.installAsrRuntime(action.assetId);
    if (action.kind === "remove-runtime") await controller.uninstallAsrRuntime(action.assetId);
    if (action.kind === "download-song") await controller.installSongClassifier();
    if (action.kind === "remove-song") await controller.uninstallSongClassifier();
  };

  const confirmationCopy = useMemo(() => {
    if (!confirmation) return { title: "", text: "", label: "" };
    if (confirmation.kind === "download-model") return { title: `下载模型 ${confirmation.assetId}？`, text: "将从后端选择的健康源下载并校验真实模型文件，可能占用较多网络流量和磁盘空间；可在处理中暂停。", label: "确认下载" };
    if (confirmation.kind === "download-runtime") return { title: "下载 CUDA 运行时？", text: "将从官方源下载并校验 CUDA 运行组件，文件可能较大；这不会自动切换设备偏好。", label: "确认下载" };
    if (confirmation.kind === "download-song") return { title: "下载唱词分类组件？", text: "将从官方源下载并校验本地分类模型，用于识别音乐、唱词和噪声。", label: "确认下载" };
    if (confirmation.kind === "remove-model") return { title: `卸载模型 ${confirmation.assetId}？`, text: "受信模型文件会从本机模型存储中移除；使用该模型的项目在重新安装前无法运行 ASR。", label: "确认卸载" };
    if (confirmation.kind === "remove-runtime") return { title: "卸载 CUDA 运行时？", text: "对应的 GPU 识别路径会变为不可用；已保存的项目和 CPU 运行时不会删除。", label: "确认卸载" };
    return { title: "卸载唱词分类组件？", text: "唱词过滤会恢复为不可用，已识别的字幕和项目数据不会删除。", label: "确认卸载" };
  }, [confirmation]);

  return (
    <div className="page-stage capability-page secondary-page asr-maintenance-page" data-fr03-view="asr-maintenance">
      <header className="page-header"><div><button type="button" className="back-button" onClick={() => navigate("/system")}><Icon name="arrow"/> 返回系统</button><h1>本地语音识别</h1><p>模型、运行时、设备和分段策略都读取并写回真实本机能力；下载只在明确确认后开始。</p></div><span className={`state-tag ${capability?.ready ? "done" : "waiting"}`}>{capability?.ready ? "核心能力可用" : "需要维护"}</span></header>

      {controller.asrCapabilityError || controller.asrSettingsError ? <div className="runtime-alert" role="alert"><Icon name="warning"/><div><strong>ASR 状态不完整</strong><p>{controller.asrSettingsError || controller.asrCapabilityMessage}</p></div></div> : null}
      {nextStep ? <section className="asr-next-step" data-fr03-next-step="asr"><span className="next-step-seal"><Icon name={nextStep.action ? "arrow" : "warning"}/></span><div><strong>{nextStep.title}</strong><p>{nextStep.detail}</p></div>{nextStep.action ? <button type="button" className="btn btn-primary" onClick={() => setConfirmation(nextStep.action!.confirmation)} disabled={!app.desktopAvailable || controller.asrModelBusy}>{controller.asrModelBusy ? "正在处理" : nextStep.action.label}</button> : null}</section> : null}
      <Feedback message={controller.asrModelMessageArea === "maintenance" ? controller.asrModelMessage : ""} error={controller.asrModelError}/>
      <Feedback message={controller.asrModelSelectionMessage} error={controller.asrModelSelectionError}/>

      <section className="production-panel asr-overview"><div><span>本机识别栈</span><h2>{capability ? `${capability.engineId} ${capability.engineVersion}` : "正在读取组件清单"}</h2><p>{controller.asrCapabilityMessage}</p></div><dl><div><dt>CPU runtime</dt><dd className={stateTone(capability?.runtime.installState)}>{statusLabel(capability?.runtime.installState)}</dd></div><div><dt>默认模型</dt><dd>{controller.asrDefaultModelId}</dd></div><div><dt>实际设备</dt><dd>{device?.actualDevice?.toUpperCase() ?? "尚未运行"}</dd></div><div><dt>设置</dt><dd>{controller.asrSettingsLoaded ? "已读取" : "读取中"}</dd></div></dl></section>

      <section className="production-panel asset-ledger"><header><div><span>模型清单</span><h2>识别模型</h2></div>{controller.asrModelBusy ? <button type="button" className="btn btn-secondary" onClick={() => void controller.cancelAsrAssetOperation()}>暂停当前操作</button> : <span>{capability?.models.length ?? 0} 个后端模型</span>}</header><div className="asset-ledger-head"><span>模型 / 引擎</span><span>大小 / 内存</span><span>设备</span><span>状态</span><span>动作</span></div>{capability?.models.map((model) => { const modelId = model.id as AsrModelId; const selected = controller.asrDefaultModelId === model.id; return <article key={model.id} className={selected ? "is-selected" : ""}><div><strong>{model.displayName}</strong><p>{model.id} · {model.engineId} {model.engineVersion} · {model.productStatus}</p><div className="asset-info-links"><button type="button" onClick={() => void controller.openAsrInfo("model-source", modelId)}>来源</button><button type="button" onClick={() => void controller.openAsrInfo("model-license", modelId)}>许可证 {model.license}</button></div></div><div><strong>{formatBytes(model.sizeBytes)}</strong><p>建议内存 {formatBytes(model.recommendedMemoryBytes)}{model.recommendedVramBytes ? ` · VRAM ${formatBytes(model.recommendedVramBytes)}` : ""}</p></div><span>{model.supportsCpu ? "CPU" : ""}{model.supportsCpu && model.supportsCuda ? " + " : ""}{model.supportsCuda ? "CUDA" : ""}</span><span className={`state-tag ${stateTone(model.installState)}`}>{statusLabel(model.installState)}</span><div className="asset-actions"><button type="button" className="text-button" onClick={() => void controller.selectAsrModel(modelId)} disabled={selected || !controller.asrSettingsLoaded}>{selected ? "默认" : "设为默认"}</button><button type="button" className="text-button" onClick={() => void controller.importAsrModel(modelId)} disabled={!app.desktopAvailable || controller.asrModelBusy}>本地导入</button>{model.installState === "ready" ? <button type="button" className="text-button danger-link" onClick={() => setConfirmation({ kind: "remove-model", assetId: modelId })} disabled={controller.asrModelBusy}>卸载</button> : <button type="button" className="btn btn-secondary" onClick={() => setConfirmation({ kind: "download-model", assetId: modelId })} disabled={!app.desktopAvailable || controller.asrModelBusy}>下载</button>}</div></article>; })}{!capability?.models.length ? <div className="production-empty panel-empty"><span className="empty-seal">00</span><div><strong>没有模型目录</strong><p>后端未返回模型时不会生成假条目。</p></div></div> : null}</section>

      <div className="asr-maintenance-grid">
        <section className="production-panel runtime-panel"><header><div><span>运行时与设备</span><h2>运行时与设备</h2></div><button type="button" className="btn btn-secondary" onClick={() => void controller.detectAsrDevices()} disabled={!app.desktopAvailable || controller.asrDeviceBusy}>{controller.asrDeviceBusy ? "检测中" : "检测设备"}</button></header><article className="runtime-primary"><div><strong>{capability?.runtime.id ?? "CPU runtime"}</strong><p>{coreRuntimeNote(capability?.runtime)}</p></div><span className={`state-tag ${stateTone(capability?.runtime.installState)}`}>{statusLabel(capability?.runtime.installState)}</span></article>{capability?.optionalRuntimes.map((runtime) => { const runtimeId = optionalRuntimeId(runtime.id); return <article key={runtime.id}><div><strong>{runtime.id}</strong><p>{runtime.engineId ?? "ASR"} · {runtime.version} · CUDA 可选组件</p></div><span className={`state-tag ${stateTone(runtime.installState)}`}>{statusLabel(runtime.installState)}</span><div className="asset-actions">{runtimeId ? <><button type="button" className="text-button" onClick={() => void controller.importAsrRuntime(runtimeId)} disabled={controller.asrModelBusy}>本地导入</button>{runtime.installState === "ready" ? <button type="button" className="text-button danger-link" onClick={() => setConfirmation({ kind: "remove-runtime", assetId: runtimeId })}>卸载</button> : <button type="button" className="text-button" onClick={() => setConfirmation({ kind: "download-runtime", assetId: runtimeId })}>下载</button>}</> : <span title="后端没有为该运行时开放维护动作">只读</span>}</div></article>; })}
          <div className="device-controls"><div className="segmented-control" role="group" aria-label="ASR 设备偏好">{(["auto", "cpu", "cuda"] as const).map((value) => <button type="button" key={value} className={device?.requestedDevice === value ? "is-active" : ""} onClick={() => void controller.selectAsrDevice(value)}>{value.toUpperCase()}</button>)}</div><label><input type="checkbox" checked={device?.allowCudaFallback ?? false} onChange={(event) => void controller.setAsrCudaFallback(event.target.checked)}/> CUDA 不可用时回退 CPU</label></div>
          <div className="device-readout"><div><span>CPU 检测</span><strong>{statusLabel(device?.detection.cpu.status)}</strong><small>{device?.detection.cpu.runtimeId ?? "未读取"}</small></div><div><span>CUDA 检测</span><strong>{statusLabel(device?.detection.cuda.status)}</strong><small>{device?.detection.cuda.reason ?? device?.detection.cuda.runtimeId ?? "未读取"}</small></div></div><Feedback message={controller.asrDeviceMessage} error={controller.asrDeviceError}/>{controller.asrDeviceBusy ? <button type="button" className="text-button" onClick={() => void controller.cancelAsrDeviceDetection()}>取消设备检测</button> : null}
        </section>

        <section className="production-panel classifier-panel"><header><div><span>人声与背景音</span><h2>人声与唱词</h2></div><span className={`state-tag ${stateTone(capability?.songClassifier?.installState)}`}>{statusLabel(capability?.songClassifier?.installState)}</span></header><article><div><strong>{capability?.songClassifier?.displayName ?? "INA Speech / Music / Noise"}</strong><p>{capability?.songClassifier?.id ?? "ina-speech-music-noise-v1"} · {formatBytes(capability?.songClassifier?.sizeBytes)}</p></div><div className="asset-actions">{classifierReady ? <button type="button" className="text-button danger-link" onClick={() => setConfirmation({ kind: "remove-song" })}>卸载</button> : <button type="button" className="btn btn-secondary" onClick={() => setConfirmation({ kind: "download-song" })} disabled={controller.asrModelBusy}>下载安装</button>}</div></article><div className="setting-block"><span>人声分离</span><div className="segmented-control">{(["off", "on"] as const).map((value) => <button type="button" key={value} className={controller.asrVocalSeparation === value ? "is-active" : ""} onClick={() => void controller.saveAsrVocalSeparation(value)} disabled={controller.asrVocalSeparationBusy}>{value === "on" ? "开启" : "关闭"}</button>)}</div><small>仅保存真实全局默认值；项目能否执行仍由后端能力检测决定。</small></div><div className="setting-block"><span>唱词处理</span><div className="segmented-control"><button type="button" className={controller.asrSongHandling === "preserve" ? "is-active" : ""} onClick={() => void controller.saveAsrSongHandling("preserve")}>保留</button><button type="button" className={controller.asrSongHandling === "filter" ? "is-active" : ""} onClick={() => void controller.saveAsrSongHandling("filter")} disabled={!classifierReady} title={classifierReady ? undefined : "先安装唱词分类组件"}>过滤</button></div><small>{classifierReady ? "分类组件已就绪，可选择过滤。" : "过滤不可用：先安装真实分类组件。"}</small></div><Feedback message={controller.asrVocalSeparationMessage || controller.asrSongHandlingMessage} error={controller.asrVocalSeparationError || controller.asrSongHandlingError}/>
        </section>
      </div>

      <section className="production-panel vad-panel"><header><div><span>分段策略</span><h2>VAD 语音分段</h2></div><div className="asset-info-links"><button type="button" onClick={() => void controller.openAsrInfo("vad-source")}>来源</button><button type="button" onClick={() => void controller.openAsrInfo("vad-license")}>许可证</button></div></header><div className="vad-mode-row"><div className="segmented-control">{(["auto", "off", "custom"] as const).map((mode) => <button type="button" key={mode} className={vadDraft.mode === mode ? "is-active" : ""} onClick={() => setVadDraft((current) => ({ ...current, mode }))}>{mode === "auto" ? "自动" : mode === "off" ? "关闭" : "自定义"}</button>)}</div><p>{capability?.vadModel ? `${capability.vadModel.displayName} · ${formatBytes(capability.vadModel.sizeBytes)} · ${statusLabel(capability.vadModel.installState)}` : "后端没有返回 VAD 模型状态"}</p></div>{vadDraft.mode === "custom" ? <div className="vad-fields">{vadFields.map((field) => <label key={field.key}><span>{field.label}</span><span className="numeric-field"><input type="number" min={field.min} max={field.max} step={field.step} value={vadDraft.customParameters[field.key]} onChange={(event) => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) setVadDraft((current) => ({ ...current, customParameters: { ...current.customParameters, [field.key]: value } })); }}/><em>{field.unit}</em></span><small>{field.min}–{field.max}{field.unit}</small></label>)}</div> : null}<footer><div><Feedback message={controller.asrModelMessageArea === "vad" ? controller.asrModelMessage : controller.asrVadMessage} error={controller.asrModelMessageArea === "vad" ? controller.asrModelError : controller.asrVadError}/></div><button type="button" className="btn btn-primary" onClick={() => void controller.saveAsrVad(vadDraft)} disabled={!controller.asrSettingsLoaded || controller.asrVadBusy}>保存 VAD 策略</button></footer></section>

      {confirmation ? <div className="production-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConfirmation(null); }}><section className="production-dialog" role="dialog" aria-modal="true" aria-labelledby="asr-confirm-title"><span className="dialog-seal"><Icon name="warning"/></span><div><h2 id="asr-confirm-title">{confirmationCopy.title}</h2><p>{confirmationCopy.text}</p></div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setConfirmation(null)}>取消</button><button type="button" className="btn btn-primary" onClick={() => void executeConfirmed()}>{confirmationCopy.label}</button></div></section></div> : null}
    </div>
  );
}
