// 能力分级的唯一事实来源：侧栏状态、系统页、命令面板都读这里。
//
// 后端契约里的四个能力 ID 不变，这里只改**分组与口径**。旧做法把四项平权展示，
// 于是"只翻译字幕文件"的用户永久看到一个红点和"N 项核心能力需处理"——而他
// 根本用不到语音识别。分级按"什么时候需要它"来分，并且由真实项目状态推导，
// 不是一张写死的表。

import { getActiveSourceTrack, type Project } from "../domain/workspace";
import type { CapabilityReadinessItem } from "../contracts/desktop-api";

export type CapabilityTier = "now" | "on_demand";

/** 每项能力"什么时候需要它"。这是全应用单位价值最高的一句文案：
 *  它把一个吓人的红点变成一个知情的选择。 */
export const WHEN_NEEDED: Record<CapabilityReadinessItem["id"], string> = {
  translation: "每次翻译都要用它",
  asr: "只在处理没有字幕的视频/音频时需要",
  subtitle_export: "导出字幕文件时需要",
  video_export: "烧录或封装视频时需要",
};

export function capabilityReason(reason: string | null | undefined) {
  if (!reason) return "当前不可用";
  return ({
    provider_not_configured: "尚未配置翻译服务",
    model_not_installed: "识别模型尚未安装",
    runtime_not_ready: "识别运行时尚未就绪",
  } as Record<string, string>)[reason] ?? reason;
}

export function repairLabel(action: CapabilityReadinessItem["repairAction"]) {
  if (!action) return "";
  return ({
    open_provider: "去配置",
    open_model_manager: "去安装",
    open_project: "打开项目",
    open_environment: "检查环境",
    open_projects: "查看项目",
    open_project_settings: "项目设置",
    relink_media: "重新关联媒体",
    open_editor: "打开校对",
  } as Record<string, string>)[action] ?? "查看恢复建议";
}

export function repairPath(action: CapabilityReadinessItem["repairAction"]) {
  if (action === "open_model_manager") return "/system/asr";
  if (action === "open_environment") return "/system/settings";
  if (action === "open_projects" || action === "open_project" || action === "open_project_settings") return "/workspace";
  return "/system/providers";
}

/** 有媒体但还没有可用源字幕 —— 这个项目现在真的需要本机识别。 */
function needsTranscription(project: Project) {
  return !project.noSourceMedia && !getActiveSourceTrack(project)?.segments.length;
}

/**
 * 语音识别只有在**手头真有一个需要它的项目**时才算"现在需要"。
 * 其余能力按用途归入"按需启用"；翻译是每个项目都要走的一步，永远在"现在需要"。
 */
export function capabilityTier(id: CapabilityReadinessItem["id"], projects: Project[]): CapabilityTier {
  if (id === "translation") return "now";
  if (id === "asr") return projects.some(needsTranscription) ? "now" : "on_demand";
  return "on_demand";
}

export function groupCapabilities(items: CapabilityReadinessItem[], projects: Project[]) {
  const now: CapabilityReadinessItem[] = [];
  const onDemand: CapabilityReadinessItem[] = [];
  for (const item of items) (capabilityTier(item.id, projects) === "now" ? now : onDemand).push(item);
  return { now, onDemand };
}

/**
 * 侧栏只在能力**挡住当前项目的下一步**时才报警。
 * "按需启用"里的东西没就绪不是故障，是还没轮到它。
 */
export function blockingCapabilities(items: CapabilityReadinessItem[], projects: Project[]) {
  return items.filter((item) => !item.available && capabilityTier(item.id, projects) === "now");
}
