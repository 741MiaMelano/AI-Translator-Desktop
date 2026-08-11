import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  validateFfmpegArtifactManifest,
  verifyPackagedArtifacts,
  resolveVerifiedArtifactPaths,
} from "../../backend/media/ffmpeg-artifact-manifest.mjs";

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function baseManifest(overrides = {}) {
  const ffmpegBytes = Buffer.from("fake-ffmpeg-bytes-v1");
  const ffprobeBytes = Buffer.from("fake-ffprobe-bytes-v1");
  const dllBytes = Buffer.from("fake-avcodec-dll-bytes-v1");
  const licenseBytes = Buffer.from("LGPL-2.1-or-later notice text");
  const noticeBytes = Buffer.from("third-party notices");
  return {
    schemaVersion: 1,
    upstreamVersion: "7.1.1",
    provider: "example-reproducible-recipe",
    recipe: {
      repositoryUrl: "https://github.com/example/ffmpeg-builds",
      commit: "1".repeat(40),
      workflowRunUrl: "https://github.com/example/ffmpeg-builds/actions/runs/1",
      variant: "win64-lgpl-shared",
    },
    acquiredAt: "2026-07-18",
    sourceUrl: "https://ffmpeg.org/download.html",
    archive: {
      fileName: "ffmpeg-7.1.1-win64-lgpl-shared.zip",
      sizeBytes: 100,
      sha256: "2".repeat(64),
      providerDigest: `sha256:${"2".repeat(64)}`,
    },
    platform: "win32-x64",
    licenseClass: "LGPL-2.1-or-later",
    linkage: "dynamic",
    configure:
      "--disable-static --enable-shared --disable-autodetect --disable-debug --disable-doc",
    externalLibraries: [],
    artifacts: [
      {
        relativePath: "bin/ffmpeg.exe",
        role: "ffmpeg",
        sha256: sha256Hex(ffmpegBytes),
        sizeBytes: ffmpegBytes.length,
      },
      {
        relativePath: "bin/ffprobe.exe",
        role: "ffprobe",
        sha256: sha256Hex(ffprobeBytes),
        sizeBytes: ffprobeBytes.length,
      },
      {
        relativePath: "bin/avcodec.dll",
        role: "dll",
        sha256: sha256Hex(dllBytes),
        sizeBytes: dllBytes.length,
      },
    ],
    licenseFiles: [
      {
        relativePath: "licenses/LICENSE.txt",
        sha256: sha256Hex(licenseBytes),
        sizeBytes: licenseBytes.length,
      },
    ],
    noticeFiles: [
      {
        relativePath: "licenses/NOTICE.txt",
        sha256: sha256Hex(noticeBytes),
        sizeBytes: noticeBytes.length,
      },
    ],
    sourceDelivery: {
      method: "corresponding-source-url",
      reference: "https://ffmpeg.org/download.html",
      notes: "exact tarball and configure recorded in recipe",
    },
    authenticity: {
      method: "pinned-hash-in-version-controlled-manifest",
      trustAnchor: "version-controlled-manifest-and-pinned-rebuild",
    },
    sbom: {
      componentName: "ffmpeg",
      componentVersion: "7.1.1",
      purl: "pkg:generic/ffmpeg@7.1.1?arch=x64&os=windows",
    },
    capabilities: {
      probe: true,
      textSubtitleExtract: true,
      softSubtitleMux: true,
      assBurn: true,
    },
    ...overrides,
  };
}

function writeArtifactTree(rootDir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(rootDir, relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
}

test("manifest rejects missing required provenance fields", () => {
  for (const field of [
    "upstreamVersion",
    "provider",
    "recipe",
    "acquiredAt",
    "sourceUrl",
    "archive",
    "platform",
    "configure",
    "licenseClass",
    "linkage",
    "externalLibraries",
    "sourceDelivery",
    "authenticity",
    "sbom",
    "capabilities",
  ]) {
    const manifest = baseManifest();
    delete manifest[field];
    assert.throws(
      () => validateFfmpegArtifactManifest(manifest),
      (error) =>
        error?.code === "invalid_artifact" &&
        String(error.message).includes(field),
      `expected fail-closed for missing ${field}`,
    );
  }
});

test("manifest rejects missing artifact hash or incomplete artifact set", () => {
  const missingHash = baseManifest({
    artifacts: [
      {
        relativePath: "bin/ffmpeg.exe",
        role: "ffmpeg",
        sizeBytes: 10,
      },
      {
        relativePath: "bin/ffprobe.exe",
        role: "ffprobe",
        sha256: "a".repeat(64),
        sizeBytes: 10,
      },
    ],
  });
  assert.throws(
    () => validateFfmpegArtifactManifest(missingHash),
    (error) => error?.code === "invalid_artifact",
  );

  const missingFfprobe = baseManifest({
    artifacts: [
      {
        relativePath: "bin/ffmpeg.exe",
        role: "ffmpeg",
        sha256: "b".repeat(64),
        sizeBytes: 10,
      },
    ],
  });
  assert.throws(
    () => validateFfmpegArtifactManifest(missingFfprobe),
    (error) =>
      error?.code === "invalid_artifact" &&
      /ffprobe/i.test(String(error.message)),
  );

  const emptyArtifacts = baseManifest({ artifacts: [] });
  assert.throws(
    () => validateFfmpegArtifactManifest(emptyArtifacts),
    (error) => error?.code === "invalid_artifact",
  );
});

test("manifest rejects GPL or nonfree configure flags", () => {
  for (const configure of [
    "--enable-shared --enable-gpl",
    "--enable-nonfree --disable-static",
    "--enable-gpl --enable-nonfree",
    "  --enable-gpl  ",
  ]) {
    assert.throws(
      () => validateFfmpegArtifactManifest(baseManifest({ configure })),
      (error) =>
        error?.code === "invalid_artifact" &&
        (/gpl|nonfree/i.test(String(error.message)) ||
          /configure/i.test(String(error.message))),
      `expected reject for configure=${configure}`,
    );
  }
});

test("manifest rejects missing license notice or source-delivery evidence", () => {
  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ licenseFiles: [] })),
    (error) => error?.code === "invalid_artifact",
  );
  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ noticeFiles: [] })),
    (error) => error?.code === "invalid_artifact",
  );
  assert.throws(
    () =>
      validateFfmpegArtifactManifest(
        baseManifest({
          sourceDelivery: { method: "corresponding-source-url" },
        }),
      ),
    (error) => error?.code === "invalid_artifact",
  );
  assert.throws(
    () =>
      validateFfmpegArtifactManifest(
        baseManifest({
          authenticity: { method: "same-download-page-hash-only" },
        }),
      ),
    (error) => error?.code === "invalid_artifact",
  );
});

test("manifest rejects one path reused across artifact and compliance roles", () => {
  const manifest = baseManifest();
  const reused = manifest.artifacts[0];
  manifest.artifacts[1] = { ...reused, role: "ffprobe" };
  manifest.licenseFiles = [reused];
  manifest.noticeFiles = [reused];

  assert.throws(
    () => validateFfmpegArtifactManifest(manifest),
    (error) => error?.code === "invalid_artifact" && /duplicate|reused|unique/i.test(String(error.message)),
  );
});

test("manifest requires dynamic linkage explicit library inventory and unique primary roles", () => {
  for (const field of ["linkage", "externalLibraries"]) {
    const manifest = baseManifest();
    delete manifest[field];
    assert.throws(
      () => validateFfmpegArtifactManifest(manifest),
      (error) => error?.code === "invalid_artifact" && String(error.message).includes(field),
    );
  }

  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ linkage: "static" })),
    (error) => error?.code === "invalid_artifact" && /linkage|dynamic/i.test(String(error.message)),
  );

  const configureWithLibass = `${baseManifest().configure} --enable-libass`;
  const withTransitiveDependency = validateFfmpegArtifactManifest(baseManifest({
    configure: configureWithLibass,
    externalLibraries: [
      {
        name: "libass",
        version: "0.17.5",
        license: "ISC",
        linkage: "dynamic",
        sourceUrl: "https://github.com/libass/libass",
        configureFlag: "--enable-libass",
        noticePath: "licenses/LICENSE.txt",
      },
      {
        name: "FreeType",
        version: "2.13.3",
        license: "FTL-or-GPL-2.0-only",
        linkage: "dynamic",
        sourceUrl: "https://download.savannah.gnu.org/releases/freetype/",
        requiredBy: "libass",
        noticePath: "licenses/LICENSE.txt",
      },
    ],
  }));
  assert.equal(withTransitiveDependency.externalLibraries[1].requiredBy, "libass");
  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ externalLibraries: [{ name: "zlib" }] })),
    (error) => error?.code === "invalid_artifact" && /externalLibraries/i.test(String(error.message)),
  );

  const configureWithZlib = `${baseManifest().configure} --enable-zlib`;
  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ configure: configureWithZlib })),
    (error) => error?.code === "invalid_artifact" && /externalLibraries|zlib/i.test(String(error.message)),
  );
  assert.throws(
    () =>
      validateFfmpegArtifactManifest(
        baseManifest({
          configure: configureWithZlib,
          externalLibraries: [
            {
              name: "zlib",
              version: "1.3.1",
              license: "Zlib",
              linkage: "static",
              sourceUrl: "https://github.com/madler/zlib",
              configureFlag: "--enable-zlib",
              noticePath: "licenses/ZLIB.txt",
            },
          ],
        }),
      ),
    (error) => error?.code === "invalid_artifact" && /noticePath|ZLIB/i.test(String(error.message)),
  );

  const missingDll = baseManifest();
  missingDll.artifacts = missingDll.artifacts.filter((entry) => entry.role !== "dll");
  assert.throws(
    () => validateFfmpegArtifactManifest(missingDll),
    (error) => error?.code === "invalid_artifact" && /dll/i.test(String(error.message)),
  );

  const duplicateFfmpeg = baseManifest();
  duplicateFfmpeg.artifacts.push({
    ...duplicateFfmpeg.artifacts[0],
    relativePath: "bin/ffmpeg-copy.exe",
  });
  assert.throws(
    () => validateFfmpegArtifactManifest(duplicateFfmpeg),
    (error) => error?.code === "invalid_artifact" && /ffmpeg|role|unique/i.test(String(error.message)),
  );
});

test("manifest requires Phase 11 mux and ASS burn capabilities", () => {
  for (const capability of ["softSubtitleMux", "assBurn"]) {
    const manifest = baseManifest();
    delete manifest.capabilities[capability];
    assert.throws(
      () => validateFfmpegArtifactManifest(manifest),
      (error) => error?.code === "invalid_artifact" && /capabilities|mux|burn/i.test(String(error.message)),
    );
  }
});

test("manifest requires pinned recipe archive provenance and complete release metadata", () => {
  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ recipe: "floating-master" })),
    (error) => error?.code === "invalid_artifact" && /recipe/i.test(String(error.message)),
  );
  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ archive: { sha256: "3".repeat(64) } })),
    (error) => error?.code === "invalid_artifact" && /archive/i.test(String(error.message)),
  );
  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ configure: "--enable-shared" })),
    (error) => error?.code === "invalid_artifact" && /disable-static|configure/i.test(String(error.message)),
  );
  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ licenseClass: "LGPL-ish" })),
    (error) => error?.code === "invalid_artifact" && /licenseClass|LGPL/i.test(String(error.message)),
  );
  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ acquiredAt: "today" })),
    (error) => error?.code === "invalid_artifact" && /acquiredAt/i.test(String(error.message)),
  );
  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ sourceUrl: "http://example.test/build.zip" })),
    (error) => error?.code === "invalid_artifact" && /sourceUrl|https/i.test(String(error.message)),
  );
  assert.throws(
    () => validateFfmpegArtifactManifest(baseManifest({ sbom: { componentName: "ffmpeg", componentVersion: "7.1.1" } })),
    (error) => error?.code === "invalid_artifact" && /sbom|purl/i.test(String(error.message)),
  );
});

test("manifest accepts a pinned local build script instead of a hosted workflow run", () => {
  const manifest = baseManifest();
  manifest.recipe = {
    repositoryUrl: "https://github.com/741MiaMelano/desktop-ai-translator-ui",
    buildScriptPath: "scripts/build-ffmpeg-wsl.sh",
    buildScriptSha256: "4".repeat(64),
    buildEnvironment: "Ubuntu 24.04 / WSL 1 / MinGW-w64 GCC 13-win32",
    variant: "win64-lgpl-shared-minimal",
  };

  const result = validateFfmpegArtifactManifest(manifest);
  assert.equal(result.recipe.buildScriptPath, "scripts/build-ffmpeg-wsl.sh");
  assert.equal(result.recipe.buildScriptSha256, "4".repeat(64));
  assert.equal(result.recipe.workflowRunUrl, undefined);

  delete manifest.recipe.buildScriptSha256;
  assert.throws(
    () => validateFfmpegArtifactManifest(manifest),
    (error) => error?.code === "invalid_artifact" && /recipe|buildScriptSha256|workflow/i.test(String(error.message)),
  );
});

test("release manifest pins the exact repository build recipe", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../docs/third-party/ffmpeg/manifest.json", import.meta.url), "utf8"),
  );
  const result = validateFfmpegArtifactManifest(manifest);
  const buildScript = readFileSync(new URL(`../../${result.recipe.buildScriptPath}`, import.meta.url));

  assert.equal(sha256Hex(buildScript), result.recipe.buildScriptSha256);
  assert.deepEqual(
    result.externalLibraries.map((entry) => entry.name),
    ["libass", "FreeType", "FriBidi", "HarfBuzz"],
  );
  assert.equal(result.capabilities.softSubtitleMux, true);
  assert.equal(result.capabilities.assBurn, true);
});

test("packaged tree fails closed on hash mismatch missing file or extra undeclared binary", () => {
  const root = mkdtempSync(join(tmpdir(), "ffmpeg-manifest-"));
  try {
    const ffmpegBytes = Buffer.from("fake-ffmpeg-bytes-v1");
    const ffprobeBytes = Buffer.from("fake-ffprobe-bytes-v1");
    const dllBytes = Buffer.from("fake-avcodec-dll-bytes-v1");
    const licenseBytes = Buffer.from("LGPL-2.1-or-later notice text");
    const noticeBytes = Buffer.from("third-party notices");
    const manifest = baseManifest();

    writeArtifactTree(root, {
      "bin/ffmpeg.exe": Buffer.from("tampered-ffmpeg"),
      "bin/ffprobe.exe": ffprobeBytes,
      "bin/avcodec.dll": dllBytes,
      "licenses/LICENSE.txt": licenseBytes,
      "licenses/NOTICE.txt": noticeBytes,
    });
    assert.throws(
      () => verifyPackagedArtifacts(manifest, root),
      (error) =>
        error?.code === "invalid_artifact" &&
        /hash|mismatch/i.test(String(error.message)),
    );

    writeArtifactTree(root, {
      "bin/ffmpeg.exe": ffmpegBytes,
      "bin/ffprobe.exe": ffprobeBytes,
      "bin/avcodec.dll": dllBytes,
      "licenses/LICENSE.txt": licenseBytes,
      "licenses/NOTICE.txt": noticeBytes,
    });
    rmSync(join(root, "bin", "ffprobe.exe"), { force: true });
    assert.throws(
      () => verifyPackagedArtifacts(manifest, root),
      (error) =>
        error?.code === "invalid_artifact" &&
        /missing|not found|incomplete/i.test(String(error.message)),
    );

    writeArtifactTree(root, {
      "bin/ffmpeg.exe": ffmpegBytes,
      "bin/ffprobe.exe": ffprobeBytes,
      "bin/avcodec.dll": dllBytes,
      "bin/extra-tool.exe": Buffer.from("undeclared"),
      "licenses/LICENSE.txt": licenseBytes,
      "licenses/NOTICE.txt": noticeBytes,
    });
    assert.throws(
      () => verifyPackagedArtifacts(manifest, root),
      (error) =>
        error?.code === "invalid_artifact" &&
        /undeclared|extra|mismatch/i.test(String(error.message)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveVerifiedArtifactPaths refuses PATH lookup and relative executables", () => {
  const root = mkdtempSync(join(tmpdir(), "ffmpeg-paths-"));
  try {
    const ffmpegBytes = Buffer.from("fake-ffmpeg-bytes-v1");
    const ffprobeBytes = Buffer.from("fake-ffprobe-bytes-v1");
    const dllBytes = Buffer.from("fake-avcodec-dll-bytes-v1");
    const licenseBytes = Buffer.from("LGPL-2.1-or-later notice text");
    const noticeBytes = Buffer.from("third-party notices");
    const manifest = baseManifest();
    writeArtifactTree(root, {
      "bin/ffmpeg.exe": ffmpegBytes,
      "bin/ffprobe.exe": ffprobeBytes,
      "bin/avcodec.dll": dllBytes,
      "licenses/LICENSE.txt": licenseBytes,
      "licenses/NOTICE.txt": noticeBytes,
    });

    assert.throws(
      () =>
        resolveVerifiedArtifactPaths(manifest, {
          artifactRootDir: null,
          allowPathLookup: true,
        }),
      (error) => error?.code === "invalid_artifact" || error?.code === "not_available",
    );

    assert.throws(
      () =>
        resolveVerifiedArtifactPaths(manifest, {
          artifactRootDir: "relative/ffmpeg-root",
        }),
      (error) => error?.code === "invalid_artifact" || error?.code === "not_available",
    );

    // Without a verified packaged tree, production resolve must fail closed.
    assert.throws(
      () =>
        resolveVerifiedArtifactPaths(manifest, {
          artifactRootDir: join(root, "does-not-exist"),
        }),
      (error) => error?.code === "invalid_artifact" || error?.code === "not_available",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("valid synthetic manifest structure is accepted only after full field checks", () => {
  // RED expectation before GREEN: either module missing, or validator not yet green.
  // When GREEN lands, this becomes the positive control for a synthetic fixture only.
  const manifest = baseManifest();
  const result = validateFfmpegArtifactManifest(manifest);
  assert.equal(result.ok, true);
  assert.equal(result.licenseClass, "LGPL-2.1-or-later");
  assert.equal(result.artifacts.length, 3);
});
