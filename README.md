# dsh-next-input

English | [中文](README.zh-CN.md)

A DeepSeek Harness (DSH) Web composer plugin. After an assistant answer, it
predicts the user's next message with the current model, paints it as ghost text
in the empty composer, and lets the user accept it with **Tab**.

## What it does

- Watches the current Session after a turn settles.
- Reads only human and assistant text from the loaded event window; Max mode can
  add a summary of that turn's tool calls (see [Max mode](#max-mode)).
- Uses the model selected in the conversation (falling back to the route that
  produced the latest assistant answer), or an optional fixed prediction route.
- Caches predictions on the Host by `sessionId + answerKey`, so switching
  Sessions, remounting the composer, or reloading the page restores the ghost.
- Shows the prediction only while the composer is empty and the Session is idle.
- Wraps a prediction longer than one line inside the composer width, like typed
  text, instead of truncating it; the composer grows with it up to its own height
  cap, and scrolls the rest inside the input box. Max mode also stops forcing the
  prediction onto a single line (see [Max mode](#max-mode)).
- `Tab` accepts the prediction; by default plain `Enter` accepts **and sends**
  it.
- Follows the DSH interface language: the ghost hint, the announcements, and
  the Settings page switch between Chinese and English (see
  [Interface language](#interface-language)).
- Never writes the conversation into a prediction cache, Session log, or
  `localStorage`.

## Interface language

The plugin has **no language setting of its own**. The ghost hint, the
screen-reader announcements, and the Settings page follow DSH's interface
language, chosen once in **Settings → General → Language**; a switch re-renders
them without a reload.

Only the two baseline languages exist: **简体中文 (`zh`)** and **English
(`en`)**. Both dictionaries are registered with DSH's locale service
(`@deepseek-ai/dsh-client-locale`) under the single namespace `dsh-next-input`,
in one call, and `locale` is a required dependency:

```js
inject: ['slots', 'locale'],
apply(ctx) {
  ctx.effect(
    () => ctx.locale.register(NS, { zh: zhDictionary, en: enDictionary }),
    'dsh-next-input: dictionaries',
  );
}
```

- `translate(ctx, key)` reads `ctx.locale.bind(NS)(key)`; `enDictionary` is also
  the fallback when `bind` echoes the key (no locale service, e.g. a plain
  browser test).
- `subscribeLocale` / `localeRevision` feed
  `React.useSyncExternalStore`, so a language switch re-renders the ghost and
  the Settings page; the copy itself is never cached.
- The settings-section label is a function, `() => translate(ctx, 'settingsNav')`,
  which is why the sidebar row follows the language without re-registering.
- `locale/en.json` and `locale/zh.json` are **only** the plugin-card metadata
  (`meta.title`, `meta.description`) that the Plugin Manager reads. Never put UI
  copy there.

Do not add a plugin-owned language picker, register a third language, or persist
a language preference in `settings.json`. The workspace contract behind this is
in the parent README's “多语言：只跟随 DSH，只做 zh / en”.

## Requirements

- DSH Web UI with the `conversation.input.overlay`, `settings.section`, and
  `settings.section.icon` slots.
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

Open **Settings → Next input**: the plugin's own top-level settings section,
with its own sidebar row and icon, between the built-in *Shell* and *Built-in
plugins* sections. This is the only place to edit it — there is no duplicate tab
under *Built-in plugins* any more. It provides:

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
- The page and the in-composer copy follow the DSH interface language
  (Settings → General → Language); see [Interface language](#interface-language)
  for how the dictionaries are registered.

## Max mode

**Off by default.** While the master switch is off, every key below is inert and
predictions behave exactly as they did before Max mode existed: same prompt,
same single-line cleaning, same context packing, same lowest reasoning effort.

Switch it on in **Settings → Next input → Max mode**. The master switch gates
seven sub-switches; each one can be turned off on its own to find out which
change helped.

| Sub-switch | Key | What it changes |
|---|---|---|
| Tool activity | `includeToolActivity` | Adds a summary of the latest turn's tool calls to the prediction request. Files are listed by path and deduplicated, commands keep the most recent four with a count of the rest, failures are marked `[failed]`. Absolute paths are shortened to their last two segments so they match how the transcript names files. Capped at 1200 characters and cut on a line boundary. |
| Improved context packing | `smartPack` | Reserves the earliest user request before spending the context budget, then the last request and the final answer. Without it, a turn full of long answers can crowd the opening request out entirely. Still a character budget, not tokens. |
| Allow multiline suggestions | `allowMultiline` | Keeps the prediction's line breaks and cuts on a line boundary instead of collapsing to one line. While `maxSuggestionChars` is still at its default `140`, Max mode uses `400`; any explicit value wins. |
| Reasoning effort | `reasoningEffort` | `model` stops pinning the lowest advertised effort and lets the provider decide. `low` / `medium` / `high` pin a level, and are sent only when the model advertises it. |
| Retry on failure | `retryOnFailure` | Retries once after a 250 ms backoff. The retry shares the same wall-clock bound, so `timeoutMs` still caps the whole prediction. |
| Only predict after an answer | `predictOnEndOnly` | Ignores `predictOnActivate`, so opening a Session does not spend an extra model call. |
| Prediction prompt | `promptVariant` | `next` works out the situation first (asking a question, waiting for a confirmation, reporting a finished or failed result), then names the next action. When the next message carries more than one point, it uses a numbered list, a bulleted list, or a fenced block instead of one run-on sentence. `legacy` keeps the original prompt. |

**Context and output budgets.** Max mode also widens two budgets, using the
same rule as `maxSuggestionChars`: the Max mode value applies **only while the
setting is still at its default**, and any explicit value wins.

| Setting | Default | Max mode | Why |
|---|---|---|---|
| Max context characters `maxContextChars` | 8000 | 32000 | 8000 characters only fit two or three long answers, so the model cannot see how this user writes. Codex inherits the whole thread; a wider character budget closes part of that gap. |
| Max messages `maxMessages` | 24 | 64 | Same reason; in a long Session the 24-message cap runs out before the character budget does. |
| Max output tokens `maxTokens` | 512 | 1024 | A structured prediction plus a reasoning model's hidden tokens does not fit in 512. The 20 s timeout still applies. |

**Packing happens in the browser.** The client reads these values once, when the
composer overlay mounts, and caches them. So:

- The prompt, reasoning-effort, retry, multiline, and tool-activity changes
  apply to the next prediction immediately after **Save**.
- Changing `smartPack`, `includeToolActivity`, or either context budget needs a
  **page refresh** before it affects what the client sends.
- If that one read fails, every prediction falls back to the pre-Max behaviour
  rather than breaking.
- With Max mode off the client still packs a fixed 7000 characters / 24
  messages (the 0.5.x behaviour) and ignores those two settings.

A multiline suggestion is a passing shape, not a failure: when the next step
naturally needs structure (a pasted error, several conditions, a list), it
beats forcing everything onto one line. The length criterion targets empty
verbosity, not line count.

## How it works

1. **Client trigger.** When a turn ends, the overlay reads the recent event
   window and schedules one prediction.
2. **Host call.** `POST /api/next-input.predict` validates the Session and
   provider, packs the last user message and final answer first, and calls
   `ctx.llm.prepareCall()`. With Max mode off this uses the least advertised
   reasoning effort and the original prompt; the
   [Max mode](#max-mode) switches change the packing, the effort, the prompt,
   and whether a tool-activity summary rides along.
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
| `maxMode` | `false` | Master switch for Max mode. While off, none of the keys below are read. |
| `includeToolActivity` | `true` | Send the latest turn's tool calls. Only read in Max mode. |
| `smartPack` | `true` | Reserve the opening request when packing context. Only read in Max mode. |
| `allowMultiline` | `true` | Keep line breaks; lifts the suggestion cap to `400` while `maxSuggestionChars` is at its default. Only read in Max mode. |
| `reasoningEffort` | `'model'` | `model` / `low` / `medium` / `high`. Only read in Max mode. |
| `retryOnFailure` | `true` | One backoff retry inside `timeoutMs`. Only read in Max mode. |
| `predictOnEndOnly` | `true` | Ignore `predictOnActivate`. Only read in Max mode. |
| `promptVariant` | `'next'` | `legacy` / `next`. Only read in Max mode. |

The two enum keys are validated: an unknown `reasoningEffort` or
`promptVariant` is rejected by the settings route, and ignored when it comes
from the profile `config` row, rather than silently selecting a mode that does
not exist.

## Speed

A cache hit is immediate. A cache miss is one model call, so its latency is
dominated by the model. To make predictions appear sooner:

- Pick a fast, non-reasoning provider/model in the Settings page when the
  conversation's model is slow.
- Lower `maxTokens` (for example `256`) and, if needed, the context budgets.
- Keep `predictOnActivate` on when you want the ghost ready right after opening
  a Session, off to avoid pre-generation calls. In Max mode,
  `predictOnEndOnly` does the same without touching the older switch.
- The client starts the turn-end prediction after a short settle delay and
  retries briefly while the event window catches up.
- In Max mode, `reasoningEffort: 'model'` can make a reasoning model take
  longer than the old lowest-effort pin. Pin `low` if latency matters more than
  the prediction.

## Privacy and cost

The recent human/assistant text is sent to the configured provider as one
auxiliary request per completed turn. With Max mode's `includeToolActivity` on,
a summary of the latest turn's tool calls is sent too: command lines, file
paths, and failure markers — not tool output bodies. The Host checks that the
Session is live and the provider is registered. Prediction text lives in Host
process memory and the optional settings file; it is not written to the Session
log, disk cache, or `localStorage`. The settings file contains only booleans,
numbers, enum values, and provider/model ids, never credentials.

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
- **Max mode seems to do nothing:** the sub-switches are locked while the master
  switch is off. If you changed `smartPack` or `includeToolActivity`, refresh the
  page — those two are read once when the composer mounts.
- **A prediction still comes out as one line in Max mode:** `allowMultiline` is
  off, `maxSuggestionChars` was lowered below the default, or the model chose a
  single line, which is allowed.

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
- Tool activity in Max mode is a *summary*, not the tool output: it reports what
  ran and what failed, never the command's stdout or a diff body. It covers the
  latest answer's turn only; older activity is already reflected in what the
  assistant said.
- The Max mode switches that affect what the browser sends (`smartPack`,
  `includeToolActivity`) are read once per mount, so changing them needs a page
  refresh. The rest apply on the next prediction.
- The settings page is plugin-owned rather than a schema-derived Plugin Manager
  form.
- The settings file is shared by the DSH installation (not per profile).

## Development

```bash
npm test        # node --test: host routes, parser, client + locale tests
npm run check   # node --check for host and client halves
```

Layout:

- `src/index.js` — Host routes, prediction call, cache, settings file.
- `src/client.js` — composer ghost, key handling, settings section, locale.
- `cordis.patch.yml` — inserts the `next-input` row.
- `locale/` — Plugin Manager metadata only (`meta.title` / `meta.description`,
  one file per baseline language). UI copy lives in `src/client.js`.
- `test/` — host route, parser, and client registration tests.

## License

MIT
