import { normalizeWikiIdentity } from "../core/wiki-core";
import type { WikiPage, WikiPageType } from "../types";

export interface CandidateWikiMatch {
  page: WikiPage;
  score: number;
  exactIdentity: boolean;
  sameType: boolean;
}

export interface CandidateWikiConflict {
  identity: string;
  paths: string[];
  types: WikiPageType[];
}

/** Session-local retrieval index used only by the deterministic Ingest pipeline. */
export class CandidateWikiIndex {
  private readonly entries: Array<{
    page: WikiPage;
    identities: Set<string>;
    titleText: string;
    tagText: string;
    summaryText: string;
  }>;

  constructor(pages: WikiPage[]) {
    this.entries = pages
      .filter((page) => page.type === "entity" || page.type === "concept" || page.type === "synthesis")
      .map((page) => ({
      page,
      identities: pageIdentities(page),
      titleText: `${page.title} ${page.aliases.join(" ")} ${page.basename}`.toLocaleLowerCase(),
      tagText: page.tags.join(" ").toLocaleLowerCase(),
      summaryText: page.tldr.toLocaleLowerCase()
      }));
  }

  search(title: string, queries: string[], proposedType: WikiPageType, limit = 3): CandidateWikiMatch[] {
    const exactKey = normalizeWikiIdentity(title);
    const terms = queryTerms([title, ...queries]);
    return this.entries
      .map((entry): CandidateWikiMatch => {
        const exactIdentity = Boolean(exactKey && entry.identities.has(exactKey));
        const sameType = entry.page.type === proposedType;
        let score = exactIdentity ? 100 : 0;
        if (sameType) score += 5;
        for (const term of terms) {
          if (entry.titleText.includes(term)) score += 12;
          if (entry.tagText.includes(term)) score += 6;
          if (entry.summaryText.includes(term)) score += 4;
        }
        return { page: entry.page, score, exactIdentity, sameType };
      })
      .filter((match) => match.exactIdentity || match.score > (match.sameType ? 5 : 0))
      .sort((left, right) =>
        Number(right.exactIdentity) - Number(left.exactIdentity)
        || right.score - left.score
        || Number(right.sameType) - Number(left.sameType)
        || left.page.path.localeCompare(right.page.path)
      )
      .slice(0, limit);
  }

  conflicts(): CandidateWikiConflict[] {
    const identities = new Map<string, WikiPage[]>();
    for (const entry of this.entries) {
      for (const identity of entry.identities) {
        identities.set(identity, [...(identities.get(identity) ?? []), entry.page]);
      }
    }
    const seen = new Set<string>();
    const conflicts: CandidateWikiConflict[] = [];
    for (const [identity, pages] of identities) {
      const unique = [...new Map(pages.map((page) => [page.path, page])).values()];
      if (new Set(unique.map((page) => page.type)).size < 2) continue;
      const paths = unique.map((page) => page.path).sort();
      const key = paths.join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({ identity, paths, types: [...new Set(unique.map((page) => page.type))].sort() });
    }
    return conflicts.sort((left, right) => left.paths.join("\u0000").localeCompare(right.paths.join("\u0000")));
  }
}

function pageIdentities(page: WikiPage): Set<string> {
  return new Set([page.title, ...page.aliases, page.basename.replace(/\.md$/i, "")]
    .map(normalizeWikiIdentity)
    .filter((value) => value.length >= 2));
}

function queryTerms(values: string[]): string[] {
  const terms = values.flatMap((value) => value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[\s,，.。:：;；/|()（）\[\]【】_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2));
  return [...new Set(terms)].slice(0, 20);
}
