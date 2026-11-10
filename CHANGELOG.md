# Changelog

## 0.2.0

- Host-side prediction cache keyed by `sessionId + answerKey`, with dismissal
  tombstones and restore after Session switches, page reloads, and port changes.
- Settings → Plugins → “Next input” page: toggles, numeric fields, and
  provider/model dropdowns populated from `llm.listProviders()` and
  `llm.listModels()`.
- Plugin-owned settings file with live apply; profile row `config` remains the
  baseline and “Reset to profile defaults” clears the file.
- Optional faster prediction route; least advertised reasoning effort;
  `max-tokens` handling and partial suggestions.
- Undoable Tab fill via `insertText` with `setDraft` fallback; optional Enter
  accepts and sends.
- Host Session/provider validation, per-Session in-flight limit, client timeout,
  JSON-framed untrusted conversation input, curated error responses.
- Ghost measurement retries, placeholder-based anchor, fallback pill, RTL/theme
  token handling.
- 23 tests covering routes, settings, parser, and client registration.

## 0.1.0

- Initial Web composer prediction plugin with Tab acceptance.
