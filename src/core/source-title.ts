const SOCIAL_TAG_TAIL = /\s+(?:[-–—|｜·]\s*)?#[\p{L}\p{N}_+-]+[\s\S]*$/u;
const LEADING_HASHTAG = /#(?=[\p{L}\p{N}_+-])/gu;

/**
 * Produces a deterministic display title from a social-video caption.
 * The original platform title remains provenance; this value is only the
 * canonical human-readable title used by raw Markdown and filenames.
 */
export function normalizeSocialVideoTitle(input: string, fallback: string): string {
  let title = stripUnsafeControlCharacters(input.normalize("NFKC"))
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/版本过低[，,、\s]*升级后可展示全部信息[\s\S]*$/u, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFE0E\uFE0F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const tagTail = title.match(SOCIAL_TAG_TAIL);
  if (!title.startsWith("#") && tagTail?.index !== undefined && tagTail.index >= 4) {
    title = title.slice(0, tagTail.index);
  } else {
    title = title.replace(LEADING_HASHTAG, "");
  }

  title = title
    .replace(/[。．.]{3,}/gu, "…")
    .replace(/…{2,}/gu, "…")
    .replace(/[!！]{2,}/gu, "！")
    .replace(/[?？]{2,}/gu, "？")
    .replace(/(\p{Script=Han})([A-Za-z0-9])/gu, "$1 $2")
    .replace(/([A-Za-z0-9])(\p{Script=Han})/gu, "$1 $2")
    .replace(/\s*[+＋]\s*/g, " + ")
    .replace(/\s+/g, " ")
    .replace(/[\s\-–—|｜·,:：,，。.!！?？…_#]+$/u, "")
    .trim();

  const bounded = [...title].slice(0, 80).join("")
    .replace(/[\s\-–—|｜·,:：,，。.!！?？…_#]+$/u, "")
    .trim();
  return bounded || fallback;
}
import { stripUnsafeControlCharacters } from "../utils/text-safety";
