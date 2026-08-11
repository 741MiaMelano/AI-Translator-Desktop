import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import electronPath from "electron";

import { closeElectronApp } from "./electron-test-lifecycle.mjs";

process.noDeprecation = true;

const userDataDir = mkdtempSync(join(tmpdir(), "p10-resource-tabs-e2e-"));
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const glossaryCsv = join(root, "docs", "samples", "glossary-import-example.csv");
const glossaryTsv = join(root, "docs", "samples", "glossary-import-example.tsv");
let app;

try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    timeout: 60_000,
  });
  let page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });

  const saved = await page.evaluate(() => window.desktop.saveResource({
    resource: {
      id: "subtitle-style-tab-reset",
      kind: "subtitle_style",
      name: "P10 tab reset fixture",
      description: "Exercises an empty target resource tab.",
      payload: {
        format: "ass",
        bilingualLayout: "target_only",
        primary: {
          fontFamily: "Definitely Missing P10 Font",
          fontSizePx: 34,
          textColor: "#FFFFFF",
          outlineColor: "#000000",
          outlineWidthPx: 1,
          shadowColor: "#FFD700",
          shadowDepthPx: 2,
          position: "bottom",
        },
        secondary: {
          fontFamily: "Courier New",
          fontSizePx: 16,
          textColor: "#EEEEEE",
          outlineColor: "#222222",
          outlineWidthPx: 1,
          shadowColor: "#000000",
          shadowDepthPx: 1,
          position: "center",
        },
        preview: {
          sourceText: "Source preview",
          targetText: "目标预览",
          direction: "auto",
          backgroundColor: "#19451F",
        },
      },
    },
  }));
  assert.equal(saved.ok, true, "fixture resource should be persisted");

  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await page.evaluate(() => { window.location.hash = "/library"; });
  await page.getByRole("heading", { name: "资源库" }).waitFor();
  await page.getByRole("button", { name: "新建术语表", exact: true }).first().click();
  let chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入 CSV/TSV", exact: true }).click();
  await (await chooser).setFiles(glossaryCsv);
  await page.getByText("已导入 3 条到草稿；保存后生效。", { exact: true }).waitFor();
  chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入 CSV/TSV", exact: true }).click();
  await (await chooser).setFiles(glossaryTsv);
  await page.getByText("已导入 2 条到草稿，跳过 1 条重复项；保存后生效。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("已保存，当前是第 1 版", { exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await page.evaluate(() => { window.location.hash = "/library"; });
  await page.getByRole("tab", { name: "术语库", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('input[placeholder="原文"]')]
    .some((input) => input.value === "DeepSeek"));
  const sourceTerms = await page.getByPlaceholder("原文").evaluateAll((inputs) => inputs.map((input) => input.value));
  assert.ok(sourceTerms.includes("DeepSeek"), "saved CSV term must reload");
  await page.evaluate(() => {
    const capture = { names: [], texts: [] };
    window.__glossaryDownloadCapture = capture;
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      void blob.text().then((text) => capture.texts.push(text));
      return createObjectURL(blob);
    };
    HTMLAnchorElement.prototype.click = function captureGlossaryDownload() {
      capture.names.push(this.download);
    };
  });
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  await page.waitForFunction(() => window.__glossaryDownloadCapture?.texts.length === 1);
  const csvCapture = await page.evaluate(() => window.__glossaryDownloadCapture);
  assert.match(csvCapture.names[0], /\.csv$/);
  const exportedCsv = csvCapture.texts[0];
  for (const term of ["DeepSeek", "GPU", "자막"]) assert.match(exportedCsv, new RegExp(term));
  await page.getByRole("button", { name: "导出 TSV", exact: true }).click();
  await page.waitForFunction(() => window.__glossaryDownloadCapture?.texts.length === 2);
  const tsvCapture = await page.evaluate(() => window.__glossaryDownloadCapture);
  assert.match(tsvCapture.names[1], /\.tsv$/);
  const exportedTsv = tsvCapture.texts[1];
  for (const term of ["DeepSeek", "GPU", "자막"]) assert.match(exportedTsv, new RegExp(term));

  await page.getByRole("tab", { name: "字幕样式", exact: true }).click();
  await page.getByText("P10 tab reset fixture", { exact: true }).first().waitFor();
  await page.locator('[data-ass-preview="track-style"]').waitFor();
  const primaryFontSize = page.getByLabel("字号（px）").first();
  await primaryFontSize.selectOption("40");
  await page.getByLabel("字体").first().selectOption("Microsoft YaHei");
  await page.getByLabel("文字颜色选择器").first().fill("#00aaee");
  assert.equal(
    await page.locator('[data-ass-preview="track-style"] > div > div').last().evaluate((element) => element.style.fontSize),
    "40px",
    "structured subtitle style changes must update the preview immediately",
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("已保存，当前是第 2 版", { exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await page.evaluate(() => { window.location.hash = "/library"; });
  await page.getByRole("tab", { name: "字幕样式", exact: true }).click();
  assert.equal(await page.getByLabel("字号（px）").first().inputValue(), "40", "saved style form must reload");
  assert.equal(await page.getByLabel("字体").first().inputValue(), "Microsoft YaHei", "saved font choice must reload");
  assert.equal(await page.getByLabel("文字颜色选择器").first().inputValue(), "#00aaee", "saved color choice must reload");
  await page.getByRole("button", { name: "高级：直接编辑 JSON" }).click();
  await page.getByLabel("内容（JSON）").waitFor();

  await page.getByRole("tab", { name: "导出预设", exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator('[data-ass-preview="track-style"]').count(),
    0,
    "an empty export-preset tab must not retain the subtitle-style ASS preview",
  );
  assert.equal(
    await page.getByText("P10 tab reset fixture", { exact: true }).count(),
    0,
    "an empty export-preset tab must not retain the subtitle-style draft",
  );

  await page.getByRole("button", { name: "新建导出预设", exact: true }).first().click();
  assert.equal(await page.getByLabel("内容（JSON）").count(), 0, "JSON editor must default closed for each resource");
  await page.getByLabel("文件名模板").fill("{project}-{language}-{content}-final");
  await page.getByText("示例项目-zh-CN-target-final.srt", { exact: true }).waitFor();
  await page.getByRole("switch", { name: "同时烧录视频" }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("已保存，当前是第 1 版", { exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await page.evaluate(() => { window.location.hash = "/library"; });
  await page.getByRole("tab", { name: "导出预设", exact: true }).click();
  assert.equal(await page.getByLabel("文件名模板").inputValue(), "{project}-{language}-{content}-final", "saved export preset form must reload");
  assert.equal(await page.getByRole("switch", { name: "同时烧录视频" }).getAttribute("aria-checked"), "true");

  await page.getByRole("tab", { name: "风格指南", exact: true }).click();
  await page.getByRole("button", { name: "新建风格指南", exact: true }).first().click();
  await page.getByRole("button", { name: "影视对白", exact: true }).click();
  assert.match(await page.getByLabel("标签").inputValue(), /口语/);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("已保存，当前是第 1 版", { exact: true }).waitFor();

  await page.getByRole("tab", { name: "字幕样式", exact: true }).click();
  await page.locator('[data-ass-preview="track-style"]').waitFor();
  console.log("Phase 10 resource-tab selection reset: PASS");
} finally {
  if (app) await closeElectronApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
}
