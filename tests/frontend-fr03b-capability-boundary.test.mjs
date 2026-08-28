import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("FR-03B routes expose the new A-brass provider, ASR, media and resource surfaces", () => {
  const app = read("src/frontend/App.tsx");
  for (const route of ["/system/providers", "/system/asr", "/media", "/projects/:projectId", "/library"]) {
    assert.match(app, new RegExp(route.replaceAll("/", "\\/")));
  }
  // 项目阶段改为嵌套路由声明（父路径 + 子段），断言子段的同时钉住它真实的页面组件。
  assert.match(app, /path="media"\s+element=\{<MediaPage\/>\}/);
  assert.match(app, /ProviderPage/);
  assert.match(app, /AsrMaintenancePage/);
  assert.match(app, /MediaPage/);
  assert.match(app, /LibraryPage/);
});

test("FR-03B provider and ASR maintenance stays behind real services and explicit network confirmation", () => {
  const page = read("src/frontend/CapabilitiesPage.tsx");
  const controller = read("src/controllers/model-api-controller.ts");
  for (const phrase of ["连接 Provider 拉取模型", "测试真实 Provider 连接", "下载模型", "下载 CUDA 运行时", "系统安全凭据"]) {
    assert.match(page, new RegExp(phrase));
  }
  for (const call of ["desktopListProviderModels", "desktopTestProviderConnection", "desktopInstallAsrModel", "desktopImportAsrModel", "desktopInstallAsrRuntime", "desktopDetectAsrDevices", "desktopSaveAppSettings"]) {
    assert.match(controller, new RegExp(call));
  }
  assert.doesNotMatch(page, /唱词组件没有本地导入|disabled title="唱词/);
});

test("FR-03B media tools use persisted project operations without exposing an unavailable public separation stub", () => {
  const media = read("src/frontend/MediaPage.tsx");
  for (const operation of ["probeProjectMedia", "selectProjectMediaStreams", "extractProjectSubtitle", "exportProjectAudio", "relinkProjectMedia", "getProjectMediaWaveform", "runProjectAsr", "segmentProjectAsrRun", "detectProjectAsrLanguages", "updateProjectAsrLanguages"]) {
    assert.match(media, new RegExp(operation));
  }
  assert.doesNotMatch(media, /desktopStartAudioSeparation|开始本机分离/);
  assert.match(media, /确认并开始/);
  assert.match(media, /操作已结束，未产生新结果/);
  assert.doesNotMatch(media, /Math\.random\(\).*peak|mockWaveform|demoProgress/i);
});

test("FR-03B resource library covers all backend resource kinds and structured exchange", () => {
  const library = read("src/frontend/LibraryPage.tsx");
  for (const kind of ["glossary", "style_guide", "subtitle_style", "export_preset"]) {
    assert.match(library, new RegExp(`\"${kind}\"`));
  }
  for (const operation of ["saveLibraryResource", "deleteLibraryResource", "parseGlossaryDelimited", "serializeGlossaryDelimited", "describePayloadProblem"]) {
    assert.match(library, new RegExp(operation));
  }
  assert.match(library, /浏览器预览为只读/);
  assert.match(read("src/frontend/ProjectSettingsPage.tsx"), /refreshProjectResourceSnapshot/);
});
