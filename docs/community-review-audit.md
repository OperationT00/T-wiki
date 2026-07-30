# Obsidian community review audit

This document records how T-Wiki handles the findings from the Obsidian
community-plugin automated review. It distinguishes source issues that were
fixed from desktop capabilities that are intentionally retained.

## Automated review findings

| Finding | Resolution |
| --- | --- |
| Missing GitHub artifact attestations | The release workflow now attests `main.js`, `manifest.json`, and `styles.css` before creating a release. This applies to newly created releases; an existing release cannot be retroactively produced by the updated workflow. |
| Direct filesystem access | Retained only for desktop media staging, executable discovery, and streaming large immutable objects. Paths are validated against the active Vault or a controlled temporary directory. Normal note and Wiki operations use Vault/DataAdapter APIs. |
| Shell execution | Retained only for optional FFmpeg, FFprobe, and yt-dlp integrations. Processes use `spawn(executable, args)` with `shell: false`; arguments are not concatenated into a shell command. No shell capability is exposed to an LLM. |
| Full Vault enumeration | Removed. Clipper, raw verification, indexing, and linting enumerate only their configured roots. |
| Detaching leaves during unload | Removed. Obsidian owns workspace leaf lifecycle during plugin unload. |
| Direct HTML headings in settings | Replaced with Obsidian `Setting.setHeading()`. |
| `js-yaml` dependency | Replaced with the maintained `yaml` package and a local typed wrapper. A transitive development-tool dependency may still contain `js-yaml`, but production source does not import it. |
| Bare `setTimeout` / `clearTimeout` | Replaced with the plugin timer helpers backed by `window.setTimeout` and `window.clearTimeout`. |
| Unsafe TypeScript boundaries | High-risk return paths and configuration/secret boundaries were typed and validated. Provider SDK wire events and PDF data remain dynamic at their external boundary and are reported by `npm run lint:report` as non-blocking warnings. Blocking lint rules still fail `npm run verify`. |
| Unnecessary regular-expression escapes | Removed. |
| Control-character regular expression | Replaced by code-point based text-safety helpers. |
| Hard-coded `.obsidian` | Replaced with `vault.configDir`. |
| CommonJS `require` | Removed from imports and source identifiers. |
| `globalThis` usage | Removed from plugin source. |
| Permanent Vault deletion | Visible files use Obsidian's trash API. Adapter removal is limited to internal temporary, rollback, and atomic-publication data. |
| `document.createElement` | Replaced with Obsidian DOM helpers. |
| Settings definitions | Searchable `getSettingDefinitions()` metadata is provided for the major setting sections. Imperative rendering remains for compatibility with the declared minimum Obsidian version. |
| Browser `prompt` / `confirm` | Replaced with plugin modals. |
| Deprecated and unused recommendations | Security-relevant instances were removed. Remaining report-only warnings are tracked as compatibility cleanup and do not bypass Vault, secret, review, or transaction boundaries. |

## Security invariants retained after remediation

- T-Wiki is declared desktop-only.
- Tokens remain in Obsidian Secret Storage and are redacted from errors and
  audit events.
- Imported originals are immutable and content-addressed.
- Agent code cannot access arbitrary Vault paths, execute a shell, or write
  directly to canonical raw or Wiki files.
- Wiki changes still require local validation, Diff review, compare-and-swap
  checks, and transactional apply.
- Remote parsing and model calls remain explicit, configured operations.

## Release verification

Before tagging a release, run:

```sh
npm run verify
npm run release:check
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
```

After the tag workflow completes, confirm that the GitHub release contains
`main.js`, `manifest.json`, and `styles.css`, and that GitHub displays artifact
attestations for all three files.
