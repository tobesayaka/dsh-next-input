# dsh-next-input

English | [中文](README.zh-CN.md)

A DeepSeek Harness (DSH) Web composer plugin. After an assistant answer, it
predicts the user's next message with the current model, paints it as ghost text
in the empty composer, and lets the user accept it with **Tab**.

## What it does

- Watches the current Session after a turn settles.
- Reads only human and assistant text from the loaded event window.
- Uses the model selected in the conversation (falling back to the route that
  produced the latest assistant answer), or an optional fixed prediction route.
- Caches predictions on the Host by `sessionId + answerKey`, so switching
  Sessions, remounting the composer, or reloading the page restores the ghost.
- Shows the prediction only while the composer is empty and the Session is idle.
- `Tab` accepts the prediction; by default plain `Enter` accepts **and sends**
  it.
- Never writes the conversation into a prediction cache, Session log, or
  `localStorage`.

## Requirements

- DSH Web UI with `conversation.input.overlay`, `settings.plugins.tab`, and
  `settings.section`.
- A registered LLM provider route.
- Node 22+/DSH version satisfied by the package `engines` field.

## Install

```bash
cd dsh-next-input
npm test
npm run check
```

Install the bundle from the DSH profile with Plugin Manager's **Install bundle**
action, or through an agent:

```text
plugin_manager install_bundle target=/Users/ming/py/dsh-plugin/dsh-next-input
```

The bundle has no package dependencies. After installation, the plugin row
`next-input` should be enabled.

## Use

1. Keep the composer empty after an assistant answer.
2. A grey prediction and a `Tab` keycap appear in the input.
3. Press `Tab` to fill the full suggestion.
4. By default (`enterToSend` on), plain `Enter` accepts and sends the
   prediction; `Shift+Enter` remains a newline.
5. Type anything, start a new turn, press `Esc`, or accept the ghost to dismiss it.

The prediction is only preview text. In accept-only mode nothing is submitted
until you press send.

## Settings

Open **Settings → NextInput** (a top-level settings section named after the
plugin). The same page is also available as **Settings → Plugins →
NextInput**. It provides:

| Control | Meaning |
|---|---|
| Enter accepts and sends (`enterToSend`) | Plain Enter accepts and submits; Tab still accepts only. Default on. |
| Predict on session open (`predictOnActivate`) | On a cache miss, opening an idle Session generates one prediction. Costs one model call. Default on. |
| Prediction provider / model | Optional fixed route, chosen from registered providers and their advertised models. By default the provider stays on “Follow the conversation's model”: each prediction uses the model selected in that conversation, falling back to the model that produced the last answer. Pick provider + model only to pin a dedicated, faster route. |
| Max output tokens (`maxTokens`) | Output cap for the auxiliary model call. |
| Timeout (ms) | Wall-clock bound for one prediction. |
| Max context characters | Conversation characters kept for the prediction. |
| Max messages | Conversation messages kept. |
| Max suggestion characters | Longest suggestion returned to the composer. |
| Usage (this Host session) | Counters for this plugin only: prediction calls, input/output/total tokens, average per call, cache-hit input, answers served from the cache, and duplicate requests refused. “Reset counters” clears them without touching the saved settings. |

- **Save** applies to the next prediction immediately. It does not reload the
  plugin and does not clear the Host prediction cache.
- Values are stored in the plugin's user-data file:
  `<DSH_HOME>/next-input/settings.json` (normally
  `~/.dsh/next-input/settings.json`).
- The row's `config` in `cordis.patch.yml` remains the baseline. **Reset to
  profile defaults** clears the settings file and falls back to that baseline.
- Provider/model dropdowns are populated through `llm.listProviders()` and
  `llm.listModels()`. A configured value that is no longer advertised is kept as
  an `(unavailable)` option.
- To restore the default “follow the conversation's model”, choose that entry
  in the provider dropdown; it clears both fields.
- Usage counters come from the provider's `usage` chunk for each prediction and
  live in Host process memory (a DSH restart clears them); `GET
  /api/next-input.usage` returns the same numbers.

## How it works

1. **Client trigger.** When a turn ends, the overlay reads the recent event
   window and schedules one prediction.
2. **Host call.** `POST /api/next-input.predict` validates the Session and
   provider, packs the last user message and final answer first, and calls
   `ctx.llm.prepareCall()` with the least advertised reasoning effort.
3. **Cache.** A successful prediction is stored in Host process memory under
   `sessionId + answerKey` (24-hour TTL, at most 100 entries).
4. **Restore.** After a Session switch, reload, or remount, the client asks
   `GET /api/next-input.cached`. A hit restores the ghost without a model call.
5. **Dismiss.** Tab/Enter acceptance or Esc writes a dismissal tombstone via
   `POST /api/next-input.dismiss`, so the prediction does not reappear after a
   reload.

**Route selection.** The client sends the Session's current model (its
`modelSelection` projection, `next` before `lastUsed`) together with the answer's
own route. The Host then calls, in order: the provider/model saved in the
settings page, the Session's selected model (when its provider is registered),
and finally the answer's route. Responses carry
`route: { provider, model, source }` with `source` being `settings`, `session`,
or `answer` (`fallback: true` when a selection was sent but unusable). The
prediction call is not the agent's own request, so it never moves the
Session's model picker.

The Host cache is process memory. A DSH/plugin restart clears it. With the
default `predictOnActivate: true`, opening a Session fills a missing cache entry
with one model call; set it to `false` to let the next turn refill instead.

## Configuration reference

All fields are optional. The profile row `config` seeds the baseline; the Settings
page stores overrides in the plugin's settings file.

| Field | Default | Meaning |
|---|---|---|
| `maxSuggestionChars` | `140` | Longest suggestion returned. |
| `maxContextChars` | `8000` | Conversation characters kept. |
| `maxMessages` | `24` | Conversation messages kept. |
| `maxTokens` | `512` | Output cap for the prediction call. |
| `timeoutMs` | `20000` | Wall-clock bound for one prediction. |
| `enterToSend` | `true` | Plain Enter accepts and sends the prediction. |
| `predictOnActivate` | `true` | Generate a missing prediction when a Session is opened. |
| `predictionProvider` | `''` | Optional fixed provider route; set both fields or neither. Empty means “follow the Session's model”. |
| `predictionModel` | `''` | Optional fixed model id; set both fields or neither. |

## Speed

A cache hit is immediate. A cache miss is one model call, so its latency is
dominated by the model. To make predictions appear sooner:

- Pick a fast, non-reasoning provider/model in the Settings page when the
  conversation's model is slow.
- Lower `maxTokens` (for example `256`) and, if needed, the context budgets.
- Keep `predictOnActivate` on when you want the ghost ready right after opening
  a Session, off to avoid pre-generation calls.
- The client starts the turn-end prediction after a short settle delay and
  retries briefly while the event window catches up.

## Privacy and cost

The recent human/assistant text is sent to the configured provider as one
auxiliary request per completed turn. The Host checks that the Session is live
and the provider is registered. Prediction text lives in Host process memory and
the optional settings file; it is not written to the Session log, disk cache, or
`localStorage`. The settings file contains only booleans, numbers, and
provider/model ids, never credentials.

Each prediction consumes provider tokens. One completed answer triggers at most
one call per page and at most one in flight per Session: the client marks the
answer it already predicted on the HTML root (cleared by a reload, whose
in-flight prediction cannot be back-filled), remembers what it consumed in the
page, refuses to re-predict from a remount or activation lookup, and the Host
refuses a duplicate `session + answer` request while the first one streams. The
Usage section of the settings page shows what was actually spent. Disable the
plugin row or turn off `predictOnActivate` to stop the extra calls.

## Troubleshooting

- **No ghost after switching Sessions or reloading:** the Host cache may be
  empty (restart or plugin reload) and `predictOnActivate` is off. The next
  completed turn repopulates it.
- **A small “Prediction: …” pill appears above the composer:** the inline ghost
  could not be measured; the pill is the fallback. Report the composer/version if
  this persists.
- **Enter fills but does not send:** the composer does not expose a submit action
  in that version, or the draft changed before submit. Tab still fills; send
  manually.
- **Settings tab missing:** refresh the page after installing/reloading the
  plugin, then reopen Settings → Plugins.
- **Prediction never appears:** check that the composer is empty, the Session is
  idle, and `llm.listProviders()` still contains the selected route.

## Limitations

- The ghost is anchored through composer DOM markers such as
  `data-composer-card`, `data-lexical-editor`, and
  `data-composer-placeholder`. A UI upgrade can make the inline ghost fall back
  to the pill or disappear; a public geometry API is not available.
- The Host cache is process memory; a DSH/plugin restart clears it.
- The trigger is a running-state transition. A turn that starts and ends between
  renders, or an answer completed while the overlay was unmounted, needs
  `predictOnActivate` (default on) or the next turn.
- No component-level browser test; route, parser, and settings route tests exist.
- “The current model” means the model selected in the Session, then the latest
  answer's route, unless a prediction route is pinned in Settings.
- Only the loaded browser event window contributes context.
- The settings page is plugin-owned rather than a schema-derived Plugin Manager
  form.
- The settings file is shared by the DSH installation (not per profile).

## Development

```bash
npm test        # 30 tests
npm run check   # node --check for host and client halves
```

Layout:

- `src/index.js` — Host routes, prediction call, cache, settings file.
- `src/client.js` — composer ghost, key handling, settings tab, locale.
- `cordis.patch.yml` — inserts the `next-input` row.
- `locale/` — Plugin Manager metadata and client strings.
- `test/` — host route, parser, and client registration tests.

## License

MIT
