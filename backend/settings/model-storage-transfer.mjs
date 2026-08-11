import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MANAGED_DIRECTORIES = ["models", "runtimes", "auxiliary"];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function contains(parent, child) {
  const nested = relative(resolve(parent), resolve(child));
  return nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested));
}

async function ordinaryDirectory(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw fail("INVALID_INPUT", `${label}必须是绝对路径`);
  const value = await lstat(path).catch(() => null);
  if (!value?.isDirectory() || value.isSymbolicLink()) {
    throw fail("INVALID_INPUT", `${label}必须是已存在的普通目录`);
  }
}

async function redundantUvPythonAlias(root, relativePath) {
  const parts = relativePath.split(sep);
  if (parts.length !== 3 || parts[1] !== "python") return false;
  const match = /^cpython-(\d+\.\d+)-windows-x86_64-none$/.exec(parts[2]);
  if (!match) return false;
  const config = await readFile(join(root, parts[0], "venv", "pyvenv.cfg"), "utf8").catch(() => "");
  const home = /^home\s*=\s*(.+)$/mi.exec(config)?.[1]?.trim();
  const concreteName = home && basename(home);
  if (!concreteName || !new RegExp(`^cpython-${match[1].replace(".", "\\.")}\\.\\d+-windows-x86_64-none$`).test(concreteName)) return false;
  const concrete = await lstat(join(root, parts[0], "python", concreteName)).catch(() => null);
  const python = await lstat(join(root, parts[0], "python", concreteName, "python.exe")).catch(() => null);
  return Boolean(concrete?.isDirectory() && !concrete.isSymbolicLink() && python?.isFile() && !python.isSymbolicLink());
}

async function collectFiles(root, directory = "", files = [], allowUvAlias = false) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const relativePath = join(directory, entry.name);
    const path = join(root, relativePath);
    const value = await lstat(path);
    if (value.isSymbolicLink()) {
      if (allowUvAlias && await redundantUvPythonAlias(root, relativePath)) continue;
      throw fail("INVALID_INPUT", "模型目录中包含无法安全转移的符号链接或目录联接");
    }
    if (value.isDirectory()) await collectFiles(root, relativePath, files, allowUvAlias);
    else if (value.isFile()) files.push({ relativePath, sizeBytes: value.size });
    else throw fail("INVALID_ARTIFACT", "模型目录中包含不支持的文件类型");
  }
  return files;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function createReporter(onProgress) {
  let previous = "";
  return (stage, progress, message, processedBytes = 0, totalBytes = 0) => {
    const value = Math.max(0, Math.min(100, Math.round(progress)));
    const key = `${stage}:${value}`;
    if (key === previous) return;
    previous = key;
    try { onProgress?.({ stage, progress: value, message, processedBytes, totalBytes }); } catch { /* UI progress must not break transfer */ }
  };
}

export async function transferModelStorage({ sourceRoot, destinationRoot, commit, onProgress }) {
  const report = createReporter(onProgress);
  report("scanning", 0, "正在检查当前模型和目标目录…");
  await Promise.all([
    ordinaryDirectory(sourceRoot, "当前模型目录"),
    ordinaryDirectory(destinationRoot, "新模型目录"),
  ]);
  if (contains(sourceRoot, destinationRoot) || contains(destinationRoot, sourceRoot)) {
    throw fail("INVALID_INPUT", "新模型目录不能与当前目录相同，也不能互相嵌套");
  }
  if ((await readdir(destinationRoot)).length) throw fail("CONFLICT", "请选择一个空目录作为新的模型目录");
  if (typeof commit !== "function") throw fail("INVALID_INPUT", "模型目录切换服务不可用");

  const collections = [];
  const files = [];
  for (const name of MANAGED_DIRECTORIES) {
    const root = join(sourceRoot, name);
    const value = await lstat(root).catch(() => null);
    if (!value) continue;
    if (!value.isDirectory() || value.isSymbolicLink()) throw fail("INVALID_ARTIFACT", "现有模型目录结构无效");
    collections.push(name);
    for (const file of await collectFiles(root, "", [], name === "runtimes")) files.push({ ...file, collection: name });
  }
  if (!collections.length || !files.length) {
    throw fail("NOT_FOUND", "当前目录中没有已安装的语音识别模型或运行时");
  }
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);

  const stageRoot = join(dirname(destinationRoot), `.${basename(destinationRoot)}.ai-translator-transfer-${randomUUID()}`);
  let promoted = false;
  let committed = false;
  try {
    await mkdir(stageRoot);
    for (const name of collections) await mkdir(join(stageRoot, name), { recursive: true });
    let processedBytes = 0;
    report("copying", 5, "正在复制模型文件…", 0, totalBytes);
    for (const file of files) {
      const source = join(sourceRoot, file.collection, file.relativePath);
      const destination = join(stageRoot, file.collection, file.relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      processedBytes += file.sizeBytes;
      report("copying", 5 + (processedBytes / totalBytes) * 55, "正在复制模型文件…", processedBytes, totalBytes);
    }
    processedBytes = 0;
    report("verifying", 60, "正在逐个校验模型文件…", 0, totalBytes);
    for (const file of files) {
      const source = join(sourceRoot, file.collection, file.relativePath);
      const destination = join(stageRoot, file.collection, file.relativePath);
      const copied = await lstat(destination);
      if (!copied.isFile() || copied.size !== file.sizeBytes || await sha256File(source) !== await sha256File(destination)) {
        throw fail("HASH_MISMATCH", "转移后的模型文件校验失败");
      }
      processedBytes += file.sizeBytes;
      report("verifying", 60 + (processedBytes / totalBytes) * 30, "正在逐个校验模型文件…", processedBytes, totalBytes);
    }
    report("switching", 92, "校验完成，正在切换模型路径…", totalBytes, totalBytes);
    if ((await readdir(destinationRoot)).length) throw fail("CONFLICT", "新模型目录在转移过程中发生了变化");
    await rmdir(destinationRoot);
    await rename(stageRoot, destinationRoot);
    promoted = true;
    await commit(destinationRoot);
    committed = true;
  } finally {
    if (!committed) {
      const cleanupRoot = promoted ? destinationRoot : stageRoot;
      for (const name of collections) await rm(join(cleanupRoot, name), { recursive: true, force: true }).catch(() => {});
      await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      await mkdir(destinationRoot, { recursive: true }).catch(() => {});
    }
  }

  let oldDirectoryRemoved = true;
  report("cleaning", 97, "路径已切换，正在清理旧模型文件…", totalBytes, totalBytes);
  for (const name of collections) {
    await rm(join(sourceRoot, name), { recursive: true, force: true }).catch(() => { oldDirectoryRemoved = false; });
  }
  report("completed", 100, oldDirectoryRemoved ? "模型转移完成，应用即将重启。" : "模型转移完成；旧目录未能完全清理，应用即将重启。", totalBytes, totalBytes);
  return {
    fileCount: files.length,
    sizeBytes: totalBytes,
    oldDirectoryRemoved,
  };
}
