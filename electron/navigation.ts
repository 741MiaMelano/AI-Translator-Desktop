import { pathToFileURL } from "node:url";

type RendererEntry =
  | { type: "url"; value: string }
  | { type: "file"; value: string };

function withoutHash(value: string): URL | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function isTrustedRendererNavigation(target: string, entry: RendererEntry): boolean {
  const targetUrl = withoutHash(target);
  const entryUrl = withoutHash(
    entry.type === "url" ? entry.value : pathToFileURL(entry.value).href,
  );
  return targetUrl !== null && entryUrl !== null && targetUrl.href === entryUrl.href;
}
