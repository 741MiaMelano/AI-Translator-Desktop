import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  TRANSLATION_PROVIDER_CATALOG,
  allowsFreeFormModelId,
} from "../../shared/provider-registry.mjs";
import { DEFAULT_ASR_VAD_SETTINGS, normalizeAsrVadSettings } from "../../shared/asr-vad-config.mjs";
import {
  desktopDeleteCredential,
  desktopGetCredentialStatus,
  desktopGetAsrCapabilityStatus,
  desktopGetAsrDeviceStatus,
  desktopSetAsrDevicePreference,
  desktopDetectAsrDevices,
  desktopCancelAsrDeviceDetection,
  desktopInstallAsrModel,
  desktopImportAsrModel,
  desktopUninstallAsrModel,
  desktopCancelAsrModelOperation,
  desktopInstallAsrRuntime,
  desktopImportAsrRuntime,
  desktopUninstallAsrRuntime,
  desktopCancelAsrRuntimeOperation,
  desktopInstallAsrSongClassifier,
  desktopUninstallAsrSongClassifier,
  desktopCancelAsrSongClassifierOperation,
  desktopGetDownloadStatus,
  desktopGetAppSettings,
  desktopSaveAppSettings,
  desktopOpenAsrInfo,
  desktopGetProviderRuntimeState,
  desktopListProviderModels,
  desktopSaveCredential,
  desktopTestProviderConnection,
} from "../services/desktop-client";
import type {
  AsrCapabilityStatusResponse,
  AsrDeviceStatusResponse,
  AsrModelId,
  AsrRequestedDevice,
  AsrVadSettings,
  AppSettings,
  DesktopIpcResult,
  DownloadStatusResponse,
  ProviderModelOption,
} from "../contracts/desktop-api";
import { useWorkspace } from "../state/WorkspaceContext";

type SaveAsrSettings = (
  update: (current: AppSettings) => AppSettings,
) => Promise<DesktopIpcResult<AppSettings> | null>;

const TAB_PROVIDER_FILTERS: Record<string, string[]> = {
  翻译模型: ["llm"],
  语音识别模型: ["asr"],
};

/** 注册表条目类型。直接从 SSOT 推导，避免再写一份接口副本。 */
type ProviderDefinition = (typeof TRANSLATION_PROVIDER_CATALOG)[number];

export type ProviderConnectionStatus = "untested" | "ready" | "failed";

function asrProviderStatus(capability: AsrCapabilityStatusResponse | null, modelId: AsrModelId) {
  if (!capability) return { status: "attention" as const, summary: "正在检查本地语音识别组件。" };
  const model = capability.models.find((entry) => entry.id === modelId);
  const runtime = model?.engineId === "qwen3-asr"
    ? capability.optionalRuntimes.find((entry) => entry.engineId === "qwen3-asr")
    : capability.runtime;
  const dependenciesReady = model?.engineId !== "qwen3-asr" || capability.qwenAligner?.installState === "ready";
  if (runtime?.installState === "ready" && model?.installState === "ready" && dependenciesReady) {
    return { status: "ready" as const, summary: `${model.engineId} runtime 与 ${modelId} 模型已验证。` };
  }
  const states = [runtime?.installState, model?.installState, model?.engineId === "qwen3-asr" ? capability.qwenAligner?.installState : "ready"];
  if (states.some((state) => state === "corrupt" || state === "incompatible")) {
    return { status: "unavailable" as const, summary: "语音识别运行组件或模型校验失败，请修复后再使用。" };
  }
  return { status: "attention" as const, summary: `语音识别运行组件或 ${modelId} 模型尚未安装。` };
}

function formatAsrDownloadStatus(item: DownloadStatusResponse["items"][number]) {
  const asset = item.assetKind === "model" ? `模型 ${item.assetId}` : `CUDA runtime ${item.assetId}`;
  if (item.status === "ready") return `${asset} 已下载并校验完成。`;
  if (item.status === "paused") return `${asset} 下载已暂停，断点已保留。`;
  if (item.status === "failed") return `${asset} 下载失败，可点击“开始下载 / 继续下载”重试。`;
  if (item.stage === "packages") return `${asset} 正在安装依赖包；可能需要较长时间，切换页面不会中断。`;
  const stage = ({ download: "正在下载", verify: "正在校验", extract: "正在解压", publish: "正在安装", python: "正在配置 Python" } as Record<string, string>)[item.stage] ?? `正在处理（${item.stage}）`;
  return `${asset} ${stage} · ${Math.round(item.progress * 100)}%；可安全切换页面。`;
}

function useAsrAssetManagement(refreshAsrCapability: () => Promise<boolean>) {
  const [asrModelBusy, setAsrModelBusy] = useState(false);
  const [asrModelMessage, setAsrModelMessage] = useState("正在读取模型下载状态…");
  const [asrModelError, setAsrModelError] = useState(false);
  const [asrModelMessageArea, setAsrModelMessageArea] = useState<"maintenance" | "vad">("maintenance");
  const operationRef = useRef<{ id: string; kind: "model" | "runtime" | "songClassifier" } | null>(null);
  const setAsrModelFeedback = (message: string, error = false, area: "maintenance" | "vad" = "maintenance") => {
    setAsrModelMessage(message);
    setAsrModelError(error);
    setAsrModelMessageArea(area);
  };
  const run = async (kind: "model" | "runtime" | "songClassifier", label: string, operation: (id: string) => Promise<DesktopIpcResult<unknown>>) => {
    const id = `${kind}-install-${Date.now().toString(36)}`;
    operationRef.current = { id, kind };
    setAsrModelBusy(true);
    setAsrModelFeedback(`${label}…`);
    const result = await operation(id);
    if (operationRef.current?.id !== id) return;
    operationRef.current = null;
    setAsrModelBusy(false);
    if (!result.ok) {
      const cancelled = result.error.code === "CANCELLED";
      return setAsrModelFeedback(cancelled ? "下载已暂停；再次安装会从已验证断点继续。" : result.error.message, !cancelled);
    }
    if (typeof result.data === "object" && result.data !== null && "canceled" in result.data && result.data.canceled === true) {
      return setAsrModelFeedback("已取消本地文件选择，没有修改已安装组件。");
    }
    const refreshed = await refreshAsrCapability();
    setAsrModelFeedback(
      refreshed ? "操作完成，已重新校验受信文件清单。" : "操作已完成，但状态刷新失败；请重新打开页面确认。",
      !refreshed,
    );
  };
  const cancelAsrAssetOperation = async () => {
    const current = operationRef.current;
    if (!current) return;
    const result = current.kind === "model"
      ? await desktopCancelAsrModelOperation({ operationId: current.id })
      : current.kind === "runtime"
        ? await desktopCancelAsrRuntimeOperation({ operationId: current.id })
        : await desktopCancelAsrSongClassifierOperation({ operationId: current.id });
    if (!result.ok) setAsrModelFeedback(result.error.message, true);
    else setAsrModelFeedback(result.data.cancelled ? "暂停请求已发送。" : "操作已经结束。");
  };
  useEffect(() => {
    let mounted = true;
    let loaded = false;
    const poll = async () => {
      const result = await desktopGetDownloadStatus();
      if (!mounted) return;
      if (!result.ok) return setAsrModelFeedback(`读取下载状态失败：${result.error.message}`, true);
      const tracked = operationRef.current;
      const item = tracked
        ? result.data.items.find(({ operationId }) => operationId === tracked.id)
        : result.data.items.find(({ status }) => status === "active");
      if (item?.status === "active") {
        operationRef.current = {
          id: item.operationId,
          kind: item.assetId === "ina-speech-music-noise-v1" ? "songClassifier" : item.assetKind,
        };
        setAsrModelBusy(true);
        setAsrModelFeedback(formatAsrDownloadStatus(item));
      } else if (tracked && item) {
        operationRef.current = null;
        setAsrModelBusy(false);
        setAsrModelFeedback(formatAsrDownloadStatus(item), item.status === "failed");
        if (item.status === "ready") void refreshAsrCapability();
      } else if (!tracked && !loaded) {
        setAsrModelBusy(false);
        setAsrModelFeedback("当前没有正在进行的模型或 CUDA runtime 下载。");
      }
      loaded = true;
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);
  const openAsrInfo = async (target: "engine-source" | "engine-license" | "model-source" | "model-license" | "vad-source" | "vad-license", modelId?: AsrModelId) => {
    const area = target.startsWith("vad-") ? "vad" : "maintenance";
    const result = await desktopOpenAsrInfo({ target, ...(modelId ? { modelId } : {}) });
    setAsrModelFeedback(result.ok ? "已打开来源或许可证资料。" : result.error.message, !result.ok, area);
  };
  return {
    asrModelBusy, asrModelMessage, asrModelError, asrModelMessageArea, cancelAsrAssetOperation, openAsrInfo,
    installAsrModel: (modelId: AsrModelId, source: "auto" | "official" | "mirror") => run("model", source === "auto" ? `正在为 ${modelId} 自动选择健康下载源` : source === "official" ? `正在从官方源安装 ${modelId} 模型` : `正在从受限镜像安装 ${modelId} 模型`, (id) => desktopInstallAsrModel({ assetId: modelId, source, operationId: id })),
    importAsrModel: (modelId: AsrModelId) => run("model", `请选择并校验本地 ${modelId} 模型`, (id) => desktopImportAsrModel({ assetId: modelId, operationId: id })),
    uninstallAsrModel: (modelId: AsrModelId) => run("model", `正在卸载 ${modelId} 模型`, (id) => desktopUninstallAsrModel({ assetId: modelId, operationId: id })),
    installAsrRuntime: (assetId: "whisper-cpp-cuda-12.4-x64" | "qwen3-asr-transformers-cu128-x64") => run("runtime", "正在安装 CUDA runtime", (id) => desktopInstallAsrRuntime({ assetId, source: "official", operationId: id })),
    importAsrRuntime: (assetId: "whisper-cpp-cuda-12.4-x64" | "qwen3-asr-transformers-cu128-x64") => run("runtime", "请选择并校验 CUDA runtime", (id) => desktopImportAsrRuntime({ assetId, operationId: id })),
    uninstallAsrRuntime: (assetId: "whisper-cpp-cuda-12.4-x64" | "qwen3-asr-transformers-cu128-x64") => run("runtime", "正在卸载 CUDA runtime", (id) => desktopUninstallAsrRuntime({ assetId, operationId: id })),
    installSongClassifier: () => run("songClassifier", "正在安装唱词分类组件", (id) => desktopInstallAsrSongClassifier({ assetId: "ina-speech-music-noise-v1", source: "official", operationId: id })),
    uninstallSongClassifier: () => run("songClassifier", "正在卸载唱词分类组件", (id) => desktopUninstallAsrSongClassifier({ assetId: "ina-speech-music-noise-v1", operationId: id })),
  };
}

function useAsrAppSettings(setAsrDefaultModelId: (value: AsrModelId) => void) {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [asrSettingsError, setAsrSettingsError] = useState("");
  const currentRef = useRef<AppSettings | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const accept = (value: AppSettings) => {
    currentRef.current = value;
    setAppSettings(value);
    setAsrDefaultModelId(value.asrDefaultModelId);
  };
  useEffect(() => {
    let active = true;
    void desktopGetAppSettings().then((result) => {
      if (!active) return;
      if (!result.ok) return setAsrSettingsError(result.error.message);
      setAsrSettingsError("");
      accept(result.data);
    });
    return () => {
      active = false;
    };
  }, []);
  const saveAsrSettings: SaveAsrSettings = (update) => {
    const request = saveQueueRef.current.then(async () => {
      const current = currentRef.current;
      if (!current) return null;
      const result = await desktopSaveAppSettings({ settings: update(current) });
      if (result.ok) accept(result.data);
      return result;
    });
    saveQueueRef.current = request.then(() => undefined, () => undefined);
    return request;
  };
  return { appSettings, asrSettingsError, saveAsrSettings };
}

function useAsrVocalSeparationSetting(appSettings: AppSettings | null, saveAsrSettings: SaveAsrSettings) {
  const [asrVocalSeparationBusy, setBusy] = useState(false);
  const [asrVocalSeparationMessage, setMessage] = useState("");
  const [asrVocalSeparationError, setError] = useState(false);
  const saveAsrVocalSeparation = async (value: AppSettings["asrVocalSeparation"]) => {
    if (!appSettings) {
      setError(true);
      return setMessage("全局设置尚未加载完成。");
    }
    setError(false);
    setBusy(true);
    const result = await saveAsrSettings((current) => ({ ...current, asrVocalSeparation: value }));
    setBusy(false);
    if (!result) {
      setError(true);
      return setMessage("全局设置尚未加载完成。");
    }
    if (!result.ok) {
      setError(true);
      return setMessage(result.error.message);
    }
    setMessage(`对话人声分离已${result.data.asrVocalSeparation === "on" ? "开启" : "关闭"}。`);
  };
  return { asrVocalSeparationBusy, asrVocalSeparationMessage, asrVocalSeparationError, saveAsrVocalSeparation };
}

function useAsrSongHandlingSetting(appSettings: AppSettings | null, saveAsrSettings: SaveAsrSettings) {
  const [asrSongHandlingBusy, setBusy] = useState(false);
  const [asrSongHandlingMessage, setMessage] = useState("");
  const [asrSongHandlingError, setError] = useState(false);
  const saveAsrSongHandling = async (value: AppSettings["asrSongHandling"]) => {
    if (!appSettings) {
      setError(true);
      setMessage("全局设置尚未加载完成。");
      return false;
    }
    setError(false);
    setBusy(true);
    const result = await saveAsrSettings((current) => ({ ...current, asrSongHandling: value }));
    setBusy(false);
    if (!result) {
      setError(true);
      setMessage("全局设置尚未加载完成。");
      return false;
    }
    if (!result.ok) {
      setError(true);
      setMessage(result.error.message);
      return false;
    }
    setMessage(result.data.asrSongHandling === "filter"
      ? "已开启唱词过滤；只过滤高置信度音乐区间，不确定区间会保留并提示复核。"
      : "已保留歌曲与唱词，不会增加额外处理。"
    );
    return true;
  };
  return { asrSongHandlingBusy, asrSongHandlingMessage, asrSongHandlingError, saveAsrSongHandling };
}

function useAsrVadSetting(appSettings: AppSettings | null, saveAsrSettings: SaveAsrSettings) {
  const [asrVadBusy, setAsrVadBusy] = useState(false);
  const [asrVadMessage, setAsrVadMessage] = useState("VAD 设置尚未加载。");
  const [asrVadError, setAsrVadError] = useState(false);
  const loaded = useRef(false);
  useEffect(() => {
    if (appSettings && !loaded.current) {
      loaded.current = true;
      setAsrVadMessage("已读取 VAD 设置。");
      setAsrVadError(false);
    }
  }, [appSettings]);
  const saveAsrVad = async (value: AsrVadSettings) => {
    if (!appSettings) {
      setAsrVadError(true);
      return setAsrVadMessage("全局设置尚未加载完成。");
    }
    let asrVad: AsrVadSettings;
    try {
      asrVad = normalizeAsrVadSettings(value.mode === "custom"
        ? value
        : { ...value, customParameters: appSettings.asrVad.customParameters });
    } catch {
      setAsrVadError(true);
      return setAsrVadMessage("VAD 参数超出允许范围，请检查后再保存。");
    }
    setAsrVadError(false);
    setAsrVadBusy(true);
    const result = await saveAsrSettings((current) => ({ ...current, asrVad }));
    setAsrVadBusy(false);
    if (!result) {
      setAsrVadError(true);
      return setAsrVadMessage("全局设置尚未加载完成。");
    }
    if (!result.ok) {
      setAsrVadError(true);
      return setAsrVadMessage(result.error.message);
    }
    setAsrVadMessage(`VAD ${result.data.asrVad.mode === "auto" ? "自动" : result.data.asrVad.mode === "off" ? "关闭" : "自定义"}设置已保存。`);
  };
  return { asrVadBusy, asrVadMessage, asrVadError, saveAsrVad };
}

function useAsrModelSelection(
  appSettings: AppSettings | null,
  saveAsrSettings: SaveAsrSettings,
) {
  const [asrModelSelectionMessage, setMessage] = useState("");
  const [asrModelSelectionError, setError] = useState(false);
  const feedback = (message: string, error = false) => {
    setMessage(message);
    setError(error);
  };
  const selectAsrModel = async (modelId: AsrModelId) => {
    if (!appSettings) return feedback("全局设置尚未加载完成。", true);
    const result = await saveAsrSettings((current) => ({ ...current, asrDefaultModelId: modelId }));
    if (!result) return feedback("全局设置尚未加载完成。", true);
    if (!result.ok) return feedback(result.error.message, true);
    feedback(`已将 ${result.data.asrDefaultModelId} 保存为全局默认模型。`);
  };
  return { asrModelSelectionMessage, asrModelSelectionError, selectAsrModel };
}

function useAsrDeviceState() {
  const [asrDeviceStatus, setAsrDeviceStatus] = useState<AsrDeviceStatusResponse | null>(null);
  const [asrDeviceMessage, setAsrDeviceMessage] = useState("设备尚未检测。");
  const [asrDeviceError, setAsrDeviceError] = useState(false);
  const [asrDeviceBusy, setAsrDeviceBusy] = useState(false);
  const operationRef = useRef<string | null>(null);
  const feedback = (message: string, error = false) => {
    setAsrDeviceMessage(message);
    setAsrDeviceError(error);
  };
  useEffect(() => {
    let active = true;
    void desktopGetAsrDeviceStatus().then((result) => {
      if (!active) return;
      if (!result.ok) return feedback(result.error.message, true);
      setAsrDeviceStatus(result.data);
      feedback(result.data.updatedAt ? "已读取设备状态。" : "设备尚未检测。");
    });
    return () => {
      active = false;
    };
  }, []);
  const setPreference = async (requestedDevice: AsrRequestedDevice, allowCudaFallback: boolean) => {
    const result = await desktopSetAsrDevicePreference({ requestedDevice, allowCudaFallback });
    if (!result.ok) return feedback(result.error.message, true);
    setAsrDeviceStatus(result.data);
    feedback("设备偏好已保存。");
  };
  const detectAsrDevices = async () => {
    const operationId = `device-detect-${Date.now().toString(36)}`;
    operationRef.current = operationId;
    setAsrDeviceBusy(true);
    feedback("正在检测 CPU 与 CUDA 运行时…");
    const result = await desktopDetectAsrDevices({ operationId });
    if (operationRef.current !== operationId) return;
    operationRef.current = null;
    setAsrDeviceBusy(false);
    if (!result.ok) return feedback(result.error.code === "CANCELLED" ? "设备检测已取消。" : result.error.message, result.error.code !== "CANCELLED");
    setAsrDeviceStatus(result.data);
    feedback("设备检测完成。");
  };
  const cancelAsrDeviceDetection = async () => {
    const operationId = operationRef.current;
    if (!operationId) return;
    const result = await desktopCancelAsrDeviceDetection({ operationId });
    if (!result.ok) feedback(result.error.message, true);
  };
  return {
    asrDeviceStatus,
    asrDeviceMessage,
    asrDeviceError,
    asrDeviceBusy,
    selectAsrDevice: (requestedDevice: AsrRequestedDevice) =>
      setPreference(requestedDevice, asrDeviceStatus?.allowCudaFallback ?? false),
    setAsrCudaFallback: (allowCudaFallback: boolean) =>
      setPreference(asrDeviceStatus?.requestedDevice ?? "auto", allowCudaFallback),
    detectAsrDevices,
    cancelAsrDeviceDetection,
  };
}

function useAsrCapabilityState() {
  const [asrCapability, setAsrCapability] = useState<AsrCapabilityStatusResponse | null>(null);
  const [asrCapabilityError, setAsrCapabilityError] = useState(false);
  const [asrCapabilityMessage, setAsrCapabilityMessage] = useState("正在检查本地语音识别组件。");
  const [asrDefaultModelId, setAsrDefaultModelId] = useState<AsrModelId>("small");
  const { appSettings, asrSettingsError, saveAsrSettings } = useAsrAppSettings(setAsrDefaultModelId);
  const vocalSeparationSetting = useAsrVocalSeparationSetting(appSettings, saveAsrSettings);
  const songHandlingSetting = useAsrSongHandlingSetting(appSettings, saveAsrSettings);
  const vadSetting = useAsrVadSetting(appSettings, saveAsrSettings);
  const modelSelection = useAsrModelSelection(appSettings, saveAsrSettings);
  const device = useAsrDeviceState();
  const refreshAsrCapability = async () => {
    const result = await desktopGetAsrCapabilityStatus();
    if (!result.ok) {
      setAsrCapabilityMessage(result.error.message);
      setAsrCapabilityError(true);
      return false;
    }
    setAsrCapability(result.data);
    setAsrCapabilityError(false);
    setAsrCapabilityMessage(asrProviderStatus(result.data, asrDefaultModelId).summary);
    return true;
  };
  const assets = useAsrAssetManagement(refreshAsrCapability);
  useEffect(() => {
    let active = true;
    void desktopGetAsrCapabilityStatus().then((result) => {
      if (!active) return;
      if (!result.ok) {
        setAsrCapabilityMessage(result.error.message);
        setAsrCapabilityError(true);
        return;
      }
      setAsrCapability(result.data);
      setAsrCapabilityError(false);
      setAsrCapabilityMessage(asrProviderStatus(result.data, asrDefaultModelId).summary);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!asrCapabilityError) setAsrCapabilityMessage(asrProviderStatus(asrCapability, asrDefaultModelId).summary);
  }, [asrCapability, asrCapabilityError, asrDefaultModelId]);

  return {
    asrCapability,
    asrCapabilityMessage,
    asrCapabilityError,
    asrDefaultModelId,
    asrSettingsLoaded: appSettings !== null,
    asrSettingsError,
    asrVocalSeparation: appSettings?.asrVocalSeparation ?? "off",
    asrSongHandling: appSettings?.asrSongHandling ?? "preserve",
    asrVad: appSettings?.asrVad ?? normalizeAsrVadSettings(DEFAULT_ASR_VAD_SETTINGS),
    ...vocalSeparationSetting,
    ...songHandlingSetting,
    ...vadSetting,
    ...modelSelection,
    ...device,
    ...assets,
  };
}

function useProviderSelection(asrCapability: AsrCapabilityStatusResponse | null, asrDefaultModelId: AsrModelId) {
  const { capabilities, defaults, refreshCapabilities } = useWorkspace();
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") === "asr" ? "语音识别模型" : null;
  const [tab, setTab] = useState(requestedTab ?? "翻译模型");
  const [selectedProviderId, setSelectedProviderId] = useState(
    () => capabilities.providers.find((provider) => provider.name === defaults.provider)?.id
      ?? capabilities.providers[0]?.id
      ?? "",
  );
  const providers = useMemo(() => {
    const liveAsr = asrProviderStatus(asrCapability, asrDefaultModelId);
    return capabilities.providers.map((provider) =>
      provider.kind === "asr"
        ? { ...provider, id: "whisper-cpp", name: "本地 ASR", models: asrCapability?.models.map((model) => model.id) ?? ["small"], ...liveAsr }
        : provider,
    );
  }, [asrCapability, asrDefaultModelId, capabilities.providers]);
  const visibleProviders = useMemo(() => {
    const allowedKinds = TAB_PROVIDER_FILTERS[tab];
    return providers.filter((provider) => allowedKinds.includes(provider.kind));
  }, [providers, tab]);

  useEffect(() => {
    setTab(requestedTab ?? "翻译模型");
  }, [requestedTab]);

  useEffect(() => {
    if (tab !== "翻译模型") return;
    const preferred = capabilities.providers.find((provider) => provider.name === defaults.provider);
    if (preferred) setSelectedProviderId(preferred.id);
  }, [capabilities.providers, defaults.provider, tab]);

  useEffect(() => {
    if (visibleProviders.length === 0) {
      setSelectedProviderId("");
    } else if (!visibleProviders.some((provider) => provider.id === selectedProviderId)) {
      setSelectedProviderId(visibleProviders[0].id);
    }
  }, [selectedProviderId, visibleProviders]);
  const selectedProvider =
    visibleProviders.find((provider) => provider.id === selectedProviderId) ?? visibleProviders[0];
  const providerDefinition = TRANSLATION_PROVIDER_CATALOG.find(
    (provider) => provider.id === selectedProvider?.id,
  );
  return {
    tab, setTab, selectedProviderId, setSelectedProviderId,
    visibleProviders, selectedProvider, providerDefinition,
  };
}

/** 注册表内置的兜底型号。真实可用列表要靠「拉取模型」覆盖。 */
function registryModelOptions(definition?: ProviderDefinition): ProviderModelOption[] {
  return definition ? definition.models.map((model) => ({ id: model.id, label: model.label })) : [];
}

/**
 * 模型下拉的数据源。
 * 初值是注册表兜底列表，点「拉取」后被服务商真实返回的列表整体替换，
 * 用户因此不需要手打型号名。选项值一律是模型 ID（不是展示 label），
 * 这样保存和后端解析都不需要额外的 label ↔ id 映射。
 */
function useProviderModelCatalog(providerDefinition?: ProviderDefinition, preferredModel?: string) {
  const [fetchedOptions, setFetchedOptions] = useState<ProviderModelOption[] | null>(null);
  const [selectedModel, setSelectedModel] = useState(() => preferredModel ?? providerDefinition?.models[0]?.id ?? "");
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsMessage, setModelsMessage] = useState("");

  useEffect(() => {
    setFetchedOptions(null);
    setSelectedModel(preferredModel ?? providerDefinition?.models[0]?.id ?? "");
    setModelsBusy(false);
    setModelsMessage("");
  }, [preferredModel, providerDefinition]);

  const modelOptions = useMemo(() => {
    const base = fetchedOptions ?? registryModelOptions(providerDefinition);
    if (!selectedModel || base.some((option) => option.id === selectedModel)) return base;
    return [{ id: selectedModel, label: selectedModel }, ...base];
  }, [fetchedOptions, providerDefinition, selectedModel]);

  return {
    modelOptions,
    selectedModel,
    setSelectedModel,
    setFetchedOptions,
    modelsBusy,
    setModelsBusy,
    modelsMessage,
    setModelsMessage,
    modelsFetched: fetchedOptions !== null,
  };
}

/** 接口地址、凭据是否已保存、上次连接测试结果。切换服务商时整体重置。 */
function useProviderConnectionState(
  providerDefinition: ProviderDefinition | undefined,
  setSelectedModel: (model: string) => void,
  setFetchedOptions: (models: ProviderModelOption[]) => void,
) {
  const [baseUrl, setBaseUrl] = useState(providerDefinition?.defaultBaseUrl ?? "");
  const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ProviderConnectionStatus>("untested");
  const [connectionMessage, setConnectionMessage] = useState("");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const secretInputRef = useRef<HTMLInputElement>(null);
  const providerIdRef = useRef(providerDefinition?.id);
  providerIdRef.current = providerDefinition?.id;

  useEffect(() => {
    let active = true;
    const effectProviderId = providerDefinition?.id;
    setBaseUrl(providerDefinition?.defaultBaseUrl ?? "");
    setCredentialConfigured(false);
    setConnectionStatus("untested");
    setConnectionMessage("");
    setConnectionBusy(false);
    setLatencyMs(null);
    if (secretInputRef.current) secretInputRef.current.value = "";
    const cleanup = () => {
      active = false;
      if (providerIdRef.current === effectProviderId) providerIdRef.current = undefined;
    };
    if (!providerDefinition || !window.desktop) return cleanup;
    void desktopGetCredentialStatus({ credentialId: providerDefinition.credentialId }).then((result) => {
      if (!active) return;
      if (result.ok && "configured" in result.data) setCredentialConfigured(result.data.configured);
    });
    void desktopGetProviderRuntimeState({ provider: providerDefinition.name }).then((result) => {
      if (!active || !result.ok) return;
      if (result.data.configuredModels?.length) {
        setFetchedOptions(result.data.configuredModels.map((id) => ({ id, label: id })));
      }
      if (result.data.status !== "ready") return;
      setConnectionStatus("ready");
      setConnectionMessage("上次连接测试已通过。");
      if (result.data.baseUrlDisplay) setBaseUrl(result.data.baseUrlDisplay);
      if (result.data.requestedModel) setSelectedModel(result.data.requestedModel);
    });
    return cleanup;
  }, [providerDefinition, setFetchedOptions, setSelectedModel]);

  return {
    baseUrl, setBaseUrl, credentialConfigured, setCredentialConfigured,
    connectionStatus, setConnectionStatus, connectionMessage, setConnectionMessage,
    connectionBusy, setConnectionBusy, latencyMs, setLatencyMs,
    secretInputRef, providerIdRef,
  };
}

/**
 * 凭据读写。密钥只从 ref 里读一次就地清空，不进 state、不进任何消息文本。
 * 每个异步动作回来后都要比对 providerIdRef：用户可能已经切到别的服务商。
 */
function useCredentialActions(
  providerDefinition: ProviderDefinition | undefined,
  state: ReturnType<typeof useProviderConnectionState>,
) {
  const { providerIdRef, secretInputRef, setConnectionMessage, setConnectionStatus } = state;
  const { setCredentialConfigured, setLatencyMs } = state;

  const saveCredential = async () => {
    const input = secretInputRef.current;
    if (!providerDefinition || !input) return false;
    const providerId = providerDefinition.id;
    const secret = input.value;
    if (!secret) {
      setConnectionMessage("请先填写 API Key。");
      return false;
    }
    input.value = "";
    const result = await desktopSaveCredential({
      credentialId: providerDefinition.credentialId,
      secret,
      providerId,
      label: providerDefinition.name,
    });
    if (providerIdRef.current !== providerId) return false;
    if (!result.ok) {
      setConnectionStatus("failed");
      setConnectionMessage(result.error.message);
      return false;
    }
    setCredentialConfigured(true);
    return true;
  };

  const deleteCredential = async () => {
    if (!providerDefinition) return;
    const providerId = providerDefinition.id;
    const result = await desktopDeleteCredential({ credentialId: providerDefinition.credentialId });
    if (providerIdRef.current !== providerId) return;
    if (!result.ok) return setConnectionMessage(result.error.message);
    setCredentialConfigured(false);
    setConnectionStatus("untested");
    setLatencyMs(null);
    setConnectionMessage("已删除保存的 API Key。");
  };

  return { saveCredential, deleteCredential };
}

async function saveGlobalTranslationSelection(provider: string, model: string) {
  const current = await desktopGetAppSettings();
  if (!current.ok) return current;
  return desktopSaveAppSettings({
    settings: { ...current.data, translationProvider: provider, translationModel: model },
  });
}

function providerModelWarning(providerDefinition?: ProviderDefinition, selectedModel?: string) {
  if (!providerDefinition || !selectedModel || allowsFreeFormModelId(providerDefinition.profile)) return "";
  return providerDefinition.models.some((model) => model.id === selectedModel || model.label === selectedModel)
    ? ""
    : `${providerDefinition.name} 目前只接受内置列表中的型号，请重新选择模型。`;
}

function useProviderConnection(providerDefinition?: ProviderDefinition) {
  const { defaults, refreshCapabilities, updateDefaults } = useWorkspace();
  const preferredModel = defaults.provider === providerDefinition?.name ? defaults.model : undefined;
  const catalog = useProviderModelCatalog(providerDefinition, preferredModel);
  const state = useProviderConnectionState(providerDefinition, catalog.setSelectedModel, catalog.setFetchedOptions);
  const credentials = useCredentialActions(providerDefinition, state);
  const deleteCredential = async () => {
    await credentials.deleteCredential();
    void refreshCapabilities();
  };
  const { selectedModel, setSelectedModel, setFetchedOptions, setModelsBusy, setModelsMessage } = catalog;
  const { baseUrl, providerIdRef, secretInputRef, setConnectionBusy, setConnectionMessage } = state;
  const { setConnectionStatus, setLatencyMs } = state;

  const persistGlobalSelection = async () => {
    if (!providerDefinition || !selectedModel) return false;
    const saved = await saveGlobalTranslationSelection(providerDefinition.name, selectedModel);
    if (!saved.ok) {
      setConnectionStatus("failed");
      setConnectionMessage(saved.error.message);
      return false;
    }
    updateDefaults({ provider: providerDefinition.name, model: selectedModel });
    return true;
  };

  const saveConfiguration = async () => {
    if (!providerDefinition || !selectedModel) return false;
    if (catalog.modelOptions.length > 0 && !catalog.modelOptions.some((model) => model.id === selectedModel) && !allowsFreeFormModelId(providerDefinition.profile)) {
      setConnectionStatus("failed");
      setConnectionMessage("请选择当前列表中的模型后再保存。");
      return false;
    }
    if (secretInputRef.current?.value) {
      if (!(await credentials.saveCredential())) return false;
    } else if (!state.credentialConfigured) {
      setConnectionMessage("请先填写 API Key。");
      return false;
    }
    if (!(await persistGlobalSelection())) return false;
    await refreshCapabilities();
    setConnectionStatus("untested");
    setConnectionMessage("配置已保存；首次使用时会自动检查连接。");
    return true;
  };

  /**
   * 只有部分 profile 允许注册表之外的模型 ID（见 shared/provider-registry.mjs）。
   * 提前在本地拦住，用户看到的是中文说明，而不是后端抛回来的英文校验错误。
   */
  const modelWarning = providerModelWarning(providerDefinition, selectedModel);

  /**
   * 「拉取」也要能一步到位：密钥必须先落进系统安全凭据，主进程才拿得到它
   * （渲染层不允许把 apiKey 透传给 IPC），所以这里顺手保存一次输入框里的新值。
   */
  const fetchModels = async () => {
    if (!providerDefinition) return;
    if (secretInputRef.current?.value) {
      if (!(await credentials.saveCredential())) return;
      void refreshCapabilities();
    } else if (!state.credentialConfigured) {
      setModelsMessage("请先填写 API Key 再拉取模型。");
      return;
    }
    const providerId = providerDefinition.id;
    setModelsBusy(true);
    setModelsMessage("正在拉取模型列表…");
    const result = await desktopListProviderModels({
      provider: providerDefinition.name,
      credentialId: providerDefinition.credentialId,
      baseUrl: baseUrl || undefined,
    });
    if (providerIdRef.current !== providerId) return;
    setModelsBusy(false);
    if (!result.ok) return setModelsMessage(result.error.message);
    const { models, truncated } = result.data;
    setFetchedOptions(models);
    // 后端刚把拉取结果写进了 readiness（configuredModels）。不刷新能力目录的话，
    // 项目页 / 批量页的模型下拉要等到重启或下一次连接测试才能看到这批型号。
    void refreshCapabilities();
    if (models.length === 0) return setModelsMessage("该接口没有返回任何模型，请确认接口地址与 API Key。");
    if (!models.some((model) => model.id === selectedModel)) setSelectedModel(models[0].id);
    setModelsMessage(`已拉取 ${models.length} 个模型${truncated ? "，模型较多，仅显示前面一批。" : "。"}`);
  };

  const testConnection = async () => {
    if (!providerDefinition) return;
    if (modelWarning) {
      setConnectionStatus("failed");
      setConnectionMessage(modelWarning);
      return;
    }
    const providerId = providerDefinition.id;
    const startedAt = Date.now();
    setConnectionBusy(true);
    setConnectionMessage("正在测试连接…");
    const result = await desktopTestProviderConnection({
      provider: providerDefinition.name,
      credentialId: providerDefinition.credentialId,
      baseUrl: baseUrl || undefined,
      model: selectedModel || undefined,
      transportMode: providerDefinition.defaultTransport ?? undefined,
    });
    if (providerIdRef.current !== providerId) return;
    setConnectionBusy(false);
    setLatencyMs(Date.now() - startedAt);
    setConnectionStatus(result.ok ? "ready" : "failed");
    setConnectionMessage(result.ok ? "连接测试通过" : result.error.message);
    // 顶栏状态灯读的是 workspace 的能力目录，测完立刻刷新，
    // 否则用户配好了顶栏还写着「未配置翻译服务」。
    if (result.ok) {
      await persistGlobalSelection();
      void refreshCapabilities();
    }
  };

  return { ...catalog, ...state, modelWarning, saveConfiguration, deleteCredential, fetchModels, testConnection };
}

export function useModelApiController() {
  const asr = useAsrCapabilityState();
  const selection = useProviderSelection(asr.asrCapability, asr.asrDefaultModelId);
  const connection = useProviderConnection(selection.providerDefinition);
  return {
    ...selection,
    ...connection,
    ...asr,
  };
}

export type ModelApiController = ReturnType<typeof useModelApiController>;
