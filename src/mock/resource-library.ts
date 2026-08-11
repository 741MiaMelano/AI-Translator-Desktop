import {
  RESOURCE_CONTRACT_VERSION,
  type ResourceLibrary,
} from "../domain/resource-library.ts";

const updatedAt = "2026-07-23T00:00:00.000Z";

export const resourceLibraryMock: ResourceLibrary = {
  glossaries: [
    {
      id: "glossary-video",
      kind: "glossary",
      name: "视频字幕术语库",
      description: "面向英/日译中字幕本地化的默认术语约束。",
      scope: "global",
      schemaVersion: RESOURCE_CONTRACT_VERSION,
      revision: 3,
      updatedAt,
      payload: {
        languagePairs: [
          {
            sourceLanguageCode: "en-US",
            targetLanguageCode: "zh-CN",
            entries: [
              { id: "term-ai", source: "AI", target: "人工智能", partOfSpeech: "名词", domain: "科技", tags: ["核心"], note: "保留标准译法", enabled: true },
              { id: "term-ml", source: "Machine Learning", target: "机器学习", partOfSpeech: "名词", domain: "科技", tags: ["AI"], enabled: true },
              { id: "term-dl", source: "Deep Learning", target: "深度学习", partOfSpeech: "名词", domain: "科技", tags: ["AI"], enabled: true },
              { id: "term-nn", source: "Neural Network", target: "神经网络", partOfSpeech: "名词", domain: "科技", tags: ["AI"], enabled: true },
              { id: "term-dataset", source: "Dataset", target: "数据集", partOfSpeech: "名词", domain: "科技", tags: ["数据"], enabled: true },
              { id: "term-algorithm", source: "Algorithm", target: "算法", partOfSpeech: "名词", domain: "科技", tags: ["工程"], enabled: true },
              { id: "term-model", source: "Model", target: "模型", partOfSpeech: "名词", domain: "科技", tags: ["AI"], enabled: true },
              { id: "term-parameter", source: "Parameter", target: "参数", partOfSpeech: "名词", domain: "科技", tags: ["工程"], enabled: true },
            ],
          },
          {
            sourceLanguageCode: "ja-JP",
            targetLanguageCode: "zh-CN",
            entries: [
              { id: "term-ai-ja", source: "人工知能", target: "人工智能", partOfSpeech: "名词", domain: "科技", tags: ["核心"], enabled: true },
            ],
          },
        ],
      },
    },
    {
      id: "glossary-product",
      kind: "glossary",
      name: "通用产品术语",
      description: "常见产品界面和功能名称。",
      scope: "global",
      schemaVersion: RESOURCE_CONTRACT_VERSION,
      revision: 1,
      updatedAt,
      payload: {
        languagePairs: [
          { sourceLanguageCode: "en-US", targetLanguageCode: "zh-CN", entries: [] },
        ],
      },
    },
    {
      id: "glossary-podcast",
      kind: "glossary",
      name: "播客通用术语",
      description: "访谈和播客常用表达。",
      scope: "global",
      schemaVersion: RESOURCE_CONTRACT_VERSION,
      revision: 1,
      updatedAt,
      payload: {
        languagePairs: [
          { sourceLanguageCode: "en-US", targetLanguageCode: "zh-CN", entries: [] },
        ],
      },
    },
  ],
  styleGuides: [
    {
      id: "style-doc",
      kind: "style_guide",
      name: "纪录片字幕风格",
      description: "偏自然口语，保留轻量字幕压缩规则。",
      scope: "global",
      schemaVersion: RESOURCE_CONTRACT_VERSION,
      revision: 2,
      updatedAt,
      payload: {
        targetLanguageCode: "zh-CN",
        tags: ["自然", "口语", "轻压缩"],
        scenes: ["纪录片", "访谈", "课程", "直播回放"],
        rules: [
          { id: "doc-tone", title: "语气", instruction: "尽量贴近原声表达，不做文案式拔高", enabled: true },
          { id: "doc-compression", title: "压缩规则", instruction: "长句优先拆短，保留可听懂的主干信息", enabled: true },
          { id: "doc-names", title: "人名地名", instruction: "优先遵守片源已出现的译法，不轻易改写", enabled: true },
        ],
        sample: {
          sourceText: "We keep the timing natural and only fix the lines that need attention.",
          targetText: "时间轴尽量保持自然，只修真正需要注意的那几句。",
          note: "避免过度书面化，让字幕像真实说话。",
        },
      },
    },
    {
      id: "style-brand",
      kind: "style_guide",
      name: "品牌演示风格",
      description: "适合产品讲解与商业演示文案。",
      scope: "global",
      schemaVersion: RESOURCE_CONTRACT_VERSION,
      revision: 1,
      updatedAt,
      payload: {
        targetLanguageCode: "zh-CN",
        tags: ["清晰", "节奏感", "品牌一致"],
        scenes: ["品牌演示", "产品发布", "商业解说"],
        rules: [
          { id: "brand-tone", title: "语气", instruction: "使用清晰、直接的产品讲解口吻", enabled: true },
          { id: "brand-compression", title: "压缩规则", instruction: "允许适度提炼，用短句表达明确结论", enabled: true },
          { id: "brand-terms", title: "术语衔接", instruction: "统一产品名称、按钮文案和品牌主张", enabled: true },
        ],
        sample: {
          sourceText: "Then the pipeline keeps timing, QA, and export decisions in one place.",
          targetText: "随后，所有时间轴、质检与导出决策都会集中在同一条流程里。",
          note: "表达更完整、更像成体系的产品描述。",
        },
      },
    },
  ],
  subtitleStyles: [
    {
      id: "subtitle-default",
      kind: "subtitle_style",
      name: "默认样式",
      description: "适合作为全局起步模板。",
      scope: "global",
      schemaVersion: RESOURCE_CONTRACT_VERSION,
      revision: 1,
      updatedAt,
      payload: {
        format: "ass",
        bilingualLayout: "source_top_target_bottom",
        primary: { fontFamily: "Microsoft YaHei", fontSizePx: 32, textColor: "#ffffff", outlineColor: "#111111", outlineWidthPx: 2, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
        secondary: { fontFamily: "Microsoft YaHei", fontSizePx: 24, textColor: "#dddddd", outlineColor: "#111111", outlineWidthPx: 2, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
        preview: { sourceText: "This is a sample subtitle", targetText: "这是示例字幕样式", direction: "auto", backgroundColor: "#1f1f1f" },
      },
    },
    {
      id: "subtitle-cinema",
      kind: "subtitle_style",
      name: "电影黑金",
      description: "适合电影、纪录片和人物访谈。",
      scope: "global",
      schemaVersion: RESOURCE_CONTRACT_VERSION,
      revision: 2,
      updatedAt,
      payload: {
        format: "ass",
        bilingualLayout: "source_top_target_bottom",
        primary: { fontFamily: "Microsoft YaHei", fontSizePx: 34, textColor: "#f6dfb8", outlineColor: "#1f1e1b", outlineWidthPx: 2, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
        secondary: { fontFamily: "Segoe UI", fontSizePx: 25, textColor: "#eeeeee", outlineColor: "#1f1e1b", outlineWidthPx: 2, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
        preview: { sourceText: "This is a sample subtitle", targetText: "这是示例字幕样式", direction: "auto", backgroundColor: "#191714" },
      },
    },
    {
      id: "subtitle-clean",
      kind: "subtitle_style",
      name: "清爽双语",
      description: "适合课程和访谈的双语布局。",
      scope: "global",
      schemaVersion: RESOURCE_CONTRACT_VERSION,
      revision: 1,
      updatedAt,
      payload: {
        format: "ass",
        bilingualLayout: "target_top_source_bottom",
        primary: { fontFamily: "Microsoft YaHei", fontSizePx: 30, textColor: "#ffffff", outlineColor: "#27231e", outlineWidthPx: 2, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
        secondary: { fontFamily: "Segoe UI", fontSizePx: 23, textColor: "#d8d8d8", outlineColor: "#27231e", outlineWidthPx: 2, shadowColor: "#000000", shadowDepthPx: 1, position: "bottom" },
        preview: { sourceText: "This is a sample subtitle", targetText: "这是示例字幕样式", direction: "auto", backgroundColor: "#d8d0c4" },
      },
    },
  ],
  exportPresets: [
    {
      id: "export-standard",
      kind: "export_preset",
      name: "标准字幕交付",
      description: "生成译文 SRT 与双语 ASS，不烧录视频。",
      scope: "global",
      schemaVersion: RESOURCE_CONTRACT_VERSION,
      revision: 1,
      updatedAt,
      payload: {
        outputs: [
          { content: "target", format: "srt" },
          { content: "bilingual", format: "ass" },
        ],
        burnVideo: false,
        fileNameTemplate: "{project}-{language}-{content}",
        destination: { kind: "project_exports" },
      },
    },
  ],
};
