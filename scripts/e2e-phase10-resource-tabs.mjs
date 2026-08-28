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

async function openLibrary(page) {
  await page.waitForFunction(() => Boolean(window.desktop), null, { timeout: 30_000 });
  await page.locator(".app-shell").waitFor({ timeout: 30_000 });
  await page.evaluate(() => { window.location.hash = "/library"; });
  await page.getByRole("heading", { name: "资源库", exact: true }).waitFor({ timeout: 30_000 });
}

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
  await openLibrary(page);
  await page.getByRole("button", { name: "新建术语表", exact: true }).first().click();
  let chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入 CSV / TSV", exact: true }).click();
  await (await chooser).setFiles(glossaryCsv);
  await page.getByText("已导入 3 条到草稿；保存后生效。", { exact: true }).waitFor();
  chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入 CSV / TSV", exact: true }).click();
  await (await chooser).setFiles(glossaryTsv);
  await page.getByText("已导入 2 条到草稿，跳过 1 条重复项；保存后生效。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "保存并生成新版本", exact: true }).click();
  await page.getByText("已保存“新建术语表”，当前为第 1 版。", { exact: true }).waitFor();
  await page.reload();
  await openLibrary(page);
  await page.getByRole("tab", { name: /术语表/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('input[placeholder="原文术语"]')]
    .some((input) => input.value === "DeepSeek"));
  const sourceTerms = await page.getByPlaceholder("原文术语").evaluateAll((inputs) => inputs.map((input) => input.value));
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

  await page.getByRole("tab", { name: /字幕样式/ }).click();
  await page.getByText("P10 tab reset fixture", { exact: true }).first().waitFor();
  await page.locator(".subtitle-style-preview").waitFor();
  const primaryStyle = page.getByRole("group", { name: "主字幕", exact: true });
  const primaryFontSize = primaryStyle.getByLabel("字号", { exact: true });
  await primaryFontSize.fill("40");
  await primaryStyle.getByLabel("字体", { exact: true }).fill("Microsoft YaHei");
  await primaryStyle.getByLabel("文字色", { exact: true }).fill("#00aaee");
  assert.equal(
    await page.locator(".subtitle-style-preview > div").evaluate((element) => element.style.fontSize),
    "20px",
    "structured subtitle style changes must update the preview immediately",
  );
  await page.getByRole("button", { name: "保存并生成新版本", exact: true }).click();
  await page.getByText("已保存“P10 tab reset fixture”，当前为第 2 版。", { exact: true }).waitFor();
  await page.reload();
  await openLibrary(page);
  await page.getByRole("tab", { name: /字幕样式/ }).click();
  const reloadedPrimaryStyle = page.getByRole("group", { name: "主字幕", exact: true });
  assert.equal(await reloadedPrimaryStyle.getByLabel("字号", { exact: true }).inputValue(), "40", "saved style form must reload");
  assert.equal(await reloadedPrimaryStyle.getByLabel("字体", { exact: true }).inputValue(), "Microsoft YaHei", "saved font choice must reload");
  assert.equal(await reloadedPrimaryStyle.getByLabel("文字色", { exact: true }).inputValue(), "#00aaee", "saved color choice must reload");

  await page.getByRole("tab", { name: /导出预设/ }).click();
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator(".subtitle-style-preview").count(),
    0,
    "an empty export-preset tab must not retain the subtitle-style ASS preview",
  );
  assert.equal(
    await page.getByText("P10 tab reset fixture", { exact: true }).count(),
    0,
    "an empty export-preset tab must not retain the subtitle-style draft",
  );

  await page.getByRole("button", { name: "新建导出预设", exact: true }).first().click();
  await page.getByLabel("文件名模板").fill("{project}-{language}-{content}-final");
  await page.getByLabel("同时烧录视频", { exact: true }).check();
  await page.getByRole("button", { name: "保存并生成新版本", exact: true }).click();
  await page.getByText("已保存“新建导出预设”，当前为第 1 版。", { exact: true }).waitFor();
  await page.reload();
  await openLibrary(page);
  await page.getByRole("tab", { name: /导出预设/ }).click();
  assert.equal(await page.getByLabel("文件名模板").inputValue(), "{project}-{language}-{content}-final", "saved export preset form must reload");
  assert.equal(await page.getByLabel("同时烧录视频", { exact: true }).isChecked(), true);

  await page.getByRole("tab", { name: /风格指南/ }).click();
  await page.getByRole("button", { name: "新建风格指南", exact: true }).first().click();
  await page.getByLabel("标签", { exact: true }).fill("口语, 影视");
  assert.match(await page.getByLabel("标签").inputValue(), /口语/);
  await page.getByRole("button", { name: "保存并生成新版本", exact: true }).click();
  await page.getByText("已保存“新建风格指南”，当前为第 1 版。", { exact: true }).waitFor();

  await page.getByRole("tab", { name: /字幕样式/ }).click();
  await page.locator(".subtitle-style-preview").waitFor();
  console.log("Phase 10 resource-tab selection reset: PASS");
} finally {
  if (app) await closeElectronApp(app);
  rmSync(userDataDir, { recursive: true, force: true });
}
