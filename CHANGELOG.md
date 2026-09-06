# Changelog

All notable changes to T-Wiki are documented in this file.

## Unreleased

## 0.1.7

- Add a versioned acceptance suite for standard and incremental Ingest, direct and two-hop Query, mixed Parse workloads, crash recovery and media transcript quality.
- Evaluate P50/P95, mean, minimum and maximum metrics against explicit fail-closed thresholds.
- Require at least five samples per scenario and reject missing, duplicate, non-finite or impossible ratio observations.
- Derive latency, Provider requests, Token usage, duplicate reads, Evidence completion, Wiki reads and graph hops from existing Agent run traces.
- Keep semantic relevance, unsupported claims and transcript readability as explicit fixed-answer or manual assessments instead of inferring quality from workflow success.
- Add a metadata-only acceptance CLI and exclude local observations and reports from Git.

## 0.1.6

- Add a Recovery Center backed directly by Transaction Journal, Pending Plan, ParseAttempt and media checkpoint records.
- Surface unfinished Wiki transactions, corrupt recovery records, pending reviews, Raw publication commits, resumable media jobs and retryable parses.
- Allow safe retries for transaction recovery, Pending Plan restoration, Raw publication verification, media continuation and source parsing.
- Require explicit confirmation before discarding a corrupt Pending Plan or media checkpoint; immutable media objects and applied Wiki content remain untouched.
- Export metadata-only recovery diagnostics with Token, URL query and local-path redaction.
- Notify users at startup when automatic recovery leaves blocked items requiring attention.

## 0.1.5

- Add a user-owned `notes/t-wiki/` workspace for blank notes and hash-bound Raw revision drafts.
- Publish explicit immutable note snapshots without running an Agent, or continue through the existing Ingest and Diff review flow.
- Preserve editable-document lineage across Manifest revisions so repeated publications update one stable Source page.
- Copy Raw assets and local note images into content-addressed immutable publication bundles.
- Resolve editable titles from frontmatter, first H1, filename, and creation fallback.
- Compare arbitrary publication versions and rebase Raw revisions with a deterministic three-way merge and explicit conflict choices.
- Limit repeat Ingest runs to changed sections plus neighboring context when a verified absorbed predecessor is available.
- Persist host-authored supplement, correction, and rewrite provenance alongside verified claim-to-quote Evidence.
- Add preflighted deletion for individual snapshots and full publication history, while moving mutable drafts to the system trash independently.
- Reconcile published and absorbed document status from durable Manifests after an interrupted process.


## 0.1.2

- Address Obsidian community-review findings by scoping Vault enumeration, using supported settings and lifecycle APIs, removing browser prompt/confirm calls, and documenting desktop capability boundaries.
- Generate GitHub artifact attestations for `main.js`, `manifest.json`, and `styles.css` before publishing release assets.
- Add streamed local audio/video intake with immutable ObjectStore storage.
- Add public Bilibili caption capture with multi-part and language selection.
- Add explicit-consent Douyin public-video acquisition through a user-installed yt-dlp, with optional one-task browser-cookie retry.
- Add explicit-consent remote transcription through OpenAI-compatible and Whisper ASR Webservice protocols.
- Add FFmpeg audio preprocessing, chunked transcription, normalized timestamps, and resumable media jobs for long recordings.
- Add scene and periodic key-frame extraction with partial visual-batch recovery.
- Publish deterministic timestamped transcripts to `raw/audio/` and `raw/videos/` without changing the Ingest workflow.
- Generate concise media titles from representative transcripts and name new raw documents as `author-id - content-summary` with deterministic fallback.

## 0.1.1

- Change the Obsidian plugin ID from `llm-wiki` to the unique community ID `t-wiki`.
- Namespace Agent and MinerU Secret Storage keys under `t-wiki` to avoid collisions with other plugins.
- Keep existing `.llm-wiki/` workspace data and Markdown artifact contracts compatible.

## 0.1.0

- First stable release of the traceable Raw-to-Wiki workflow.
- Support Markdown, text, public web pages, local PDF.js parsing and optional MinerU fallback.
- Provide reviewable Agent Ingest, linked Wiki generation and Index-first multi-hop Query.
- Include first-run workspace initialization and a self-contained PDF.js worker for packaged installs.

## 0.1.0-beta.3

- Add a guided first-run homepage for initializing an empty Obsidian Vault.
- Bundle the PDF.js worker handler so local PDF parsing works in packaged installs without external files or a CDN.

## 0.1.0-beta.1

- Import Markdown, text, public web pages and PDFs into verified canonical Raw Markdown.
- Parse text PDFs locally with PDF.js and optionally fall back to MinerU for OCR and complex layouts.
- Preserve immutable source objects, manifests, parse revisions and independent Ingest attempts.
- Compile sources into Source, Entity, Concept and Synthesis pages through a reviewable Agent workflow.
- Stage all Wiki changes in memory, validate them locally and apply only after per-file Diff review.
- Maintain Wiki links, backlinks, a visible index and a rebuildable navigation index.
- Query the Wiki through Index-first navigation, section reads, multi-hop links and verified citations.
- Support OpenAI-compatible Chat Completions and Anthropic-compatible Messages APIs.
