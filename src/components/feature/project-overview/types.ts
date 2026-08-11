/**
 * 项目概览页共享的渲染层类型。
 *
 * 渲染层只消费媒体探测结果的有界子集，永远不接收原始 ffprobe JSON。
 */
export type MediaProbeSummary = {
  mediaKind?: string;
  format?: { durationMs?: number | null };
  streams?: Array<Record<string, unknown>>;
  artifact?: { upstreamVersion?: string | null };
};
