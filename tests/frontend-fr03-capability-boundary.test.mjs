import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

test("FR-03A routes expose real project, task, archive and recycle surfaces", () => {
  const app = read("src", "frontend", "App.tsx");
  for (const route of [
    "/workspace/tasks",
    "/workspace/archive",
    "/workspace/recycle",
    "/projects/:projectId",
  ]) assert.match(app, new RegExp(route.replaceAll("/", "\\/")));
  // 项目阶段改为嵌套路由声明（父路径 + 子段），断言子段的同时钉住它真实的页面组件。
  assert.match(app, /path="settings"\s+element=\{<ProjectSettingsPage\/>\}/);
});

test("FR-03A bulk controls cross the real workflow and task boundaries", () => {
  const workspace = read("src", "frontend", "WorkspacePage.tsx");
  assert.match(workspace, /runAutomaticProjectWorkflow/);
  assert.match(workspace, /controlTask/);
  assert.match(workspace, /action:\s*primary\.action/);
  assert.match(workspace, /"prioritize"/);
  assert.match(workspace, /approveAndExportBatchTargets/);
  assert.match(workspace, /trashProject/);
  // 永久删除只对勾选的生效：底栏写着"已选择 N 个"，旁边的删除按钮就必须只删那 N 个，
  // 不能是一个不看选择、清空整个回收站的操作。
  assert.match(workspace, /deleteTrashedProjects\(selected\.map\(\(project\) => project\.id\)\)/);
  assert.doesNotMatch(workspace, /clearTrashedProjects|recycle-danger-zone/);
  assert.match(workspace, /Provider[^\n]*可能产生费用/);
  assert.doesNotMatch(workspace, /data-demo-action|mock|fake success/i);
});

test("FR-03A project assets expose real snapshots, track trash and package APIs", () => {
  const settings = read("src", "frontend", "ProjectSettingsPage.tsx");
  for (const call of [
    "desktopListProjectResourceSnapshots",
    "refreshProjectResourceSnapshot",
    "trashProjectSourceTrack",
    "restoreProjectSourceTrack",
    "trashProjectTargetTrack",
    "restoreProjectTargetTrack",
    "emptyProjectTrackTrash",
    "createProjectPackage",
    "exportSourceSubtitle",
  ]) assert.match(settings, new RegExp(call));
  assert.match(settings, /付费确认不可关闭/);
  assert.match(settings, /预算字段已由后端废弃/);
  assert.doesNotMatch(settings, /30\s*天|自动备份|关闭付费确认/);
});
