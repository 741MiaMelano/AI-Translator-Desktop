import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isTrustedRendererNavigation } from "../../electron/navigation.ts";

test("development navigation requires the exact trusted renderer URL", () => {
  const entry = { type: "url", value: "http://localhost:5173/" };

  assert.equal(isTrustedRendererNavigation("http://localhost:5173/#/projects", entry), true);
  assert.equal(isTrustedRendererNavigation("http://localhost:5173.evil.example/", entry), false);
  assert.equal(isTrustedRendererNavigation("http://localhost:5173/other", entry), false);
});

test("production navigation only allows the packaged renderer file", () => {
  const indexUrl = pathToFileURL(resolve("dist/index.html")).href;
  const otherUrl = pathToFileURL(resolve("other.html")).href;
  const entry = { type: "file", value: resolve("dist/index.html") };

  assert.equal(isTrustedRendererNavigation(`${indexUrl}#/projects`, entry), true);
  assert.equal(isTrustedRendererNavigation(otherUrl, entry), false);
  assert.equal(isTrustedRendererNavigation("https://example.com/", entry), false);
});
