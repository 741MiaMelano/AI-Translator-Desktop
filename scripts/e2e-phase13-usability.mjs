import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { closeElectronApp } from "./electron-test-lifecycle.mjs";

process.noDeprecation = true;

const userDataDir = mkdtempSync(join(tmpdir(), "phase13-usability-"));
const screenshotDir = process.env.BATCH_E2E_SCREENSHOT_DIR || null;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const fixturePath = join(dirname(dirname(fileURLToPath(import.meta.url))), "tests", "fixtures", "subtitles", "valid", "basic-utf8.srt");
const secondFixturePath = join(dirname(fixturePath), "中文 空格.vtt");
let app;

try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      TRANSLATION_FAKE_PROVIDER: "1",
      SUBTITLE_E2E_EXPORT_DIR: join(userDataDir, "e2e-exports"),
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 720));
  await page.getByRole("heading", { name: "开始翻译" }).waitFor();

  for (const zoomFactor of [1, 1.25, 1.5]) {
    await app.evaluate(({ BrowserWindow }, factor) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor);
    }, zoomFactor);
    await page.waitForTimeout(100);
    const metrics = await page.evaluate(() => {
      const dock = document.querySelector(".bottom-action-dock");
      const dockRect = dock?.getBoundingClientRect();
      const visibleControls = [...document.querySelectorAll("button, input, select, textarea, a")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      return {
        innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        dockLeft: dockRect?.left ?? 0,
        dockRight: dockRect?.right ?? 0,
        dockScrollWidth: dock?.scrollWidth ?? 0,
        dockClientWidth: dock?.clientWidth ?? 0,
        escapedControls: visibleControls
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.left < -1 || rect.right > innerWidth + 1;
          })
          .map((element) => element.textContent?.trim() || element.getAttribute("aria-label") || element.tagName),
        longestCopy: Math.max(...[...document.querySelectorAll("p, button, label")].map((element) => element.textContent?.trim().length ?? 0)),
      };
    });
    assert.ok(metrics.documentWidth <= metrics.innerWidth + 1, JSON.stringify({ zoomFactor, metrics }));
    assert.ok(metrics.bodyWidth <= metrics.innerWidth + 1, JSON.stringify({ zoomFactor, metrics }));
    assert.ok(metrics.dockLeft >= 0 && metrics.dockRight <= metrics.innerWidth + 1, JSON.stringify({ zoomFactor, metrics }));
    assert.ok(metrics.dockScrollWidth <= metrics.dockClientWidth + 1, JSON.stringify({ zoomFactor, metrics }));
    assert.deepEqual(metrics.escapedControls, []);
    assert.ok(metrics.longestCopy >= 30, JSON.stringify({ zoomFactor, metrics }));
  }

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1));
  await page.evaluate(() => { window.location.hash = "#/workspace"; });
  await page.getByRole("heading", { name: "项目", exact: true }).waitFor();
  await expect(page.getByRole("tab", { name: "任务" })).toHaveCount(0);
  const help = page.getByRole("button", { name: "帮助" });
  await help.click();
  await expect(page.getByRole("region", { name: "帮助" })).toBeVisible();
  await help.press("Escape");
  await expect(page.getByRole("region", { name: "帮助" })).toHaveCount(0);
  assert.doesNotMatch(await page.locator("body").innerText(), /\bDemo\b|\bmock\b|演示任务/);

  await page.getByRole("link", { name: "模型与连接" }).click();
  await page.getByLabel("API Key").fill("sk-phase13-local-fake");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByText("密钥已保存", { exact: true }).waitFor();
  await page.getByRole("button", { name: "测试连接" }).click();
  await page.getByText("连接测试通过", { exact: true }).waitFor();
  await page.getByRole("link", { name: "开始翻译" }).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入文件" }).click();
  await (await chooserPromise).setFiles(fixturePath);
  try {
    await page.getByRole("heading", { name: "basic-utf8" }).waitFor();
  } catch (error) {
    console.error("Phase 13 import page:", (await page.locator("body").innerText()).slice(0, 3000));
    throw error;
  }
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "开始翻译" }).click();
  try {
    await page.getByText("待校对").first().waitFor({ timeout: 30_000 });
  } catch (error) {
    console.error("Phase 13 translation page:", (await page.locator("body").innerText()).slice(0, 3000));
    throw error;
  }
  const projectId = await page.evaluate(() => window.location.hash.split("/")[2]);
  assert.ok(projectId);
  if (screenshotDir) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await page.screenshot({ path: join(screenshotDir, "project-overview-simplified.png") });
  }
  await expect(page.getByRole("button", { name: "批准并导出", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "先校对", exact: true }).click();
  await page.getByTestId("subtitle-editor-workbench").waitFor();
  const reviewWorkbench = page.getByTestId("subtitle-review-workbench");
  await expect(reviewWorkbench).toHaveAttribute("data-expanded", "false");
  await page.getByRole("button", { name: "放大预览", exact: true }).click();
  await expect(reviewWorkbench).toHaveAttribute("data-expanded", "true");
  await expect(page.getByTestId("review-workbench-player")).toHaveAttribute("data-expanded", "true");
  await expect(page.getByTestId("subtitle-editor-table")).toBeVisible();
  await page.getByRole("button", { name: "恢复布局", exact: true }).click();
  await expect(reviewWorkbench).toHaveAttribute("data-expanded", "false");
  const firstRow = page.locator('tr[data-testid^="subtitle-row-"]').first();
  const reviewLayout = await firstRow.evaluate((row) => {
    const cells = [...row.querySelectorAll(":scope > td")].map((cell) => Math.round(cell.getBoundingClientRect().width));
    const rowRect = row.getBoundingClientRect();
    let viewport = row.parentElement;
    while (viewport && !["auto", "scroll"].includes(getComputedStyle(viewport).overflowX)) viewport = viewport.parentElement;
    const viewportRect = viewport?.getBoundingClientRect();
    return {
      cells,
      rowRight: Math.round(rowRect.right),
      viewportRight: Math.round(viewportRect?.right ?? innerWidth),
    };
  });
  assert.ok(reviewLayout.cells[2] >= 120, JSON.stringify(reviewLayout));
  assert.ok(reviewLayout.cells[3] >= 180, JSON.stringify(reviewLayout));
  assert.ok(reviewLayout.rowRight <= reviewLayout.viewportRight + 1, JSON.stringify(reviewLayout));
  await expect(page.getByRole("button", { name: "撤销修改", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复撤销", exact: true })).toBeVisible();
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "subtitle-editor-readable.png") });
  const firstEditor = firstRow.locator('textarea[data-testid^="subtitle-editor-"]');
  await firstEditor.fill("Phase 13 待保存草稿 / unsaved draft");
  await page.getByRole("button", { name: "字幕样式", exact: true }).click();
  await expect(page.getByTestId("subtitle-table-panel")).toBeHidden();
  await expect(page.getByTestId("subtitle-style-panel")).toBeVisible();
  await page.getByRole("group", { name: "主字幕（译文）" }).getByLabel("字号（px）").selectOption("64");
  await expect(page.getByText("字幕样式还有未应用的修改，请先应用或返回字幕表格放弃修改", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate((id) => Boolean(localStorage.getItem(`subtitle-style-draft:${id}`)), projectId)).toBe(true);
  await page.getByRole("button", { name: "应用到当前项目全部字幕", exact: true }).click();
  await page.getByText("已应用到当前项目全部字幕，后续 ASS 导出和视频烧录会使用这套样式。", { exact: true }).waitFor();
  await expect.poll(async () => page.evaluate(async (id) => {
    const result = await window.desktop.openProject({ projectId: id });
    return result.ok ? result.data.config.subtitleStyle?.primary.fontSizePx : null;
  }, projectId)).toBe(64);
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`subtitle-style-draft:${id}`), projectId)).toBe(null);
  await page.getByRole("button", { name: "返回字幕表格", exact: true }).click();
  await expect(page.getByTestId("subtitle-style-panel")).toBeHidden();
  await expect(page.getByTestId("subtitle-table-panel")).toBeVisible();
  await expect(firstEditor).toHaveValue("Phase 13 待保存草稿 / unsaved draft");
  await firstEditor.fill("Phase 13 人工校对稿 / manually reviewed");
  await firstRow.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "重新检查字幕" }).click();
  await page.getByText("字幕检查已更新").waitFor();
  await page.getByRole("button", { name: "返回项目概览", exact: true }).click();
  await page.getByRole("button", { name: "批准并导出", exact: true }).click();
  const exportMessage = page.getByTestId("delivery-closure-message");
  await exportMessage.waitFor({ timeout: 30_000 });
  const exportText = await exportMessage.innerText();
  assert.match(exportText, /^已保存 1 个字幕文件到你选择的位置，并在资源管理器中定位。$/, `alerts: ${await page.getByRole("alert").allTextContents()}`);
  const completed = await page.evaluate((id) => window.desktop.openProject({ projectId: id }), projectId);
  assert.equal(completed.ok, true);
  const source = completed.data.sourceTracks.find((track) => track.id === completed.data.activeSourceTrackId);
  assert.equal(source.targetTracks.find((track) => track.isActive).status, "exported");
  assert.equal(source.segments[0].targetTexts[source.targetTracks.find((track) => track.isActive).languageCode].manual, "Phase 13 人工校对稿 / manually reviewed");

  await page.getByRole("link", { name: "开始翻译" }).click();
  const batchChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入文件" }).click();
  await (await batchChooserPromise).setFiles([fixturePath, secondFixturePath]);
  await page.getByRole("heading", { name: "批量处理" }).waitFor();
  await expect(page.getByText(/系统按项目自动完成字幕提取、识别与翻译/)).toBeVisible();
  await expect(page.getByText("只确认有歧义的文件", { exact: true })).toHaveCount(0);
  try {
    await expect(page.getByRole("button", { name: "开始处理 2 个项目" })).toBeVisible();
  } catch (error) {
    console.error("Phase 13 batch page:", (await page.locator("body").innerText()).slice(0, 3000));
    throw error;
  }
  if (screenshotDir) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await page.screenshot({ path: join(screenshotDir, "batch-review.png") });
  }
  await page.getByRole("button", { name: "开始处理 2 个项目" }).click();
  await page.getByRole("button", { name: "批准并导出 2 个项目" }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "批准并导出 2 个项目" }).click();
  await page.getByText("已导出 2 份字幕，保存文件夹只选择了一次。", { exact: true }).waitFor({ timeout: 30_000 });
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "batch-delivered.png") });
  await page.getByRole("button", { name: "返回项目" }).click();
  await page.getByText(/已完成或已归档 3 个/).waitFor();
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "task-center-folded.png") });

  await closeElectronApp(app);
  app = undefined;
  console.log("Phase 13 usability smoke passed: single and batch import -> automatic translate -> one-folder delivery");
} finally {
  if (app) await closeElectronApp(app).catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}
