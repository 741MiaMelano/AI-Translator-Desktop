/**
 * 批次 token 上界估算。
 * 仅用于推导单次请求的输入/输出 token 保守上界，其中 outputTokens 同时作为
 * 真实请求的 max_output_tokens 上限；不涉及任何费用或货币计算。
 */
export function estimateTokensForBatch(batch) {
  const segments = Array.isArray(batch?.segments) ? batch.segments : [];
  const context = Array.isArray(batch?.contextSegments) ? batch.contextSegments : [];
  const projectSummary = Array.isArray(batch?.projectSummary) ? batch.projectSummary : [];
  let inputBytes = 0;
  for (const item of [...segments, ...context]) {
    inputBytes += Buffer.byteLength(String(item?.text ?? ""), "utf8");
    inputBytes += Buffer.byteLength(String(item?.segmentId ?? ""), "utf8") + 16;
  }
  inputBytes += projectSummary.reduce(
    (sum, item) => sum + Buffer.byteLength(String(item ?? ""), "utf8") + 8,
    0,
  );
  const sourceBytes = segments.reduce(
    (sum, item) => sum + Buffer.byteLength(String(item?.text ?? ""), "utf8"),
    0,
  );
  // semanticUnits 会把待译源文再带一遍；一个 token 至少编码一个 UTF-8 字节。
  const inputTokens = inputBytes + sourceBytes + 1024;
  const structuredResponseBytes = segments.reduce(
    (sum, item) => sum + Buffer.byteLength(String(item?.segmentId ?? ""), "utf8") + 64,
    512,
  );
  // 供应商不会超过这个上限；4 倍源文膨胀加 JSON/ID 开销可避免上限过小。
  const outputTokens = Math.min(8192, Math.max(256, sourceBytes * 4 + structuredResponseBytes));
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
