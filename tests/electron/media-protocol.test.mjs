import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearMediaGrants,
  grantCountForTests,
  handleMediaProtocolRequest,
  isMediaGrantAuthorized,
  issueMediaGrant,
  revokeMediaGrantsForProject,
} from "../../electron/media-protocol.ts";

test("renderer CSP allows media served by the authorized app-media protocol", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /media-src\s+[^;]*\bapp-media:/);
});

test("unknown token traversal and wrong methods are denied", async () => {
  clearMediaGrants();
  const dir = mkdtempSync(join(tmpdir(), "p06-t07-"));
  const file = join(dir, "a.wav");
  writeFileSync(file, Buffer.alloc(100, 1));
  const grant = issueMediaGrant({
    projectId: "p1",
    assetId: "primary",
    absolutePath: file,
    webContentsId: 1,
  });

  const denied = [
    "app-media://asset/not-a-token",
    "app-media://asset/../secret",
    `${grant.url}/extra`,
    grant.url.replace("app-media://asset/", "app-media://asset/foo/"),
    "app-media://asset/%2e%2e/x",
    "file:///C:/Windows/notepad.exe",
  ];
  for (const url of denied) {
    const response = await handleMediaProtocolRequest(new Request(url, { method: "GET" }), {
      webContentsId: 1,
    });
    assert.ok(response.status >= 400, url);
  }

  const post = await handleMediaProtocolRequest(new Request(grant.url, { method: "POST" }), {
    webContentsId: 1,
  });
  assert.equal(post.status, 405);

  const cross = await handleMediaProtocolRequest(new Request(grant.url, { method: "GET" }), {
    webContentsId: 2,
  });
  assert.equal(cross.status, 403);
  assert.equal(isMediaGrantAuthorized(grant.url, 1), true);
  assert.equal(isMediaGrantAuthorized(grant.url, 2), false);
  assert.equal(isMediaGrantAuthorized(grant.url, undefined), false);

  rmSync(dir, { recursive: true, force: true });
  clearMediaGrants();
});

test("GET HEAD and single Range headers are accurate", async () => {
  clearMediaGrants();
  const dir = mkdtempSync(join(tmpdir(), "p06-t07-range-"));
  const file = join(dir, "a.wav");
  const body = Buffer.from("0123456789abcdefghij");
  writeFileSync(file, body);
  const grant = issueMediaGrant({
    projectId: "p1",
    assetId: "primary",
    absolutePath: file,
    webContentsId: 7,
    mimeType: "audio/wav",
  });

  const head = await handleMediaProtocolRequest(new Request(grant.url, { method: "HEAD" }), {
    webContentsId: 7,
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), String(body.length));
  assert.equal(await head.arrayBuffer().then((b) => b.byteLength), 0);

  const get = await handleMediaProtocolRequest(new Request(grant.url, { method: "GET" }), {
    webContentsId: 7,
  });
  assert.equal(get.status, 200);
  const full = Buffer.from(await get.arrayBuffer());
  assert.equal(full.equals(body), true);

  const ranged = await handleMediaProtocolRequest(
    new Request(grant.url, { method: "GET", headers: { Range: "bytes=0-3" } }),
    { webContentsId: 7 },
  );
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("Content-Range"), "bytes 0-3/20");
  assert.equal(ranged.headers.get("Content-Length"), "4");
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString("utf8"), "0123");

  const badRange = await handleMediaProtocolRequest(
    new Request(grant.url, { method: "GET", headers: { Range: "bytes=50-60" } }),
    { webContentsId: 7 },
  );
  assert.equal(badRange.status, 416);

  const multi = await handleMediaProtocolRequest(
    new Request(grant.url, { method: "GET", headers: { Range: "bytes=0-1,2-3" } }),
    { webContentsId: 7 },
  );
  assert.equal(multi.status, 416);

  revokeMediaGrantsForProject("p1");
  assert.equal(grantCountForTests(), 0);
  const after = await handleMediaProtocolRequest(new Request(grant.url, { method: "GET" }), {
    webContentsId: 7,
  });
  assert.equal(after.status, 403);

  rmSync(dir, { recursive: true, force: true });
  clearMediaGrants();
});

test("media bodies never hand a raw Node stream to Response", () => {
  // 拖动波形进度条崩溃的那条 ERR_INVALID_STATE 发生在 Electron 的 protocol.handle 内部：
  // 把 Node ReadStream 交给 Response 后，undici 在请求被取消之后又 close 一次已关闭的
  // 响应体。这条竞态在 node --test 里复现不出来（直接调用 handleMediaProtocolRequest
  // 根本不走那段转换，两种写法的响应体看起来完全一样），所以这里钉的是决定本身：
  // 响应体必须由我们自己构造、自己管生命周期。行为验证只能靠真机拖进度条。
  const source = readFileSync(new URL("../../electron/media-protocol.ts", import.meta.url), "utf8");
  const responseBodies = [...source.matchAll(/new Response\(\s*([^,)]+)/g)].map((match) => match[1].trim());
  for (const body of responseBodies) {
    assert.doesNotMatch(body, /createReadStream/, `new Response() must not receive a Node stream: ${body}`);
  }
  assert.ok(
    responseBodies.some((body) => body.startsWith("createFileBodyStream(")),
    "media bodies must go through createFileBodyStream",
  );
  // 关闭只能发生一次，取消必须销毁文件句柄——否则拖动会留下越来越多打开的 fd。
  const factory = source.slice(source.indexOf("function createFileBodyStream"), source.indexOf("export async function handleMediaProtocolRequest"));
  assert.match(factory, /if \(settled\) return;/);
  assert.match(factory, /cancel\(\) \{[\s\S]*?file\.destroy\(\)/);
});

test("an actively used media grant survives long preview and seek sessions", () => {
  clearMediaGrants();
  const dir = mkdtempSync(join(tmpdir(), "p06-t07-sliding-"));
  const file = join(dir, "long.mp4");
  writeFileSync(file, Buffer.alloc(20, 1));
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const grant = issueMediaGrant({
      projectId: "p-long",
      assetId: "primary",
      absolutePath: file,
      webContentsId: 9,
      ttlMs: 1_000,
    });
    now = 1_900;
    assert.equal(isMediaGrantAuthorized(grant.url, 9), true);
    now = 2_800;
    assert.equal(isMediaGrantAuthorized(grant.url, 9), true);
    now = 3_801;
    assert.equal(isMediaGrantAuthorized(grant.url, 9), false);
  } finally {
    Date.now = realNow;
    rmSync(dir, { recursive: true, force: true });
    clearMediaGrants();
  }
});
