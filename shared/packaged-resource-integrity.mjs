import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 每一项都对应 electron-builder.yml 里一条 extraResources。任何一项缺失都说明
 * 打包后的 resources 树被截断了，而不是某个功能"没装"。
 */
export const PACKAGED_RESOURCE_REQUIREMENTS = [
  { label: "数据库迁移脚本（应用库）", path: "migrations/app", suffix: ".sql" },
  { label: "数据库迁移脚本（项目库）", path: "migrations/project", suffix: ".sql" },
  { label: "FFmpeg 构件清单", path: "ffmpeg/manifest.json" },
  { label: "FFmpeg 可执行文件", path: "ffmpeg/win32-x64/bin/ffmpeg.exe" },
  { label: "FFprobe 可执行文件", path: "ffmpeg/win32-x64/bin/ffprobe.exe" },
  { label: "语音识别构件清单", path: "asr/manifest.json" },
  { label: "Qwen3 语音识别清单", path: "asr/qwen-manifest.json" },
  { label: "内置 CPU 语音识别运行时", path: "asr/runtime/whisper-cpp-cpu-x64/whisper-cli.exe" },
  { label: "语音活动检测模型", path: "asr/vad/silero-v6.2.0", suffix: ".bin" },
];

function satisfied(resourcesRoot, requirement) {
  const absolute = join(resourcesRoot, ...requirement.path.split("/"));
  if (!existsSync(absolute)) return false;
  if (!requirement.suffix) return statSync(absolute).isFile();
  if (!statSync(absolute).isDirectory()) return false;
  return readdirSync(absolute).some((entry) => entry.endsWith(requirement.suffix));
}

/** 返回缺失项的中文标签；空数组表示资源树完整。 */
export function findMissingPackagedResources(resourcesRoot) {
  if (typeof resourcesRoot !== "string" || resourcesRoot.trim().length === 0) {
    return PACKAGED_RESOURCE_REQUIREMENTS.map((requirement) => requirement.label);
  }
  const missing = [];
  for (const requirement of PACKAGED_RESOURCE_REQUIREMENTS) {
    let ok = false;
    try {
      ok = satisfied(resourcesRoot, requirement);
    } catch {
      ok = false;
    }
    if (!ok) missing.push(requirement.label);
  }
  return missing;
}

/**
 * 便携版每次启动都把自身解压到临时目录，启动和退出各执行一次 RMDir /r。两个实例
 * 重叠运行时，后启动的会删掉前一个的文件，剩下的实例就跑在残缺目录上——用户看到的
 * 是"该功能当前不可用""仍有项目未能保存""模型未安装"这一串互不相干的报错。
 * 这里把它收敛成一条能照着做的说明。
 */
export function describeIncompletePackagedResources(missing) {
  return [
    "程序自带的资源没有完整解包，现在启动只会让每个功能各自报一个看不懂的错。",
    "",
    "缺少：",
    ...missing.map((label) => `    · ${label}`),
    "",
    "最常见的原因是同时运行了两个实例：便携版每次启动都会把自己解压到临时目录，",
    "后启动的那个会先清空这个目录，于是先启动的那个就跑在了残缺的文件上。",
    "",
    "处理办法：结束所有“AI Translator Desktop”进程，然后只启动一次程序。",
  ].join("\n");
}
