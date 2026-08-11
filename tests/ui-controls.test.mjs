import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".tsx") ? [path] : [];
  });
}

function inspectControls() {
  // ponytail: keep the cheap static gate alongside the Electron/browser smoke paths.
  const findings = [];

  for (const path of sourceFiles(join(root, "src"))) {
    const text = readFileSync(path, "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    function visit(node, interactiveAncestor = false) {
      const opening = ts.isJsxElement(node)
        ? node.openingElement
        : ts.isJsxSelfClosingElement(node)
          ? node
          : null;
      const tag = opening?.tagName.getText(source);
      const attributes = new Set(
        opening?.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((attribute) => attribute.name.getText(source)) ?? [],
      );
      const isButton = tag === "button" || tag === "Button";
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const location = `${relative(root, path)}:${line}`;

      if (isButton && interactiveAncestor) findings.push(`${location} nested button`);
      if (
        isButton &&
        relative(root, path) !== join("src", "components", "ui", "Button.tsx") &&
        !attributes.has("onClick") &&
        !attributes.has("disabled")
      ) {
        findings.push(`${location} enabled button has no action`);
      }
      if (tag === "input" && attributes.has("placeholder") && !attributes.has("onChange") && !attributes.has("disabled")) {
        findings.push(`${location} enabled search input has no action`);
      }
      if (tag === "Select" && attributes.has("value") && !attributes.has("onChange") && !attributes.has("disabled")) {
        findings.push(`${location} enabled controlled select cannot change`);
      }
      const staticDisabled = opening?.attributes.properties.some(
        (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "disabled" && !attribute.initializer,
      );
      if (staticDisabled && !attributes.has("title")) findings.push(`${location} disabled control has no explanation`);

      ts.forEachChild(node, (child) => visit(child, interactiveAncestor || isButton));
    }

    visit(source);
  }

  return findings;
}

test("interactive controls are actionable, disabled, and never nested", () => {
  assert.deepEqual(inspectControls(), []);
});

test("mock capabilities do not claim real provider or ASR readiness", () => {
  const mock = readFileSync(join(root, "src", "mock", "workspace.ts"), "utf8");
  assert.doesNotMatch(mock, /^\s+status: "ready",|API Key 已配置|CUDA 正常|驱动已就绪|当前使用 CUDA/m);
});

test("ASR model catalog exposes the trusted multi-model status and persisted default", () => {
  const mock = readFileSync(join(root, "src", "mock", "workspace.ts"), "utf8");
  const controller = readFileSync(join(root, "src", "pages", "model-api-controller.ts"), "utf8");
  const view = readFileSync(join(root, "src", "pages", "model-api-view.tsx"), "utf8");
  const settings = readFileSync(join(root, "src", "pages", "SettingsPage.tsx"), "utf8");

  assert.doesNotMatch(`${mock}\n${view}\n${settings}`, /Faster-Whisper/);
  assert.match(mock, /id: "whisper-cpp"/);
  assert.match(mock, /name: "Whisper\.cpp"/);
  assert.match(mock, /models: \[\.\.\.ASR_MODEL_IDS\]/);
  assert.match(controller, /desktopGetAsrCapabilityStatus/);
  assert.match(controller, /desktopGetAppSettings/);
  assert.match(controller, /desktopSaveAppSettings/);
  assert.match(controller, /asrDefaultModelId/);
  assert.match(view, /全局默认 ASR 模型/);
  assert.doesNotMatch(view, /今日任务|平均时长|缓存命中/);
});

test("P3-4 ASR model page keeps the required order, families, states, and operations", () => {
  const view = readFileSync(join(root, "src", "pages", "model-api-view.tsx"), "utf8");

  assert.match(view, /管理本地识别引擎、模型、计算设备与语音活动检测/);
  assert.match(
    view,
    /<AsrCurrentConfiguration[\s\S]*<ProviderGrid[\s\S]*<AsrModelSelector[\s\S]*<AsrComponentStatus[\s\S]*<AsrDevicePanel[\s\S]*<AsrMaintenancePanel[\s\S]*<AsrVadPanel/,
  );
  for (const phrase of [
    "当前配置",
    "识别引擎",
    "SenseVoice",
    "评估中",
    "选择模型",
    "Small",
    "兼容模式",
    "Large V3 Turbo",
    "推荐模式",
    "Large V3",
    "最高精度",
    "Q5",
    "Q8",
    "完整版",
    "Qwen3-ASR",
    "Preview · 仅 CUDA",
    "0.6B",
    "1.7B",
    "本地组件状态",
    "模型下载与维护",
  ]) assert.match(view, new RegExp(phrase));
  assert.match(view, /type="radio"/);
  assert.match(view, /name="asr-default-model"/);
  assert.match(view, /cudaRequired/);
  assert.match(view, /allowCudaFallback/);
  for (const state of ["installed", "selected", "actual"]) {
    assert.match(view, new RegExp(`data-state-kind="${state}"`));
  }
  assert.match(view, /confirmLabel="确认卸载"/);
  assert.match(view, /uninstallAsrModel\(modelId\)/);
  assert.match(view, /variant="danger"[\s\S]{0,400}uninstallAsrRuntime\(runtimeId\)/);
  assert.match(view, /const cudaReady = cuda\?\.installState === "ready"/);
  assert.doesNotMatch(view, /cudaReady\s*=.*detection\.cuda\.status/);
  assert.match(view, /!controller\.asrCapabilityError && controller\.asrSettingsLoaded && Boolean\(controller\.asrDeviceStatus\)/);
});

test("ASR device controls expose real Auto CPU CUDA detection and explicit fallback state", () => {
  const controller = readFileSync(join(root, "src", "pages", "model-api-controller.ts"), "utf8");
  const view = readFileSync(join(root, "src", "pages", "model-api-view.tsx"), "utf8");
  assert.match(controller, /desktopGetAsrDeviceStatus/);
  assert.match(controller, /desktopSetAsrDevicePreference/);
  assert.match(controller, /desktopDetectAsrDevices/);
  assert.match(controller, /desktopCancelAsrDeviceDetection/);
  assert.match(view, /Auto/);
  assert.match(view, /CPU/);
  assert.match(view, /CUDA/);
  assert.match(view, /失败后回退 CPU/);
  assert.match(view, /检测设备|取消检测/);
  assert.match(view, /disabled=\{!isDesktopRuntime\(\) \|\| controller\.asrDeviceBusy\}/);
  assert.match(view, /disabled=\{!isDesktopRuntime\(\) \|\| !controller\.asrDeviceBusy\}/);
  assert.match(view, /role=\{controller\.asrDeviceError \? "alert" : "status"\}/);
  assert.match(controller, /result\.error\.code === "CANCELLED" \? "设备检测已取消。"/);
  assert.doesNotMatch(view, /CUDA 正常|驱动已就绪|当前使用 CUDA/);
});

test("Phase 7 project ASR workflow is explicit, cancellable, actionable, and protection-first", () => {
  const overview = readFileSync(join(root, "src", "pages", "ProjectOverviewPage.tsx"), "utf8");
  const context = readFileSync(join(root, "src", "state", "WorkspaceContext.tsx"), "utf8");
  const client = readFileSync(join(root, "src", "services", "desktop-client.ts"), "utf8");
  for (const phrase of [
    "1. 开始语音识别",
    "2. 生成字幕段",
    "原文语言自动检查",
    "自动识别全部段语言",
    "采用自动检测建议",
    "取消",
    "3. 使用这份字幕",
    "当前活动源轨、人工原文和已有译文会保留",
    "重新关联媒体",
    "不会自动发起付费翻译",
    "操作已结束，未产生新结果。",
  ]) assert.match(overview, new RegExp(phrase));
  assert.match(overview, /confirmedAudioStreamId/);
  assert.match(overview, /useState\(project\.mediaSource\?\.confirmedAudioStreamId \?\? ""\)/);
  assert.match(overview, /audioStreams\.some\(\(stream\) => stream\.streamId === persisted\)/);
  assert.match(overview, /mediaMissing/);
  assert.match(overview, /role="alert"/);
  assert.match(overview, /data-testid="asr-project-workflow"/);
  assert.match(overview, /actionLockRef/);
  assert.match(overview, /const latestRun = runs\[0\]/);
  assert.doesNotMatch(overview, /runs\.map\(/, "one project must expose only the latest ASR run action");
  assert.match(overview, /asrCandidates\.slice\(-1\)/);
  assert.match(context, /runProjectAsr/);
  assert.match(context, /segmentProjectAsrRun/);
  assert.match(context, /updateProjectAsrLanguages/);
  assert.match(client, /desktopRunAsrTranscription/);
  assert.doesNotMatch(overview, /mock.*ASR|模拟.*ASR/i);
});

test("ASR model management separates source selection from the explicit download action", () => {
  const controller = readFileSync(join(root, "src", "pages", "model-api-controller.ts"), "utf8");
  const view = readFileSync(join(root, "src", "pages", "model-api-view.tsx"), "utf8");
  for (const method of ["desktopInstallAsrModel", "desktopImportAsrModel", "desktopUninstallAsrModel", "desktopCancelAsrModelOperation", "desktopOpenAsrInfo"]) {
    assert.match(controller, new RegExp(method));
  }
  for (const phrase of [
    "whisper.cpp 1.9.1",
    "清单期望大小",
    "清单 SHA-256",
    "模型目录存在，但必需文件缺失",
    "模型文件大小与清单不符",
    "模型文件内容与清单不符",
    "选择下载源",
    "自动选择",
    "官方源",
    "国内镜像",
    "开始下载 / 继续下载",
    "手动导入",
    "卸载模型",
    "暂停下载",
    "安装 CUDA runtime",
    "手动导入 CUDA runtime",
    "卸载 CUDA runtime",
    "引擎来源",
    "引擎许可证",
    "模型来源",
    "模型许可证",
  ]) {
    assert.match(view, new RegExp(phrase));
  }
  assert.match(view, /installAsrModel\(modelId, selectedSource\)/);
  assert.match(view, /importAsrModel\(modelId\)/);
  assert.match(view, /uninstallAsrModel\(modelId\)/);
  assert.match(view, /openAsrInfo\("model-source", modelId\)/);
  assert.match(view, /openAsrInfo\("model-license", modelId\)/);
  assert.match(view, /const modelId = controller\.asrDefaultModelId/);
  assert.match(view, /const busy = !isDesktopRuntime\(\) \|\| controller\.asrModelBusy/);
  assert.match(view, /disabled=\{busy \|\| !hasRemovableAsset\(model\?\.installState\)\}/);
  assert.match(view, /state === "ready" \|\| state === "corrupt" \|\| state === "incompatible"/);
  assert.match(view, /disabled=\{!isDesktopRuntime\(\) \|\| !controller\.asrModelBusy\}/);
  assert.match(view, /disabled=\{!isDesktopRuntime\(\) \|\| controller\.asrModelBusy\}/);
  assert.doesNotMatch(view, /维护目标模型/);
  assert.match(view, /<ConfirmDialog[\s\S]*confirmLabel="确认卸载"/);
  assert.match(controller, /capabilities\.providers\.find\(\(provider\) => provider\.name === defaults\.provider\)\?\.id/);
  assert.match(controller, /\[capabilities\.providers, defaults\.provider, tab\]/);
  assert.match(view, /role=\{controller\.asrModelError \? "alert" : "status"\}/);
  assert.match(view, /role=\{controller\.asrModelSelectionError \? "alert" : "status"\}/);
  assert.match(controller, /const refreshed = await refreshAsrCapability\(\)/);
  assert.match(controller, /refreshed \? "操作完成，已重新校验受信文件清单。"/);
  assert.match(controller, /正在读取模型下载状态/);
  assert.match(controller, /find\(\(\{ status \}\) => status === "active"\)/);
  assert.match(controller, /item\.assetId === "ina-speech-music-noise-v1" \? "songClassifier" : item\.assetKind/);
  assert.match(controller, /切换页面不会中断/);
  assert.doesNotMatch(controller, /模型安装状态尚未刷新/);
  assert.match(controller, /saveQueueRef\.current\.then/);
  assert.match(controller, /settings: update\(current\)/);
  assert.match(controller, /if \(!asrCapabilityError\) setAsrCapabilityMessage/);
  assert.doesNotMatch(view, /https:\/\//, "renderer must use fixed main-owned info targets, not arbitrary URLs");
});

test("ASR VAD exposes persisted automatic off and bounded custom modes without free-form argv", () => {
  const controller = readFileSync(join(root, "src", "pages", "model-api-controller.ts"), "utf8");
  const view = readFileSync(join(root, "src", "pages", "model-api-view.tsx"), "utf8");
  assert.match(controller, /normalizeAsrVadSettings/);
  assert.match(controller, /desktopSaveAppSettings/);
  for (const label of ["背景音过滤（VAD）", "关闭", "保守", "标准（推荐）", "强力", "高级参数", "最长语音（秒，0=无限制）", "实际生效", "恢复推荐值"]) {
    assert.match(view, new RegExp(label.replace(/[（）]/g, "\\$&")));
  }
  assert.match(view, /type="number"/);
  assert.match(view, /aria-describedby="asr-vad-custom-help"/);
  assert.match(view, /aria-invalid=/);
  assert.match(view, /disabled=\{!isDesktopRuntime\(\) \|\| controller\.asrVadBusy\}/);
  assert.match(view, /role=\{controller\.asrVadError \? "alert" : "status"\}/);
  assert.match(view, /VAD 来源/);
  assert.match(view, /VAD 许可证/);
  assert.doesNotMatch(view, /textarea[^>]*argv|自由参数|命令行参数/i);
});

test("ASR vocal separation exposes an exact persisted off/on control and processing caveats", () => {
  const controller = readFileSync(join(root, "src", "pages", "model-api-controller.ts"), "utf8");
  const view = readFileSync(join(root, "src", "pages", "model-api-view.tsx"), "utf8");
  for (const phrase of ["对话人声分离", "处理顺序：人声分离 → 唱词处理 → VAD → 语音识别", "处理可能明显变慢", "歌曲人声未必能过滤", "分离模型约 871 MB", "不会静默改用原混音"]) {
    assert.match(view, new RegExp(phrase));
  }
  assert.match(view, /data-testid="asr-vocal-separation-panel"/);
  assert.match(view, /\(\["off", "on"\] as const\)/);
  assert.match(view, /aria-pressed=\{controller\.asrVocalSeparation === value\}/);
  assert.match(view, /controller\.saveAsrVocalSeparation\(value\)/);
  assert.match(view, /人声分离 \{vocalSeparation\} · 唱词 \{songHandling\} · VAD/);
  assert.match(controller, /asrVocalSeparation: appSettings\?\.asrVocalSeparation \?\? "off"/);
  assert.match(controller, /asrVocalSeparation: value/);
  assert.match(controller, /result\.data\.asrVocalSeparation === "on"/);
});

test("song handling defaults to preserve and only enables filtering with the verified optional classifier", () => {
  const controller = readFileSync(join(root, "src", "pages", "model-api-controller.ts"), "utf8");
  const view = readFileSync(join(root, "src", "pages", "model-api-view.tsx"), "utf8");
  for (const phrase of ["歌曲与唱词处理", "保留歌曲/唱词（默认）", "过滤高置信度唱词", "疑似唱词", "至少 2 秒", "70%", "约 3.1 MiB"]) {
    assert.match(view, new RegExp(phrase.replace(/[（）]/g, "\\$&")));
  }
  assert.match(view, /data-testid="asr-song-handling-panel"/);
  assert.match(view, /disabled=\{!isDesktopRuntime\(\) \|\| !controller\.asrSettingsLoaded \|\| busy \|\| !ready\}/);
  assert.match(controller, /asrSongHandling: appSettings\?\.asrSongHandling \?\? "preserve"/);
  assert.match(controller, /desktopInstallAsrSongClassifier/);
  assert.match(controller, /saveAsrSongHandling/);
  assert.match(view, /filtering && !\(await controller\.saveAsrSongHandling\("preserve"\)\)/);
  assert.match(view, /title=\{filtering \? "卸载后会自动切换为保留歌曲\/唱词"/);
  assert.doesNotMatch(view, /disabled=\{busy \|\| filtering\}/);
});

test("Phase 12 settings UI consumes real desktop readiness, backup, credential and diagnostics services", () => {
  const page = readFileSync(join(root, "src", "pages", "SettingsPage.tsx"), "utf8");
  const controller = readFileSync(join(root, "src", "pages", "settings-controller.ts"), "utf8");
  for (const phrase of ["全局环境就绪", "当前项目就绪", "修复/查看", "脱敏诊断包", "更新、删除或连接复检", "备份与恢复"]) {
    assert.match(page, new RegExp(phrase));
  }
  for (const method of ["desktopGetCapabilityReadiness", "desktopSelectSettingsDirectory", "desktopSaveAppSettings", "desktopProbeDownloadSources", "desktopCreateAppBackup", "desktopSelectBackupRestore", "desktopPreviewDiagnostics"]) {
    assert.match(controller, new RegExp(method));
  }
  assert.match(page, /aria-label=\{`选择\$\{label\}`\}/);
  assert.match(page, /controller\.selectDirectory\(pathKey\)/);
  assert.match(controller, /destination:\s*"backup"/);
  assert.match(controller, /资源管理器中定位/);
  assert.doesNotMatch(page, /workspaceMock|capabilities\.devices|downloadSources\.map/);
});

test("DesktopApi and preload expose every ASR project workflow method", () => {
  const contract = readFileSync(join(root, "src", "contracts", "desktop-api.ts"), "utf8");
  const preload = readFileSync(join(root, "electron", "preload.ts"), "utf8");
  for (const method of [
    "getAsrProjectStatus",
    "runAsrTranscription",
    "segmentAsrRun",
    "detectAsrSegmentLanguages",
    "updateAsrSegmentLanguages",
    "cancelAsrProjectOperation",
    "openAsrInfo",
  ]) {
    assert.match(contract, new RegExp(method));
    assert.match(preload, new RegExp(method));
  }
});

test("failed and recoverable tasks expose explicit confirmed controls", () => {
  const banner = readFileSync(
    join(root, "src", "components", "feature", "project-overview", "RunProgressBanner.tsx"),
    "utf8",
  );
  const workspace = readFileSync(join(root, "src", "domain", "workspace.ts"), "utf8");
  assert.match(banner, /确认重试/);
  assert.match(workspace, /确认继续/);
  assert.match(banner, /runControl\(task, "retry"\)/);
  assert.match(banner, /userConfirmed: true/);
});

test("subtitle editor workbench prioritizes synchronized playback, table, and keyboard operations", () => {
  const editor = readFileSync(join(root, "src", "pages", "SubtitleEditorPage.tsx"), "utf8");
  assert.match(editor, /data-testid="subtitle-editor-workbench"/);
  assert.match(editor, /data-testid="subtitle-editor-table"/);
  // 旧版底部操作条是悬浮胶囊，工作台自己留 pb-28 让位。现在 BottomActionBar 贴底、
  // AppShell 的滚动容器统一有 pb-[72px] 占位，工作台再留 112px 就是纯空白。
  assert.doesNotMatch(editor, /pb-28/);
  assert.match(editor, /ArrowDown/);
  assert.match(editor, /ArrowUp/);
  assert.match(editor, /subtitle-editor-shortcuts/);
  assert.match(editor, /getSegmentPage/);
  assert.match(editor, /次要工具：查找替换、候选翻译与边界说明/);
  assert.match(editor, /getProjectMediaPreviewUrl/);
  assert.match(editor, /data-testid="subtitle-preview-player"/);
  assert.match(editor, /onTimeUpdate/);
  assert.match(editor, /function useReviewPlayback/);
  assert.match(editor, /useSyncExternalStore/);
  assert.match(editor, /pendingSeekRef/);
  assert.match(editor, /window\.requestAnimationFrame/);
  assert.doesNotMatch(editor, /scrollIntoView\(\{ behavior: "smooth"/);
  assert.match(editor, /seekSegment/);
  assert.match(editor, /if \(!c\.setSelectedSegmentId\(segment\.id\)\) return/);
  assert.match(editor, /data-active=/);
  assert.match(editor, /自动跟随/);
  assert.match(editor, /起点设为当前时间/);
  assert.match(editor, /终点设为当前时间/);
  assert.match(editor, /上一处问题/);
  assert.match(editor, /下一处问题/);
  assert.match(editor, /lg:sticky/);
  assert.match(editor, /tableRevealRequest/);
  assert.match(editor, /pendingRevealId/);
  assert.match(editor, /subtitle-preview-overlay/);
  assert.match(editor, /在字幕表格中定位这一段/);
  assert.match(editor, /放大预览/);
  assert.match(editor, /恢复布局/);
  assert.match(editor, /h-\[min\(70vh,720px\)\]/);
  assert.match(editor, /controlsList="nofullscreen"/);
  assert.match(editor, /data-testid="subtitle-style-panel"/);
  assert.match(editor, /应用到当前项目全部字幕/);
  assert.match(editor, /保存预设/);
  assert.match(editor, /c\.saveLibraryResource/);
  assert.match(editor, /showPreviewFields=\{false\}/);
  assert.match(editor, /hidden=\{subtitleStyle\.panelOpen\}/);
  assert.match(editor, /ResizeObserver/);
  assert.match(editor, /scaleX: Math\.max\(0\.1, width \/ 1_280\)/);
  assert.match(editor, /scaleY: Math\.max\(0\.1, height \/ 720\)/);
});

test("P0 unified import has one entry and only asks about concrete ambiguities", () => {
  const start = readFileSync(join(root, "src", "pages", "start-translate-view.tsx"), "utf8");
  const batch = readFileSync(join(root, "src", "pages", "BatchProcessPage.tsx"), "utf8");
  assert.match(start, /data-testid="import-files"/);
  assert.match(start, />\s*导入文件\s*</);
  assert.doesNotMatch(start, /import-media-source|import-subtitle-file|导入视频 \/ 音频|导入字幕文件/);
  assert.match(batch, /只确认有歧义的文件/);
  assert.match(batch, /作为独立字幕项目/);
  assert.doesNotMatch(batch, /高级：检查分组与单独设置|单独设置此项目/);
});

test("P0 source quality gate offers repair or one-run explicit acknowledgement", () => {
  const view = readFileSync(join(root, "src", "pages", "start-translate-view.tsx"), "utf8");
  const controller = readFileSync(join(root, "src", "pages", "start-translate-controller.ts"), "utf8");
  assert.match(view, /检查源字幕/);
  assert.match(view, /用媒体重新识别/);
  assert.match(view, /仍使用原时间轴继续/);
  assert.match(controller, /allowUnsafeSource/);
});

test("project workflow uses in-place configuration and user-facing recovery steps", () => {
  const config = readFileSync(
    join(root, "src", "components", "feature", "project-overview", "ProjectConfigPanel.tsx"),
    "utf8",
  );
  const overview = readFileSync(join(root, "src", "pages", "ProjectOverviewPage.tsx"), "utf8");
  const editor = readFileSync(join(root, "src", "pages", "SubtitleEditorPage.tsx"), "utf8");
  const button = readFileSync(join(root, "src", "components", "ui", "Button.tsx"), "utf8");

  assert.match(config, /open \? <ConfigEditor project=\{project\} \/> : <ConfigSummary project=\{project\} \/>/);
  assert.match(overview, /安装或检查语音识别模型/);
  assert.match(overview, /生成字幕并翻译/);
  assert.match(editor, /批量修改译文/);
  assert.match(editor, /查找位置/);
  assert.match(editor, /怎么处理/);
  assert.doesNotMatch(editor, /搜索与普通替换/);
  assert.match(button, /enabled:cursor-pointer/);
});

test("Phase 13 renderer has no knowingly fake actions or placeholder state", () => {
  const files = [
    "src/layout/Sidebar.tsx",
    "src/layout/TopWindowBar.tsx",
    "src/pages/start-translate-view.tsx",
    "src/pages/TaskCenterPage.tsx",
    "src/pages/model-api-view.tsx",
    "src/pages/ProjectOverviewPage.tsx",
    "src/pages/SettingsPage.tsx",
    "src/pages/SubtitleEditorPage.tsx",
  ];
  const renderer = files.map((file) => readFileSync(join(root, file), "utf8")).join("\n");
  assert.doesNotMatch(renderer, /\bmock\b|\bDemo\b|模型演示列表|静态演示|演示任务|将在 Phase|当前阶段范围/);
  assert.doesNotMatch(renderer, /本地 Qwen|ParameterPanel|预览字幕效果/);
  assert.doesNotMatch(readFileSync(join(root, "src/pages/start-translate-view.tsx"), "utf8"), /role="button"/);
});

test("Phase 13 shared controls expose keyboard and assistive semantics", () => {
  const tabs = readFileSync(join(root, "src/components/ui/Tabs.tsx"), "utf8");
  const toggle = readFileSync(join(root, "src/components/ui/Toggle.tsx"), "utf8");
  const topBar = readFileSync(join(root, "src/layout/TopWindowBar.tsx"), "utf8");
  for (const marker of ["tablist", "aria-selected", "ArrowLeft", "ArrowRight", "Home", "End"]) {
    assert.match(tabs, new RegExp(marker));
  }
  assert.match(toggle, /role="switch"/);
  assert.match(toggle, /aria-checked/);
  assert.match(topBar, /aria-expanded/);
  assert.match(topBar, /Escape/);
});

test("Phase 13 search is actionable and model controls only expose real capabilities", () => {
  const tasks = readFileSync(join(root, "src/pages/TaskCenterPage.tsx"), "utf8");
  const model = readFileSync(join(root, "src/pages/model-api-view.tsx"), "utf8");
  assert.match(tasks, /value=\{query\}/);
  assert.match(tasks, /setQuery\(event\.target\.value\)/);
  assert.doesNotMatch(tasks, /placeholder=\{currentSearchPlaceholder\}\s+disabled/);
  assert.doesNotMatch(model, /type="range"|导入模型配置|保存所有设置/);
});

test("Phase 13 browser preview cannot manufacture translation or export success", () => {
  const context = readFileSync(join(root, "src/state/WorkspaceContext.tsx"), "utf8");
  assert.match(context, /浏览器预览不读取本地文件/);
  assert.match(context, /浏览器预览不执行翻译/);
  assert.match(context, /浏览器预览不写出文件/);
  assert.doesNotMatch(context, /createStartArtifacts|重跑演示|mock-candidate|演示文本将共享/);
});

test("task controls show pause or stop from the real task capability", () => {
  const banner = readFileSync(
    join(root, "src", "components", "feature", "project-overview", "RunProgressBanner.tsx"),
    "utf8",
  );
  const batch = readFileSync(join(root, "src", "pages", "BatchProcessPage.tsx"), "utf8");
  const primaryControl = readFileSync(
    join(root, "src", "components", "feature", "TaskPrimaryControl.tsx"),
    "utf8",
  );
  const workspace = readFileSync(join(root, "src", "domain", "workspace.ts"), "utf8");
  // 控制键此前只在「项目与任务 → 任务」页的底栏，用户点完开始翻译根本不会走到那里。
  for (const phrase of ["停止", "controlTask", "TaskPrimaryControlButton", "data-testid=\"run-progress-banner\""]) {
    assert.match(banner, new RegExp(phrase));
  }
  assert.match(batch, /TaskPrimaryControlButton/);
  assert.match(primaryControl, /getPrimaryTaskControl/);
  for (const phrase of ["暂停", "继续", "停止"]) assert.match(workspace, new RegExp(phrase));
  assert.doesNotMatch(banner, /disabled=\{busy \|\| !pausable\}/);
  // 后端 detail 是英文常量（"Queued" / "Running"），中文界面不能原样展示。
  assert.doesNotMatch(banner, /task\.detail \|\| task\.label/);
});

test("finished projects expose lifecycle actions in their project overview", () => {
  const actions = readFileSync(
    join(root, "src", "components", "feature", "project-overview", "ProjectLifecycleActions.tsx"),
    "utf8",
  );
  for (const phrase of ["重新翻译", "删除项目", "ConfirmDialog"]) {
    assert.match(actions, new RegExp(phrase));
  }
  assert.doesNotMatch(actions, /window\.confirm/);
  const overview = readFileSync(join(root, "src/pages/ProjectOverviewPage.tsx"), "utf8");
  const projectList = readFileSync(join(root, "src/pages/TaskCenterPage.tsx"), "utf8");
  assert.match(overview, /RetranslateButton/);
  assert.match(overview, /DeleteProjectButton/);
  assert.doesNotMatch(projectList, /RetranslateButton|DeleteProjectButton/);
});

test("finished work exposes one approval/export action and QA stays grouped with cyclic location", () => {
  const banner = readFileSync(
    join(root, "src", "components", "feature", "project-overview", "RunProgressBanner.tsx"),
    "utf8",
  );
  const editor = readFileSync(join(root, "src", "pages", "SubtitleEditorPage.tsx"), "utf8");
  for (const phrase of ["批准并导出", "定位下一处", "delivery.errorGroups", "delivery-closure-message"]) {
    assert.match(banner, new RegExp(phrase));
  }
  assert.doesNotMatch(banner, /1\. 进入校对|2\. 批准|3\. 导出/);
  for (const phrase of ["字幕问题按类型汇总", "定位下一处", "groupedIssues"]) assert.match(editor, new RegExp(phrase));
  assert.match(editor, /请先明确批准当前目标轨/);
  assert.doesNotMatch(editor, /issues\.map\(\(issue\)/, "QA must not render every issue as a full card");
});

test("core translation flow keeps optional tools behind progressive disclosure", () => {
  const sidebar = readFileSync(join(root, "src/layout/Sidebar.tsx"), "utf8");
  const controller = readFileSync(join(root, "src/pages/start-translate-controller.ts"), "utf8");
  const start = readFileSync(join(root, "src/pages/start-translate-view.tsx"), "utf8");
  const overview = readFileSync(join(root, "src/pages/ProjectOverviewPage.tsx"), "utf8");
  const automaticBanner = readFileSync(
    join(root, "src/components/feature/AutomaticWorkflowBanner.tsx"),
    "utf8",
  );

  for (const label of ["开始翻译", "项目", "模型与连接", "设置", "高级工具"]) {
    assert.match(sidebar, new RegExp(label));
  }
  assert.match(sidebar, /<details/);
  assert.match(controller, /if \(!requestedProjectId\) return undefined/);
  assert.match(controller, /runAutomaticProjectWorkflow/);
  for (const phrase of ["系统会自动完成可以省略的步骤", "最近项目", "高级设置", "自动流程"]) {
    assert.match(start, new RegExp(phrase));
  }
  for (const phrase of ["已导入", "生成字幕", "翻译", "检查", "导出", "修改配置"]) {
    assert.match(overview, new RegExp(phrase));
  }
  assert.doesNotMatch(overview, /project-advanced-tools|媒体与源轨、语音识别、项目配置、历史记录、打包/);
  assert.match(automaticBanner, /正在自动处理/);
  for (const phrase of ["只需要确认一件事", "确认并继续", "手动检查", "剩余时间"]) {
    assert.match(automaticBanner, new RegExp(phrase));
  }
  assert.match(automaticBanner, /<fieldset>/);
  assert.match(automaticBanner, /\(stageNumber - 1\) \+ boundedRecognitionProgress \/ 100/);
  assert.match(automaticBanner, /识别进度 \{boundedRecognitionProgress\}%/);
  assert.match(start, /recognitionProgress=\{controller\.recognitionProgress\}/);
  assert.match(overview, /recognitionProgress=\{recognitionProgress\}/);

  const projectList = readFileSync(join(root, "src/pages/TaskCenterPage.tsx"), "utf8");
  assert.doesNotMatch(projectList, /<Tabs|controlTask|进入项目概览/);
  assert.match(projectList, /onOpen=\{\(\) => navigate\(`\/projects\/\$\{project\.id\}`\)\}/);
});

test("fetched models restore without a manual connection test and external workflow blocks can retry", () => {
  const controller = readFileSync(join(root, "src/pages/model-api-controller.ts"), "utf8");
  const start = readFileSync(join(root, "src/pages/start-translate-view.tsx"), "utf8");
  const workspace = readFileSync(join(root, "src/state/WorkspaceContext.tsx"), "utf8");
  assert.match(controller, /configuredModels\?\.length[\s\S]*setFetchedOptions/);
  assert.match(start, /workflow\?\.status === "blocked" && Boolean\(workflow\.resolution\)/);
  assert.match(start, /重新检查并继续/);
  assert.match(workspace, /runs\.find\(\(run\) => run\.modelId === selectedAsrModelId\)/);
  assert.match(workspace, /latestAsrRunId = step\.asrRunId;/);
});

test("a fresh desktop workspace shows one compact real readiness checklist", () => {
  const controller = readFileSync(join(root, "src/pages/start-translate-controller.ts"), "utf8");
  const start = readFileSync(join(root, "src/pages/start-translate-view.tsx"), "utf8");
  assert.match(controller, /desktopGetCapabilityReadiness/);
  assert.match(controller, /activeProjects\.length === 0/);
  for (const phrase of ["首次使用检查", "翻译模型", "FFmpeg 已内置并通过校验", "语音转字幕", "按需安装"]) {
    assert.match(start, new RegExp(phrase));
  }
  assert.match(start, /data-testid="first-run-readiness"/);
});

test("P2 review workbench exposes a zoomable waveform with draggable persisted boundaries", () => {
  const editor = readFileSync(join(root, "src/pages/SubtitleEditorPage.tsx"), "utf8");
  const context = readFileSync(join(root, "src/state/WorkspaceContext.tsx"), "utf8");
  assert.match(editor, /data-testid="subtitle-waveform-timeline"/);
  assert.match(editor, /aria-label="波形缩放"/);
  assert.match(editor, /\["start", "end"\] as const/);
  assert.match(editor, /data-waveform-handle=\{edge\}/);
  assert.match(editor, /runTimelineEdit\(\{ kind: "nudge"/);
  assert.match(editor, /setWaveform\(null\);[\s\S]*getProjectMediaWaveform/);
  assert.match(context, /const getProjectMediaWaveform = useCallback/);
});

test("P2 batch task list exposes persisted set-next control only for pending tasks", () => {
  const page = readFileSync(join(root, "src/pages/BatchProcessPage.tsx"), "utf8");
  assert.match(page, /task\.status === "pending"[\s\S]*设为下一项/);
  assert.match(page, /action: "prioritize"|"prioritize"/);
});

test("P2 glossary editor extracts frequent subtitle terms before adding a fixed translation", () => {
  const editor = readFileSync(join(root, "src/components/feature/resource-library/GlossaryEditor.tsx"), "utf8");
  assert.match(editor, /从项目字幕提取高频术语/);
  assert.match(editor, /extractFrequentTerms/);
  assert.match(editor, /固定译文/);
  assert.match(editor, /加入术语表/);
});

test("P2 glossary editor exchanges CSV and TSV through the structured glossary draft", () => {
  const editor = readFileSync(join(root, "src/components/feature/resource-library/GlossaryEditor.tsx"), "utf8");
  for (const phrase of ["导入 CSV/TSV", "导出 CSV", "导出 TSV", "parseGlossaryDelimited", "serializeGlossaryDelimited"]) {
    assert.match(editor, new RegExp(phrase));
  }
  assert.match(editor, /accept="\.csv,\.tsv,text\/csv,text\/tab-separated-values"/);
  assert.match(editor, /role="status"[\s\S]*\{exchangeMessage\}/);
});

test("rc.4 review history actions use unambiguous labels", () => {
  const subtitleEditor = readFileSync(join(root, "src", "pages", "SubtitleEditorPage.tsx"), "utf8");
  assert.match(subtitleEditor, />撤销修改</);
  assert.match(subtitleEditor, />恢复撤销</);
});

test("rc.4 batch queue exposes its priority control without a low-contrast advanced label", () => {
  const batch = readFileSync(join(root, "src", "pages", "BatchProcessPage.tsx"), "utf8");
  assert.match(batch, /任务调度与优先级/);
  assert.match(batch, /item\.task\?\.status === "pending"[\s\S]*设为下一项/);
});

test("rc.4 subtitle style uses bounded choices and native color pickers", () => {
  const subtitleStyle = readFileSync(join(root, "src", "components", "feature", "resource-library", "SubtitleStyleEditor.tsx"), "utf8");
  for (const marker of [
    "FONT_OPTIONS",
    "FONT_SIZE_OPTIONS",
    "ASS（保留字体、颜色和描边）",
    "SRT / VTT 是纯文本格式",
    "Microsoft YaHei",
    'type="color"',
  ]) {
    assert.match(subtitleStyle, new RegExp(marker));
  }
});
