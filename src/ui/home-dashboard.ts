import type { WikiNavigationIndex } from "../core/wiki-navigation-index";
import type { EditableDocumentView } from "../editable-documents/types";
import type { RecoveryOverview, SourceManifest } from "../types";

export interface HomeDashboardSummary {
  empty: boolean;
  stats: {
    wikiPages: number;
    sources: number;
    links: number;
    notes: number;
  };
  pending: {
    readyToIngest: number;
    parsing: number;
    awaitingReview: number;
    failed: number;
    recoverable: number;
    blocked: number;
  };
}

export function homeDashboardSummary(
  navigation: WikiNavigationIndex,
  sources: SourceManifest[],
  documents: EditableDocumentView[],
  recovery: RecoveryOverview
): HomeDashboardSummary {
  const readyToIngest = sources.filter((source) =>
    source.parse.status === "parsed"
    && (source.ingest.status === "not_started" || source.ingest.status === "ingest_failed")
  ).length;
  const parsing = sources.filter((source) =>
    source.parse.status === "queued" || source.parse.status === "parsing"
  ).length;
  const awaitingReview = sources.filter((source) => source.ingest.status === "awaiting_review").length;
  const failed = sources.filter((source) =>
    source.parse.status === "parse_failed" || source.ingest.status === "ingest_failed"
  ).length;
  return {
    empty: navigation.pages.length === 0
      && sources.length === 0
      && documents.length === 0
      && recovery.counts.total === 0,
    stats: {
      wikiPages: navigation.pages.length,
      sources: sources.length,
      links: navigation.pages.reduce((sum, page) => sum + page.outgoing.length, 0),
      notes: documents.length
    },
    pending: {
      readyToIngest,
      parsing,
      awaitingReview,
      failed,
      recoverable: recovery.counts.recoverable,
      blocked: recovery.counts.blocked
    }
  };
}
