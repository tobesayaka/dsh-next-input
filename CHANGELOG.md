# Changelog

## Unreleased

- **A multiline prediction no longer paints over the composer's tool row.** The ghost used to get its room from `min-height: calc(100% + …)` on the scrollport, which resolves against an auto-height card, so the card grew by less than the prediction and the last lines were drawn over the permission/model/send row and the status line below it — most visibly with the structured multiline predictions Max mode now asks for. The wrapper that holds the editor now reserves exactly the ghost's own height, so the composer grows like it does under a typed draft; past the composer's height cap the ghost is painted inside the scrollport's clip box and scrolls with it.
- **Max mode widens the context and output budgets.** Same rule as `maxSuggestionChars`: the Max mode value applies only while the setting is still at its default, and an explicit value wins. `maxContextChars` 8000 → 32000, `maxMessages` 24 → 64, `maxTokens` 512 → 1024. This closes the largest remaining gap to Codex's "inherit the whole thread" (Codex itself does not emit a structured prediction format; see `design/max-mode.md` §4.4).
- **The client now reads `maxContextChars` / `maxMessages` in Max mode.** The browser half used to pack a fixed 7000 characters / 24 messages (`MAX_CONTEXT_CHARS`), so raising the limits on the Settings page had no effect. **With Max mode off it still packs 7000 / 24**, so the 0.5.x path is unchanged.
- **The Max mode prompt asks for structure.** It works out the situation first (asking a question, waiting for a confirmation, reporting a finished or failed result) and, when the next message carries more than one point, asks for a numbered list, a bulleted list, or a fenced block instead of one run-on sentence. A single-point message stays one line; structure must not be invented.

## 0.5.2

- The client half reads the locale service from the injected context
  (`ctx.locale`) instead of looking it up with `ctx.get('locale')`, and
  registers its Chinese and English dictionaries from one `ctx.effect`, so a
  reload or disable of the plugin unregisters them with it.
- Dropped the unused `{name}` interpolation from `translate()`; the usage and
  invalid-number copy is filled in at the call sites, as before.
- Documented how the dictionaries are registered under **Interface
  language**, and clarified that `locale/` only holds Plugin Manager metadata.

## 0.5.1

- Labels listed from a slot's own table now follow the DSH interface language.
  The settings sidebar row and the composer copy were resolved through
  `ctx.get('locale')` before the locale service had been provided; the plugin
  now requires `locale` and registers its Chinese and English dictionaries as
  one namespace, and the Settings section labels are re-read whenever the
  interface language changes.

## 0.5.0

- Named the plugin **Next input** — **下一步输入** in Chinese — everywhere it
  is shown: the Plugins page title, the Settings sidebar row, the page title,
  and the nav icon label.
- Removed the tab under **Settings → Built-in plugins**. The page now lives
  only in the plugin's own **Settings → Next input** section, whose row order
  matches the other plugin sections; the sticky action bar no longer paints on
  the panel surface it inherited from the tab layout.

## 0.4.0

- Usage counters in the settings page (this Host session): prediction calls,
  input/output/total tokens from the provider's `usage` chunk, average per
  call, cache-hit input, cache-served answers, refused duplicates, and
  “Reset counters”. Also served at `GET /api/next-input.usage`.
- One answer no longer spends tokens twice: the overlay records predicted
  answers on the HTML root (survives remounts, cleared by reload), skips
  re-prediction from remounts and activation lookups, and the Host refuses a
  duplicate `session + answer` request while the first call is in flight.
- The in-flight guards now claim before the first await, so a duplicate that
  arrives while the first prediction is still preparing can no longer slip
  through.
- 31 tests covering routes, settings, route selection, usage, parser, and
  client registration.

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
