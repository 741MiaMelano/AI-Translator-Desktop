const DEFINITIONS = Object.freeze({
  translation: ["翻译", "open_provider"],
  asr: ["本地语音识别", "open_model_manager"],
  subtitle_export: ["字幕导出", "open_project"],
  video_export: ["视频后处理", "open_environment"],
});

function capability(id, available, reason = null, repairAction = null) {
  return {
    id,
    label: DEFINITIONS[id][0],
    available,
    reason: available ? null : reason,
    repairAction: available ? null : (repairAction ?? DEFINITIONS[id][1]),
  };
}

async function probe(run, unavailableReason) {
  try {
    return await run();
  } catch {
    return { available: false, reason: unavailableReason };
  }
}

export function createCapabilityService({
  getAsrCapability,
  getProviderReadinesses,
  getVideoCapability,
  getProject,
  now = () => new Date(),
}) {
  return {
    async getStatus({ projectId } = {}) {
      const [asrProbe, providerProbe, videoProbe] = await Promise.all([
        probe(async () => {
          const value = await getAsrCapability();
          const reason = value?.ready
            ? null
            : value?.model?.installState === "not_installed"
              ? "语音识别模型尚未安装"
              : value?.runtime?.installState !== "ready"
                ? "本地语音识别组件不可用"
                : "语音识别模型尚未就绪";
          return { available: value?.ready === true, reason };
        }, "ASR 能力探测失败"),
        probe(async () => {
          const values = await getProviderReadinesses();
          const value = values.find((entry) => entry.status === "ready")
            ?? values.find((entry) => entry.status === "untested")
            ?? values[0]
            ?? null;
          return { available: ["ready", "untested"].includes(value?.status), reason: value?.status === "failed" ? "翻译服务连接复检失败" : "尚未保存翻译服务配置" };
        }, "Provider 能力探测失败"),
        probe(async () => {
          const value = await getVideoCapability();
          return { available: value?.available === true, reason: value?.reason || "FFmpeg 运行时尚未就绪" };
        }, "FFmpeg 能力探测失败"),
      ]);

      const globalCapabilities = [
        capability("translation", providerProbe.available, providerProbe.reason),
        capability("asr", asrProbe.available, asrProbe.reason),
        capability("subtitle_export", true),
        capability("video_export", videoProbe.available, videoProbe.reason),
      ];
      const result = {
        probedAt: now().toISOString(),
        global: { capabilities: globalCapabilities },
      };
      if (!projectId) return result;

      const project = await getProject(projectId);
      if (!project) {
        return {
          ...result,
          project: {
            projectId,
            capabilities: globalCapabilities.map(({ id }) => capability(id, false, "当前项目不存在", "open_projects")),
          },
        };
      }
      const source = project.sourceTracks?.find((track) => track.id === project.activeSourceTrackId)
        ?? project.sourceTracks?.find((track) => track.isActive);
      const hasMedia = ["video", "audio"].includes(project.mediaKind) && project.noSourceMedia !== true;
      const targetLanguages = project.config?.targetLanguages ?? [];

      const projectCapabilities = [
        providerProbe.available
          ? capability("translation", targetLanguages.length > 0, "当前项目尚未选择目标语言", "open_project_settings")
          : capability("translation", false, providerProbe.reason),
        asrProbe.available
          ? capability("asr", hasMedia, "当前项目没有可用的音视频源", "relink_media")
          : capability("asr", false, asrProbe.reason),
        capability("subtitle_export", Boolean(source), "当前项目没有活动源字幕轨", "open_editor"),
        !videoProbe.available
          ? capability("video_export", false, videoProbe.reason)
          : project.mediaKind !== "video"
            ? capability("video_export", false, "当前项目不是视频项目", "open_project")
            : project.noSourceMedia
              ? capability("video_export", false, "当前项目需要重新关联源媒体", "relink_media")
              : capability("video_export", Boolean(source), "当前项目没有活动源字幕轨", "open_editor"),
      ];
      return {
        ...result,
        project: { projectId, capabilities: projectCapabilities },
      };
    },
  };
}
