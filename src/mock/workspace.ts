import {
  DEFAULT_TRANSLATION_SELECTION,
  buildTranslationCapabilityCatalog,
} from "../domain/workspace";
import { ASR_MODEL_IDS } from "../../shared/asr-model-ids.mjs";
import type {
  Project,
  ProjectTask,
  RunSnapshot,
  Segment,
  SettingsGroup,
  WorkspaceData,
} from "../domain/workspace";
import { resourceLibraryMock } from "./resource-library";

function createSegment(
  id: string,
  start: string,
  end: string,
  sourceLanguage: string,
  original: string,
  normalized: string,
  translations: {
    zhCN?: { model: string; postProcessed: string; manual?: string; qaFlags?: string[] };
    enUS?: { model: string; postProcessed: string; manual?: string; qaFlags?: string[] };
  },
): Segment {
  return {
    id,
    start,
    end,
    sourceLanguage,
    sourceText: {
      original,
      normalized,
    },
    targetTexts: {
      ...(translations.zhCN
        ? {
            "zh-CN": {
              model: translations.zhCN.model,
              postProcessed: translations.zhCN.postProcessed,
              manual: translations.zhCN.manual,
              qaFlags: translations.zhCN.qaFlags ?? [],
            },
          }
        : {}),
      ...(translations.enUS
        ? {
            "en-US": {
              model: translations.enUS.model,
              postProcessed: translations.enUS.postProcessed,
              manual: translations.enUS.manual,
              qaFlags: translations.enUS.qaFlags ?? [],
            },
          }
        : {}),
    },
  };
}

const interviewSegments = [
  createSegment(
    "seg-interview-1",
    "00:00:03,200",
    "00:00:06,800",
    "ja",
    "今日は新しい字幕翻訳ワークフローを紹介します。",
    "今日は新しい字幕翻訳ワークフローを紹介します。",
    {
      zhCN: {
        model: "今天我们介绍新的字幕翻译工作流。",
        postProcessed: "今天我们介绍新的字幕翻译工作流。",
        manual: "今天来看看新的字幕翻译工作流。",
      },
      enUS: {
        model: "Today we introduce a new subtitle translation workflow.",
        postProcessed: "Today we introduce a new subtitle translation workflow.",
      },
    },
  ),
  createSegment(
    "seg-interview-2",
    "00:00:07,120",
    "00:00:11,400",
    "ja",
    "専門用語も文脈に合わせてそろえます。",
    "専門用語も文脈に合わせてそろえます。",
    {
      zhCN: {
        model: "专业术语也会根据上下文统一。",
        postProcessed: "专业术语也会根据上下文统一。",
        qaFlags: ["term-consistency"],
      },
      enUS: {
        model: "Terminology is also kept consistent with the context.",
        postProcessed: "Terminology is also kept consistent with the context.",
      },
    },
  ),
  createSegment(
    "seg-interview-3",
    "00:00:12,000",
    "00:00:15,900",
    "ja",
    "確認が必要な箇所だけを後から手で直せます。",
    "確認が必要な箇所だけを後から手で直せます。",
    {
      zhCN: {
        model: "只需要对有疑问的地方再手工修改。",
        postProcessed: "只需要对有疑问的地方再手工修改。",
      },
      enUS: {
        model: "You only need to manually fix the lines that need confirmation.",
        postProcessed: "You only need to manually fix the lines that need confirmation.",
      },
    },
  ),
];

const productDemoSegments = [
  createSegment(
    "seg-demo-1",
    "00:00:01,000",
    "00:00:04,200",
    "en",
    "First, we detect the best source track before any translation runs.",
    "First, we detect the best source track before any translation runs.",
    {
      zhCN: {
        model: "首先，我们会在翻译前先检测最合适的源轨。",
        postProcessed: "首先，我们会在翻译前先检测最合适的源轨。",
      },
    },
  ),
  createSegment(
    "seg-demo-2",
    "00:00:04,500",
    "00:00:08,600",
    "en",
    "Then the pipeline keeps timing, QA, and export decisions in one place.",
    "Then the pipeline keeps timing, QA, and export decisions in one place.",
    {
      zhCN: {
        model: "随后，时间轴、QA 和导出决策都会放在同一个流程里。",
        postProcessed: "随后，时间轴、QA 和导出决策都会放在同一个流程里。",
        qaFlags: ["cps-warning"],
      },
    },
  ),
];

const subtitleOnlySegments = [
  createSegment(
    "seg-subtitle-1",
    "00:00:02,000",
    "00:00:05,400",
    "zh",
    "本轮更新主要重做前端信息架构。",
    "本轮更新主要重做前端信息架构。",
    {
      enUS: {
        model: "This iteration mainly rebuilds the frontend information architecture.",
        postProcessed: "This iteration mainly rebuilds the frontend information architecture.",
      },
    },
  ),
  createSegment(
    "seg-subtitle-2",
    "00:00:05,800",
    "00:00:09,200",
    "zh",
    "后端能力会在前端骨架稳定后再接入。",
    "后端能力会在前端骨架稳定后再接入。",
    {
      enUS: {
        model: "Backend capabilities will be connected after the frontend shell stabilizes.",
        postProcessed: "Backend capabilities will be connected after the frontend shell stabilizes.",
      },
    },
  ),
];

const podcastSegments = [
  createSegment(
    "seg-podcast-1",
    "00:00:10,000",
    "00:00:14,800",
    "en",
    "The approved translation is ready for subtitle export.",
    "The approved translation is ready for subtitle export.",
    {
      zhCN: {
        model: "已批准的翻译已经可以导出字幕。",
        postProcessed: "已批准的翻译已经可以导出字幕。",
        manual: "这份翻译已经审完，可以直接导出字幕。",
      },
    },
  ),
];

const projects: Project[] = [
  {
    id: "project-interview",
    title: "东京采访片段",
    sourceFileName: "tokyo-interview.mp4",
    mediaKind: "video",
    noSourceMedia: false,
    lifecycle: "needs_review",
    createdAt: "2026-07-02 19:10",
    updatedAt: "2026-07-03 14:22",
    activeSourceTrackId: "source-interview-main",
    pendingConfirmations: [
      "检测到 1 条内嵌日语字幕轨和 1 条外部 SRT，建议先确认主源轨。",
    ],
    notes: [
      "默认优先提取现有字幕轨，ASR 仍保留为候选源。",
      "中文目标轨已有人工修订，后续不要被自动结果覆盖。",
    ],
    config: {
      sourceLanguage: "自动检测",
      targetLanguages: ["简体中文", "英语"],
      provider: "OpenAI",
      model: "GPT-4.1",
      glossary: "视频字幕术语库",
      styleGuide: "纪录片字幕风格",
      outputFormat: "双语 SRT + ASS",
      burnVideo: false,
      copyMediaIntoProject: false,
    },
    sourceTracks: [
      {
        id: "source-interview-main",
        label: "内嵌日语字幕轨",
        kind: "embedded_subtitle",
        languageState: "known",
        defaultLanguage: "ja",
        isActive: true,
        summary: "首次处理先走内嵌字幕轨，ASR 结果仅作为候选源补充。",
        segments: interviewSegments,
        targetTracks: [
          {
            id: "target-interview-zh",
            languageCode: "zh-CN",
            languageLabel: "简体中文",
            status: "in_review",
            isActive: true,
            qaIssues: [
              {
                id: "qa-term-1",
                label: "术语冲突",
                severity: "warning",
                detail: "“workflow” 在 2 处用了不同译法。",
              },
              {
                id: "qa-cps-1",
                label: "阅读速度偏高",
                severity: "warning",
                detail: "第 2 段超过建议 CPS。",
              },
            ],
            snapshotIds: ["run-interview-zh-1"],
            deliveryLabel: "待校对",
            lastHumanAction: "今天 14:22 手工修改了 2 段文案",
          },
          {
            id: "target-interview-en",
            languageCode: "en-US",
            languageLabel: "英语",
            status: "draft",
            isActive: true,
            qaIssues: [],
            snapshotIds: ["run-interview-en-1"],
            deliveryLabel: "候选轨",
            lastHumanAction: "尚未进入人工复核",
          },
        ],
      },
      {
        id: "source-interview-asr",
        label: "ASR 候选源",
        kind: "asr",
        languageState: "known",
        defaultLanguage: "ja",
        isActive: false,
        summary: "作为重跑候选，不自动替换当前主源轨。",
        segments: interviewSegments,
        targetTracks: [],
      },
    ],
    recentRunIds: ["run-interview-zh-1", "run-interview-en-1"],
  },
  {
    id: "project-demo",
    title: "产品演示视频",
    sourceFileName: "product-demo.mp4",
    mediaKind: "video",
    noSourceMedia: false,
    lifecycle: "processing",
    createdAt: "2026-07-03 09:18",
    updatedAt: "2026-07-03 15:11",
    activeSourceTrackId: "source-demo-asr",
    pendingConfirmations: [],
    notes: [
      "当前是纯 ASR 流程，没有可用内嵌字幕轨。",
    ],
    config: {
      sourceLanguage: "英语",
      targetLanguages: ["简体中文"],
      provider: "OpenAI",
      model: "GPT-4o",
      glossary: "通用产品术语",
      styleGuide: "品牌演示风格",
      outputFormat: "SRT + ASS",
      burnVideo: true,
      copyMediaIntoProject: false,
    },
    sourceTracks: [
      {
        id: "source-demo-asr",
        label: "ASR 主源轨",
        kind: "asr",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "已完成识别和重切分，正在进行翻译与 QA。",
        segments: productDemoSegments,
        targetTracks: [
          {
            id: "target-demo-zh",
            languageCode: "zh-CN",
            languageLabel: "简体中文",
            status: "draft",
            isActive: true,
            qaIssues: [
              {
                id: "qa-demo-1",
                label: "行长偏长",
                severity: "warning",
                detail: "第 2 段建议切短一些再导出。",
              },
            ],
            snapshotIds: ["run-demo-zh-1"],
            deliveryLabel: "处理中",
            lastHumanAction: "尚未进入人工修订",
          },
        ],
      },
    ],
    recentRunIds: ["run-demo-zh-1"],
  },
  {
    id: "project-subtitle-only",
    title: "发布会字幕稿",
    sourceFileName: "launch-notes.srt",
    mediaKind: "subtitle",
    noSourceMedia: true,
    lifecycle: "draft",
    createdAt: "2026-07-03 11:02",
    updatedAt: "2026-07-03 11:15",
    activeSourceTrackId: "source-subtitle-only",
    pendingConfirmations: [],
    notes: [
      "当前处于 no-source-media 模式，字幕编辑和普通导出可继续。",
      "预览和烧录需要后续 relink 媒体文件。",
    ],
    config: {
      sourceLanguage: "中文",
      targetLanguages: ["英语"],
      provider: "OpenAI",
      model: "GPT-4.1 mini",
      glossary: "发布会术语",
      styleGuide: "官网文案风格",
      outputFormat: "双语 SRT",
      burnVideo: false,
      copyMediaIntoProject: false,
    },
    sourceTracks: [
      {
        id: "source-subtitle-only",
        label: "导入字幕主源轨",
        kind: "external_subtitle",
        languageState: "known",
        defaultLanguage: "zh",
        isActive: true,
        summary: "纯字幕项目会保留标准项目结构，只是暂时没有媒体预览。",
        segments: subtitleOnlySegments,
        targetTracks: [
          {
            id: "target-subtitle-en",
            languageCode: "en-US",
            languageLabel: "英语",
            status: "draft",
            isActive: true,
            qaIssues: [],
            snapshotIds: [],
            deliveryLabel: "未开跑",
            lastHumanAction: "等待首次处理",
          },
        ],
      },
    ],
    recentRunIds: [],
  },
  {
    id: "project-podcast",
    title: "播客精简版",
    sourceFileName: "podcast-cut.wav",
    mediaKind: "audio",
    noSourceMedia: false,
    lifecycle: "completed",
    createdAt: "2026-06-29 10:20",
    updatedAt: "2026-07-01 18:45",
    activeSourceTrackId: "source-podcast-asr",
    pendingConfirmations: [],
    notes: [
      "已批准中文目标轨，可以直接重新导出。",
      "烧录不是必需交付物，当前只保留字幕导出记录。",
    ],
    config: {
      sourceLanguage: "英语",
      targetLanguages: ["简体中文"],
      provider: "DeepL",
      model: "DeepL Pro",
      glossary: "播客通用术语",
      styleGuide: "访谈字幕风格",
      outputFormat: "SRT",
      burnVideo: false,
      copyMediaIntoProject: true,
    },
    sourceTracks: [
      {
        id: "source-podcast-asr",
        label: "ASR 主源轨",
        kind: "asr",
        languageState: "known",
        defaultLanguage: "en",
        isActive: true,
        summary: "整轨已经通过人工校对并导出过一次。",
        segments: podcastSegments,
        targetTracks: [
          {
            id: "target-podcast-zh",
            languageCode: "zh-CN",
            languageLabel: "简体中文",
            status: "approved",
            isActive: true,
            qaIssues: [],
            snapshotIds: ["run-podcast-zh-1"],
            deliveryLabel: "已批准",
            lastHumanAction: "2026-07-01 18:45 人工批准",
          },
        ],
      },
    ],
    recentRunIds: ["run-podcast-zh-1"],
  },
];

const tasks: ProjectTask[] = [
  {
    id: "task-demo-translate",
    projectId: "project-demo",
    label: "翻译简体中文目标轨",
    detail: "当前在批次 3/5，Provider 为 OpenAI / GPT-4o。",
    stage: "translate",
    status: "running",
    progress: 64,
    targetLanguageCode: "zh-CN",
    createdAt: "2026-07-03 09:18",
    updatedAt: "2026-07-03 15:11",
  },
  {
    id: "task-interview-review",
    projectId: "project-interview",
    label: "处理主源轨确认",
    detail: "等待用户确认是沿用内嵌字幕轨，还是切到外部 SRT。",
    stage: "detect",
    status: "paused",
    createdAt: "2026-07-03 13:40",
    updatedAt: "2026-07-03 14:22",
    progress: 28,
  },
  {
    id: "task-podcast-export",
    projectId: "project-podcast",
    label: "导出 SRT",
    detail: "最近一次导出已完成，可按同一配置再次导出。",
    stage: "export",
    status: "completed",
    createdAt: "2026-07-01 18:32",
    updatedAt: "2026-07-01 18:45",
    progress: 100,
    targetLanguageCode: "zh-CN",
  },
];

const runSnapshots: RunSnapshot[] = [
  {
    id: "run-interview-zh-1",
    projectId: "project-interview",
    sourceTrackId: "source-interview-main",
    targetLanguageCode: "zh-CN",
    provider: "OpenAI",
    model: "GPT-4.1",
    glossarySnapshot: "视频字幕术语库 v3",
    styleGuideSnapshot: "纪录片字幕风格 v2",
    promptTemplateVersion: "subtitle-v1.4",
    segmentVersion: "segment-pass-2",
    createdAt: "2026-07-03 13:56",
    cacheHits: 11,
  },
  {
    id: "run-interview-en-1",
    projectId: "project-interview",
    sourceTrackId: "source-interview-main",
    targetLanguageCode: "en-US",
    provider: "OpenAI",
    model: "GPT-4.1 mini",
    glossarySnapshot: "视频字幕术语库 v3",
    styleGuideSnapshot: "纪录片字幕风格 v2",
    promptTemplateVersion: "subtitle-v1.4",
    segmentVersion: "segment-pass-2",
    createdAt: "2026-07-03 13:58",
    cacheHits: 0,
  },
  {
    id: "run-demo-zh-1",
    projectId: "project-demo",
    sourceTrackId: "source-demo-asr",
    targetLanguageCode: "zh-CN",
    provider: "OpenAI",
    model: "GPT-4o",
    glossarySnapshot: "通用产品术语 v1",
    styleGuideSnapshot: "品牌演示风格 v1",
    promptTemplateVersion: "subtitle-v1.5",
    segmentVersion: "segment-pass-1",
    createdAt: "2026-07-03 10:12",
    cacheHits: 4,
  },
  {
    id: "run-podcast-zh-1",
    projectId: "project-podcast",
    sourceTrackId: "source-podcast-asr",
    targetLanguageCode: "zh-CN",
    provider: "DeepL",
    model: "DeepL Pro",
    glossarySnapshot: "播客通用术语 v4",
    styleGuideSnapshot: "访谈字幕风格 v1",
    promptTemplateVersion: "subtitle-v1.2",
    segmentVersion: "segment-pass-3",
    createdAt: "2026-07-01 18:32",
    cacheHits: 2,
  },
];

const settings: SettingsGroup[] = [
  {
    title: "通用行为",
    rows: [
      { label: "冷启动入口", value: "首页" },
      { label: "关闭主窗口", value: "最小化到托盘" },
      { label: "自动保存", value: "短延迟保存" },
    ],
  },
  {
    title: "缓存与存储",
    rows: [
      { label: "项目容器", value: "项目级 SQLite + artifacts/exports/logs/cache" },
      { label: "模型库路径", value: "D:/AI-Translator/models" },
      { label: "缓存策略", value: "按 snapshot 指纹命中" },
    ],
  },
  {
    title: "备份与恢复",
    rows: [
      { label: "自动备份", value: "每天 1 次" },
      { label: "草稿保留", value: "重启后仍可恢复" },
      { label: "崩溃恢复", value: "只恢复到可续跑状态" },
    ],
  },
  {
    title: "凭据与安全",
    rows: [
      { label: "API Key 存储", value: "Windows 安全凭据" },
      { label: "项目内敏感信息", value: "仅保留快照引用与非敏感配置" },
      { label: "导出覆盖策略", value: "默认新建文件，不静默覆盖" },
    ],
  },
];

export const workspaceMock: WorkspaceData = {
  defaults: {
    sourceLanguage: "自动检测",
    targetLanguages: ["简体中文"],
    provider: DEFAULT_TRANSLATION_SELECTION.provider,
    model: DEFAULT_TRANSLATION_SELECTION.model,
    styleGuide: "影视字幕",
    glossary: "视频字幕术语库",
    outputFormat: "双语 SRT",
  },
  projects,
  tasks,
  runSnapshots,
  library: resourceLibraryMock,
  capabilities: {
    providers: [
      ...buildTranslationCapabilityCatalog({
        openai: {
          credentialConfigured: false,
          connectionStatus: "untested",
        },
        "openai-compatible": {
          credentialConfigured: false,
          connectionStatus: "untested",
        },
      }),
      {
        id: "whisper-cpp",
        name: "Whisper.cpp",
        kind: "asr",
        status: "attention",
        summary: "等待桌面端校验 whisper.cpp 1.9.1 runtime 与 small 模型。",
        models: [...ASR_MODEL_IDS],
      },
    ],
    downloadSources: [
      { name: "官方源", status: "尚未检测" },
      { name: "国内镜像源", status: "尚未检测" },
    ],
    devices: [
      { name: "Auto", status: "尚未探测" },
      { name: "CPU", status: "尚未探测" },
      { name: "CUDA", status: "尚未探测" },
    ],
  },
  settings,
};
