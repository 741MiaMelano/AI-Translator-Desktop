import type { Segment } from "./workspace";

export interface FrequentTermCandidate {
  term: string;
  count: number;
  segmentIds: string[];
  example: string;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had", "has",
  "have", "he", "her", "his", "i", "in", "is", "it", "its", "of", "on", "or", "our", "she", "that",
  "the", "their", "them", "they", "this", "to", "was", "we", "were", "will", "with", "you", "your",
  "一个", "一些", "这个", "那个", "我们", "你们", "他们", "以及", "因为", "所以", "但是", "正在",
  "これ", "それ", "ため", "です", "ます", "する", "있는", "그리고", "하지만", "에서", "으로",
]);

type WordSegment = { segment: string; isWordLike?: boolean };
type SegmenterConstructor = new (
  locale?: string,
  options?: { granularity: "word" },
) => { segment(input: string): Iterable<WordSegment> };

function words(text: string, languageCode: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  if (Segmenter) {
    const locale = languageCode && languageCode !== "auto" ? languageCode : undefined;
    let segmenter;
    try {
      segmenter = new Segmenter(locale, { granularity: "word" });
    } catch {
      segmenter = new Segmenter(undefined, { granularity: "word" });
    }
    return [...segmenter.segment(text)]
      .filter((item) => item.isWordLike !== false)
      .map((item) => item.segment);
  }
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalizedToken(value: string): string | null {
  const token = value.normalize("NFC").trim().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
  if (!token || /^\p{N}+$/u.test(token)) return null;
  const length = Array.from(token).length;
  if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) {
    return length >= 2 ? token : null;
  }
  if (length < 3 && !/^[A-Z0-9]{2,}$/u.test(token)) return null;
  return token;
}

export function extractFrequentTerms(
  segments: Segment[],
  {
    languageCode = "auto",
    minOccurrences = 2,
    limit = 50,
  }: { languageCode?: string; minOccurrences?: number; limit?: number } = {},
): FrequentTermCandidate[] {
  if (!Array.isArray(segments) || minOccurrences < 1 || limit < 1) return [];
  const found = new Map<string, FrequentTermCandidate>();
  const record = (term: string, segment: Segment, example: string) => {
    const key = term.toLowerCase();
    const current = found.get(key) ?? { term, count: 0, segmentIds: [], example };
    current.count += 1;
    if (current.segmentIds.length < 3 && !current.segmentIds.includes(segment.id)) current.segmentIds.push(segment.id);
    found.set(key, current);
  };

  for (const segment of segments) {
    const text = (segment.sourceText.manual ?? segment.sourceText.normalized ?? segment.sourceText.original).trim();
    if (!text) continue;
    const tokens = words(text, languageCode)
      .map(normalizedToken)
      .filter((token): token is string => Boolean(token) && !STOPWORDS.has(token!.toLocaleLowerCase()));
    for (const token of tokens) record(token, segment, text.slice(0, 180));
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      const compact = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(tokens[index])
        && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(tokens[index + 1]);
      record(`${tokens[index]}${compact ? "" : " "}${tokens[index + 1]}`, segment, text.slice(0, 180));
    }
  }

  return [...found.values()]
    .filter((candidate) => candidate.count >= minOccurrences)
    .sort((left, right) => right.count - left.count
      || Array.from(right.term).length - Array.from(left.term).length
      || left.term.localeCompare(right.term))
    .slice(0, limit);
}
