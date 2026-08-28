import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("FR-03C routes expose the A-brass system settings and global task surfaces", () => {
  const app = read("src/frontend/App.tsx");
  const system = read("src/frontend/pages.tsx");
  for (const route of ["/system/settings", "/workspace/tasks", "/projects/:projectId"]) {
    assert.match(app, new RegExp(route.replaceAll("/", "\\/")));
  }
  // 项目阶段改为嵌套路由声明（父路径 + 子段），断言子段的同时钉住它真实的页面组件。
  assert.match(app, /path="settings"\s+element=\{<ProjectSettingsPage\/>\}/);
  for (const destination of ["/system/providers", "/system/asr", "/system/settings", "/workspace/tasks"]) {
    assert.match(system, new RegExp(destination.replaceAll("/", "\\/")));
  }
});

test("FR-03C settings surface is backed by real settings, storage, backup and diagnostic services", () => {
  const page = read("src/frontend/SettingsPage.tsx");
  const controller = read("src/controllers/settings-controller.ts");
  for (const section of ["启动与默认能力", "模型与运行时迁移", "模型下载源", "环境能力", "备份与诊断", "关于"]) {
    assert.match(page, new RegExp(section));
  }
  for (const operation of [
    "desktopGetAppSettings",
    "desktopSaveAppSettings",
    "desktopResetAppSettings",
    "desktopSelectSettingsDirectory",
    "desktopTransferModelStorage",
    "desktopProbeDownloadSources",
    "desktopGetCapabilityReadiness",
    "desktopCreateAppBackup",
    "desktopCreateProjectPackage",
    "desktopSelectBackupRestore",
    "desktopApplyBackupRestore",
    "desktopPreviewDiagnostics",
    "desktopExportDiagnostics",
  ]) {
    assert.match(controller, new RegExp(operation));
  }
});

test("FR-03C destructive and network-sensitive settings actions use explicit in-product confirmation", () => {
  const page = read("src/frontend/SettingsPage.tsx");
  const controller = read("src/controllers/settings-controller.ts");
  for (const phrase of ["恢复默认系统设置", "转移全部模型与运行时", "联网探测下载源", "确认并恢复", "userConfirmed: true"]) {
    assert.match(`${page}\n${controller}`, new RegExp(phrase));
  }
  assert.doesNotMatch(`${page}\n${controller}`, /window\.confirm|window\.alert|CustomEvent|dispatchEvent/);
  assert.match(page, /当前后端没有更新器按钮/);
});
