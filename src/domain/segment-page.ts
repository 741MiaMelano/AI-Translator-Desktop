export const SEGMENTS_PER_PAGE = 100;

export function getSegmentPage(total: number, requestedPage: number, pageSize = SEGMENTS_PER_PAGE) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
  const start = page * pageSize;
  return { page, pageCount, start, end: Math.min(total, start + pageSize) };
}
