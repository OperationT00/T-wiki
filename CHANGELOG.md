# Changelog

All notable changes to T-Wiki are documented in this file.

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
