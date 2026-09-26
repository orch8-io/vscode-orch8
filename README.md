# Orch8 for VS Code

Authoring support for [Orch8](https://orch8.io) durable workflow **sequences** — the JSON (and, soon, YAML) documents validated by the engine's `contracts/sequence.schema.json`.

| Feature | What you get |
| --- | --- |
| Schema | Completion, hover docs and validation for sequence files (JSON built in; YAML via [Red Hat YAML](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)) |
| Diagnostics | On save, runs `orch8 sequence preflight` (JSON output) and maps findings onto the exact block / field, with error codes and docs links |
| CodeLens | **Run in orch8 dev**, **Test**, **Preflight**, **Deploy**, **Graph** above every sequence |
| Block graph | Live SVG preview of Step / Parallel / Race / TryCatch / Loop / ForEach / Router / SubSequence / CancellationScope / A/B Split / Saga; click a node to jump to it |
| Snippets | Every block type plus `llm_call`, `human_review`, `http_request`, `wait_for_event`, `email`, `notify` |
| New sequence | **Orch8: New Orch8 Sequence** scaffolds `sequences/<name>.orch8.json` (or `.yaml`) from a starter |

<!-- SCREENSHOT PLACEHOLDER: graph preview beside a sequence (media/screenshots/graph.png) -->
<!-- SCREENSHOT PLACEHOLDER: preflight diagnostics in the Problems panel (media/screenshots/diagnostics.png) -->
<!-- SCREENSHOT PLACEHOLDER: CodeLens row + snippet completion (media/screenshots/codelens.png) -->

> Screenshots are not included yet. Add PNGs under `media/screenshots/` and a `repository` field in `package.json` before publishing (vsce needs the repository URL to rewrite relative image links).

## Which files are sequences?

- `*.orch8.json`, `*.orch8.yaml`, `*.orch8.yml`
- `orch8.sequence.json`
- any `.json` / `.yaml` / `.yml` below a `sequences/` directory (except `*.contracts.json`)
- any JSON/YAML file whose `$schema` points at `https://orch8.io/contracts/sequence.schema.json`

The bundled schema is `schemas/sequence.authoring.schema.json`: the engine schema with the server-assigned root fields (`id`, `created_at`, `tenant_id`, `namespace`, `version`) made optional, because the CLI fills them for drafts (`orch8 dev`, `sequence apply`, `generate`). The verbatim engine schema is kept alongside as `schemas/sequence.schema.json`.

Note: an in-document `"$schema"` wins over file associations in VS Code. The published `https://orch8.io/contracts/sequence.schema.json` is the *stored* shape and requires `id`, `created_at`, etc., so drafts that declare it show "missing property" errors. The starters and the `orch8-sequence` snippet therefore omit `$schema` and rely on the file-name association above.

## Diagnostics

On save (and on demand with **Orch8: Validate Sequence**) the extension:

1. parses the document (JSON via `jsonc-parser`, YAML via `yaml`) and writes a temporary JSON draft with the server-assigned fields filled in;
2. runs `orch8 [--url …] [--tenant-id …] --output json sequence preflight --file <draft>` and turns each `PreflightReport` finding into a diagnostic;
3. in `auto` mode, if the server is unreachable or rejects the draft, falls back to the offline strict check `orch8 sequence upgrade-format <draft>` (output discarded; only the error is used).

Locations are resolved from, in order: a JSON pointer / path on the finding (`pointer`, `json_pointer`, `path`, `location.pointer`), the engine's readable paths in error messages (`blocks[0].retry.max_attempts`, `unknown field "x" at blocks.0.x`), `affected_resource` (a block id, handler, sub-sequence, queue or credential is found in the document), or the first line. Codes like `ORCH8-P012` link to `https://orch8.io/docs/errors#ORCH8-P012` (configurable with `orch8.docsBaseUrl`); an explicit `docs_url` on a finding wins.

## CodeLens / commands

| Lens | Command line |
| --- | --- |
| Run in orch8 dev | `orch8 dev <file> [orch8.dev.extraArgs…]` (fresh terminal each run) |
| Test (contracts) | `orch8 test run <file-stem>.contracts.json --sequence <file>` when the contracts file exists |
| Smoke test | otherwise `orch8 dev <file> --once --dry-run --skip-timers --no-server` |
| Preflight | `orch8 [--url] [--tenant-id] sequence preflight --file <file>` |
| Deploy | `orch8 [--url] [--tenant-id] sequence apply <file> [--dry-run]` (you pick dry run or apply) |

The API key is stored with **Orch8: Set API Key** in VS Code SecretStorage and handed to the CLI only through the `ORCH8_API_KEY` environment variable — never on the command line. CLI features are disabled in untrusted workspaces.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `orch8.cliPath` | `orch8` | CLI executable |
| `orch8.serverUrl` | `""` | `--url` (empty → CLI default / `ORCH8_URL`) |
| `orch8.tenantId` | `""` | `--tenant-id` (empty → CLI default / `ORCH8_TENANT_ID`) |
| `orch8.validation.mode` | `auto` | `auto` · `preflight` · `local` · `off` |
| `orch8.validation.onSave` / `onOpen` | `true` / `false` | when to validate |
| `orch8.validation.yaml` | `true` | validate YAML via a converted JSON draft |
| `orch8.validation.timeoutMs` | `20000` | per CLI run |
| `orch8.docsBaseUrl` | `https://orch8.io/docs/errors` | error-code links |
| `orch8.codeLens.enabled` | `true` | |
| `orch8.dev.extraArgs` | `[]` | e.g. `["--skip-timers", "--dry-run"]` |

## Requirements

- An `orch8` CLI new enough to have `dev`, `test run`, `sequence preflight`, `sequence apply` and `sequence upgrade-format` (the engine's current `main`). Older installs (e.g. `orch8 0.1.0`) lack these subcommands; diagnostics will then report the CLI error on the first line.
- YAML sequences: schema support needs the Red Hat YAML extension. Running YAML files through `orch8 dev` / `sequence apply` needs an engine build with YAML input support.
- `email` / `notify` snippets target handlers that ship with newer engine builds.

## Development

```sh
npm install
npm run check          # typecheck + eslint + vitest + esbuild bundle + snippet drift check
npm run sync-schema    # re-copy ../engine/contracts/sequence.schema.json (or pass a path / ORCH8_ENGINE_DIR)
npm run schema:check   # fail if the bundled schema is out of date
npm run gen-snippets   # regenerate snippets/*.code-snippets from scripts/snippet-defs.mjs
npm run package        # build a local .vsix (no publishing)
```

Press F5 in VS Code with this folder open to launch an Extension Development Host (add a `.vscode/launch.json` of type `extensionHost` if you want one checked in).

Unit tests cover the pure modules: JSON-pointer → range resolution for JSON and YAML, CLI output parsing (preflight reports and strict-check errors), graph building and layout, CLI argument building / shell quoting, file matching, and that every snippet and starter expands to schema-valid content. There is no `@vscode/test-electron` suite: on this macOS machine it would launch a visible VS Code window rather than run headless.

## Publishing checklist (manual — nothing here publishes automatically)

Before the first release:

- [ ] Create the publisher `orch8` (or change `publisher` in `package.json`) at <https://marketplace.visualstudio.com/manage> and an Azure DevOps PAT with *Marketplace › Manage* scope.
- [ ] Claim the `orch8` namespace on Open VSX (<https://open-vsx.org>, sign the Eclipse publisher agreement, create an access token): `npx ovsx create-namespace orch8 -p <token>`.
- [ ] Add a 128×128 PNG `icon` and `galleryBanner` to `package.json`.
- [ ] Add the screenshots referenced above.
- [ ] Decide whether to declare `redhat.vscode-yaml` in `extensionDependencies` (hard) or leave it optional (current).

Every release:

- [ ] `npm run sync-schema` against the engine release you target; commit any schema change.
- [ ] Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
- [ ] `npm ci && npm run check && npm run schema:check`
- [ ] `npm run package` → inspect the file list (`npx vsce ls`) and install the `.vsix` locally (`code --install-extension vscode-orch8-<version>.vsix`) for a smoke test.
- [ ] Publish the *same* `.vsix` to both registries:
  - `npx vsce publish --packagePath vscode-orch8-<version>.vsix` (uses `VSCE_PAT`)
  - `npx ovsx publish vscode-orch8-<version>.vsix -p <OVSX_PAT>`
- [ ] Tag the release in git and push the tag.
