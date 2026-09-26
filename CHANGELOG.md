# Changelog

## 0.1.0 (unreleased)

- Bundled Orch8 sequence schema (authoring variant) associated with `*.orch8.json|yaml|yml`, `orch8.sequence.json` and `sequences/**`; `npm run sync-schema` re-copies it from the engine.
- Save-time diagnostics from `orch8 sequence preflight` (JSON), with offline fallback to `orch8 sequence upgrade-format`; findings mapped to ranges via JSON pointers, readable paths and affected resources; `ORCH8-*` codes link to the error docs.
- CodeLens: Run in orch8 dev, Test (contracts or smoke), Preflight, Deploy (`sequence apply`), Graph.
- Block graph webview with click-to-reveal.
- Snippets for all block types and common handlers; "New Orch8 Sequence" command.
