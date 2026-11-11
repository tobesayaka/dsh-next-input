# Changelog

## 0.3.0

- `enterToSend` and `predictOnActivate` now default to `true`; both can still be
  switched off in the Settings page or the profile row `config`.
- The prediction route follows the conversation's selected model by default:
  the client reads the Session's `modelSelection` projection and sends it with
  each prediction; the Host prefers the settings route, then the selected
  model, then the answer's own route, and reports
  `route: { provider, model, source }`.
- Renamed the settings page to **NextInput** and added a top-level
  **Settings → NextInput** section with its own nav icon; the tab under
  **Settings → Plugins** keeps the same page.
- The provider dropdown's automatic entry is now “Follow the conversation's
  model” and clears both route fields when selected.
- Fixed the unreadable Save button: the primary action now uses the Host's
  `button-primary-fill` / `label-primary-foreground` pair (dark fill, light
  label in the light theme) instead of a white label on `brand-primary`, which
  is the dark text colour in the light theme. The action row is sticky at the
  bottom of the section and the buttons are taller with clearer secondary
  styling.
- 28 tests covering routes, settings, route selection, parser, and client
  registration.

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
