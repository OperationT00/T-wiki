# Security and permission model

T-Wiki is a desktop-only plugin. Its default document and Wiki operations use
Obsidian's Vault/DataAdapter APIs and stay inside the active vault.

## Elevated desktop capabilities

Two optional media features require capabilities that Obsidian reports as
high risk:

- Node.js filesystem access is limited to OS temporary directories, streamed
  media staging, executable discovery, and large-object streaming in the
  content-addressed `.llm-wiki/objects/` store. Object-store paths are derived
  from the active vault adapter, normalized, and checked to remain inside the
  vault before a native stream is opened; adapters without a local base path
  use the Obsidian DataAdapter fallback. Temporary paths are resolved and
  checked before use, and are cleaned after success, failure, cancellation, or
  timeout.
- Child processes are used only for user-enabled FFmpeg/FFprobe and yt-dlp
  workflows. Commands are executed with `spawn(executable, args)` and
  `shell: false`; URLs and paths are passed as separate arguments. The plugin
  does not provide a shell tool to the LLM.

These capabilities are disabled until the corresponding feature is configured
and initiated by the user. Remote ASR, vision, MinerU, and LLM requests show or
document their destination and require configured credentials. Tokens are kept
in Obsidian Secret Storage and are redacted from diagnostics.

## Vault access boundaries

- Clipper scanning is restricted to the configured Inbox folder.
- Wiki indexing and linting enumerate only configured `wiki/` and `raw/`
  folders, not the entire vault.
- Agent tools accept source IDs or validated Wiki paths; they cannot read
  arbitrary vault paths or write directly to `raw/`.
- Visible-file deletion uses Obsidian's trash API. Internal atomic staging and
  rollback data use the configured `.llm-wiki/` data directory.

Please report security issues privately to the repository owner through
GitHub's security advisory interface.
