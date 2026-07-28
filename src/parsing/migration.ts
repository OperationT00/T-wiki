import { parseMarkdown, stringifyMarkdown } from "../core/wiki-core";

export function migrateSourceRawReference(
  pagePath: string,
  content: string,
  oldRawPath: string,
  newRawPath: string,
  sourceHash: string
): { changed: boolean; content: string } {
  const page = parseMarkdown(pagePath, content);
  if (!page || page.type !== "source") return { changed: false, content };
  if (String(page.frontmatter.raw_path ?? "") !== oldRawPath) return { changed: false, content };
  const existingHash = String(page.frontmatter.raw_hash ?? "");
  if (existingHash && existingHash !== sourceHash) {
    throw new Error(`Source raw_hash 与原件不一致：${pagePath}`);
  }
  return {
    changed: true,
    content: stringifyMarkdown({
      ...page.frontmatter,
      raw_path: newRawPath,
      raw_hash: sourceHash
    }, page.body)
  };
}
