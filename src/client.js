/**
 * Browser half of `dsh-next-input`.
 *
 * Registers one entry in `conversation.input.overlay`. After a turn settles, the
 * entry reads the recent conversation, asks the Host route for one prediction,
 * and paints it as ghost text at the empty composer's caret. Tab accepts the
 * ghost through `inputActions.setDraft`; the entry then disappears, so Tab keeps
 * its ordinary meaning until the next answer produces a new suggestion.
 */

window.__ModuleLoader__.load({
  id: 'dsh-next-input',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-next-input';
    const ROUTE = 'api/next-input.predict';
    const GHOST_ATTR = 'data-dsh-next-input-ghost-on';
    // The 0.5.x packing budget, used verbatim while Max mode is off. The
    // settings page no longer exposes it outside Max mode.
    const LEGACY_CONTEXT_CHARS = 7000;
    const LEGACY_MAX_MESSAGES = 24;
    // Tool activity is orientation, not a transcript: keep it small enough to
    // leave the conversation budget intact.
    const MAX_TOOL_ACTIVITY_CHARS = 1200;
    const SETTLE_DELAY_MS = 50;
    const EMPTY = [];


    const CSS = `
[${GHOST_ATTR}] [data-composer-placeholder]{visibility:hidden !important}
`;

    /** Two clip boxes describe the same rectangle (or are both missing). */
    function sameClip(a, b) {
      if (a === b) return true;
      if (a === null || b === null || a === undefined || b === undefined) return false;
      return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
    }

    /** The DSH locale service injected into this plugin's context, or `null`. */
    function localeService(ctx) {
      try {
        const face = ctx.locale;
        return face !== undefined && face !== null && typeof face.bind === 'function' ? face : null;
      } catch (error) {
        return null;
      }
    }

    /** The locale revision (bumps on a language switch and on registration), or 0. */
    function localeRevision(ctx) {
      const face = localeService(ctx);
      if (face === null) return 0;
      try {
        const snapshot = face.getSnapshot();
        return snapshot !== null && snapshot !== undefined && typeof snapshot.revision === 'number' ? snapshot.revision : 0;
      } catch (error) {
        return 0;
      }
    }

    /**
     * Subscribe to locale revisions. Returns a no-op before the service exists;
     * the next render after it appears resubscribes (the subscribe identity is
     * stable, so React keeps the one subscription once there is something to
     * subscribe to).
     */
    function subscribeLocale(ctx, notify) {
      const face = localeService(ctx);
      if (face === null || typeof face.subscribe !== 'function') return () => {};
      try {
        const stop = face.subscribe(notify);
        return typeof stop === 'function' ? stop : () => {};
      } catch (error) {
        return () => {};
      }
    }

    /**
     * Copy for one key: the active DSH language when the locale service has the
     * namespace, the built-in English text otherwise.
     * @param {any} ctx
     * @param {string} key
     * @returns {string}
     */
    function translate(ctx, key) {
      const face = localeService(ctx);
      let text = '';
      if (face !== null) {
        try {
          text = String(face.bind(NS)(key) ?? key);
        } catch (error) {
          text = '';
        }
      }
      // `bind` echoes the key when the namespace has no entry; that is not copy.
      if (text === '' || text === key || text === NS + '.' + key) text = enDictionary[key] || key;
      return text;
    }

    // Session-scoped marks live on the HTML root (not localStorage): they
    // vanish with the page and survive overlay remounts and HMR, so one answer
    // triggers at most one model call per page. `tab`/`hit`/`routed` are
    // settled states, `t0` marks a prediction that started at that time.
    const SESSION_MARKS_ATTR = 'data-dsh-next-input';
    // After a page reload nothing is remembered. Within this window an in-flight
    // prediction cannot be back-filled (the Host finishes it and caches it), so
    // a missing cache entry means it failed and must not be retried.
    const RELOAD_GUARD_MS = 60000;

    /** @param {string} text @returns {Record<string, number | string>} */
    function readSessionMarks(text) {
      const marks = {};
      if (typeof text !== 'string' || text === '') return marks;
      for (const part of text.split(';')) {
        const separator = part.indexOf(':');
        if (separator <= 0) continue;
        marks[part.slice(0, separator)] = part.slice(separator + 1);
      }
      return marks;
    }

    const CACHE_ROUTE = 'api/next-input.cached';
    const DISMISS_ROUTE = 'api/next-input.dismiss';
    const SETTINGS_ROUTE = 'api/next-input.settings';
    const SETTINGS_LIMITS = {
      maxSuggestionChars: [20, 500],
      maxContextChars: [1000, 50000],
      maxMessages: [2, 100],
      maxTokens: [64, 4096],
      timeoutMs: [1000, 120000],
    };

    /**
     * The model this Session currently has selected, read from the Host's
     * `modelSelection` projection (`next` is the pending choice, `lastUsed` the
     * route of the latest answer). Never throws: a missing projection simply
     * means the Host falls back to the answer's own route.
     * @param {any} sessions
     * @param {string | undefined} sessionId
     * @returns {{ provider: string, model: string } | null}
     */
    function readSelection(sessions, sessionId) {
      if (sessions === undefined || sessions === null || sessionId === undefined || sessionId === null) return null;
      try {
        const binding = sessions.binding(sessionId);
        const projections = binding === undefined || binding === null ? undefined : binding.projections;
        if (projections === undefined || projections === null || typeof projections.faceOf !== 'function') return null;
        const face = projections.faceOf('modelSelection');
        const value = face === undefined || face === null || typeof face.getSnapshot !== 'function'
          ? undefined
          : face.getSnapshot();
        if (value === null || value === undefined || typeof value !== 'object') return null;
        const picked = value.next === null || value.next === undefined ? value.lastUsed : value.next;
        if (picked === null || picked === undefined) return null;
        const provider = typeof picked.provider === 'string' ? picked.provider.trim() : '';
        const model = typeof picked.model === 'string' ? picked.model.trim() : '';
        return provider === '' || model === '' ? null : { provider, model };
      } catch {
        return null;
      }
    }

    /**
     * Text blocks of one message; reasoning and tool payloads stay out.
     * @param {unknown} content
     * @returns {string}
     */
    function contentText(content) {
      if (!Array.isArray(content)) return '';
      const parts = [];
      for (const block of content) {
        if (block !== null && block !== undefined && block.type === 'text'
          && typeof block.text === 'string' && block.text.trim() !== '') {
          parts.push(block.text.trim());
        }
      }
      return parts.join('\n\n');
    }

    /** Tools whose arguments point at a file, reported by path. */
    const FILE_TOOLS = new Set(['read', 'view', 'view_image', 'write', 'create', 'edit', 'str_replace', 'apply_patch']);
    /** How many command lines one tool keeps before older ones are counted. */
    const COMMAND_LINES_PER_TOOL = 4;

    /**
     * One readable row per tool call: what the assistant actually did.
     *
     * `arguments` arrives as the raw JSON string the model produced, so a
     * malformed value falls back to the bare tool name instead of throwing.
     * The goal is orientation ("it edited src/client.js and ran the tests"),
     * not fidelity: results are reduced to a failure marker.
     * @param {unknown} rawName
     * @param {unknown} raw
     * @returns {{ tool: string, target: string, line: string }}
     */
    function toolArgumentsSummary(rawName, raw) {
      const tool = typeof rawName === 'string' && rawName !== '' ? rawName : 'tool';
      let args = null;
      if (typeof raw === 'string' && raw.trim() !== '') {
        try {
          args = JSON.parse(raw);
        } catch {
          args = null;
        }
      } else if (raw !== null && typeof raw === 'object') {
        args = raw;
      }
      const pick = (...keys) => {
        if (args === null || typeof args !== 'object') return '';
        for (const key of keys) {
          const value = args[key];
          if (typeof value === 'string' && value.trim() !== '') return value.trim();
        }
        return '';
      };
      const clip = (text, limit) => (text.length > limit ? text.slice(0, limit) + '…' : text);
      // The transcript names files the way the assistant did (relative to the
      // workspace); an absolute path from a tool argument would not match it.
      // Keeping the last two segments lands on the same file in practice.
      const shortPath = (value) => {
        if (!value.startsWith('/')) return clip(value, 160);
        const parts = value.split('/').filter((part) => part !== '');
        return parts.length <= 2 ? value : '…/' + parts.slice(-2).join('/');
      };

      if (FILE_TOOLS.has(tool)) {
        const path = pick('path', 'file_path', 'filePath', 'file');
        const target = path === '' ? tool : tool + ' ' + shortPath(path);
        return { tool, target, line: target };
      }
      if (tool === 'bash' || tool === 'shell') {
        const command = pick('command', 'cmd');
        const line = command === '' ? tool : tool + ': ' + clip(command.replace(/\s+/gu, ' '), 160);
        return { tool, target: line, line };
      }
      if (tool === 'grep' || tool === 'search' || tool === 'glob' || tool === 'find') {
        const pattern = pick('pattern', 'query', 'glob');
        const path = pick('path', 'directory', 'cwd');
        const where = path === '' ? '' : ' in ' + clip(path, 100);
        const line = pattern === '' ? tool + where : tool + ' ' + clip(pattern, 100) + where;
        return { tool, target: line, line };
      }
      const first = pick('description', 'command', 'path', 'file_path', 'query', 'pattern');
      const line = first === '' ? tool : tool + ': ' + clip(first.replace(/\s+/gu, ' '), 140);
      return { tool, target: line, line };
    }

    /**
     * Tool activity of the latest answer's turn, as a short text block for the
     * predictor. Only the last turn is summarised: older activity is already
     * reflected in what the assistant said, and the point here is "what just
     * happened".
     * @param {Array<any>} entries
     * @returns {string}
     */
    function toolActivitySummary(entries, maxChars) {
      // Find the seq of the latest assistant message, then everything from the
      // turn start of that answer is the activity to summarise.
      let lastAssistantSeq = -1;
      let lastTurnStartSeq = -1;
      for (const entry of entries) {
        if (entry === null || entry === undefined || entry.type !== 'event') continue;
        const event = entry.event;
        if (event === null || event === undefined) continue;
        if (event.type === 'assistant/message' && typeof event.seq === 'number') {
          lastAssistantSeq = event.seq;
        }
        if (event.type === 'turn/start' && typeof event.seq === 'number') {
          lastTurnStartSeq = event.seq;
        }
      }
      if (lastAssistantSeq < 0) return '';

      const calls = new Map();
      const order = [];
      for (const entry of entries) {
        if (entry === null || entry === undefined || entry.type !== 'event') continue;
        const event = entry.event;
        if (event === null || event === undefined) continue;
        const seq = typeof event.seq === 'number' ? event.seq : -1;
        if (seq < 0 || seq > lastAssistantSeq) continue;
        if (lastTurnStartSeq >= 0 && seq < lastTurnStartSeq) continue;
        const data = event.data;
        if (data === null || typeof data !== 'object') continue;
        if (event.type === 'tool/call') {
          const callId = typeof data.callId === 'string' ? data.callId : '';
          const row = toolArgumentsSummary(data.name, data.arguments);
          calls.set(callId, { ...row, failed: false });
          order.push(callId);
        } else if (event.type === 'tool/result') {
          const callId = typeof data.callId === 'string'
            ? data.callId
            : (data.message !== null && typeof data.message === 'object' && typeof data.message.toolCallId === 'string'
              ? data.message.toolCallId
              : '');
          const entryRow = calls.get(callId);
          const message = data.message !== null && typeof data.message === 'object' ? data.message : null;
          const failed = data.error !== undefined && data.error !== null
            || (message !== null && message.isError === true);
          if (entryRow !== undefined) entryRow.failed = failed;
          else {
            // A result whose call fell outside the window: the tool name is
            // the only thing left to report.
            calls.set(callId, { ...toolArgumentsSummary(data.name, null), failed });
            order.push(callId);
          }
        }
      }
      if (order.length === 0) return '';

      // Group by tool so a turn that ran thirty commands still reports which
      // files it read and edited. Files are what the next message usually
      // refers to, so they survive; commands are kept to the most recent few.
      const byTool = new Map();
      for (const callId of order) {
        const row = calls.get(callId);
        const tool = row.tool;
        if (!byTool.has(tool)) byTool.set(tool, []);
        byTool.get(tool).push(row);
      }
      const lines = [];
      for (const [tool, rows] of byTool) {
        if (FILE_TOOLS.has(tool)) {
          const seen = new Set();
          for (const row of rows) {
            if (seen.has(row.target)) continue;
            seen.add(row.target);
            lines.push('-' + ' ' + row.target + (row.failed ? ' [failed]' : ''));
          }
          continue;
        }
        const recent = rows.slice(-COMMAND_LINES_PER_TOOL);
        if (recent.length < rows.length) lines.push('-' + ' ' + tool + ': ' + (rows.length - recent.length) + ' earlier calls');
        for (const row of recent) {
          lines.push('-' + ' ' + row.line + (row.failed ? ' [failed]' : ''));
        }
      }
      const body = lines.join('\n');
      if (body.length <= maxChars) return body;
      // Cut on a line boundary: half a command reads as a different command.
      const cut = body.slice(0, maxChars);
      const boundary = cut.lastIndexOf('\n');
      return (boundary > 0 ? cut.slice(0, boundary) : cut) + '\n- …';
    }

    /**
     * Conversation characters to pack with. Max mode reads the setting; with
     * Max off the hardcoded 0.5.x budget applies.
     * @param {{ maxContextChars?: number }} maxSettings
     * @param {boolean} max
     */
    function contextCharsForSettings(maxSettings, max) {
      const value = maxSettings === null || maxSettings === undefined ? undefined : maxSettings.maxContextChars;
      return max && typeof value === 'number' ? value : LEGACY_CONTEXT_CHARS;
    }

    /**
     * Message-count budget to pack with.
     * @param {{ maxMessages?: number }} maxSettings
     * @param {boolean} max
     */
    function maxMessagesForSettings(maxSettings, max) {
      const value = maxSettings === null || maxSettings === undefined ? undefined : maxSettings.maxMessages;
      return max && typeof value === 'number' ? value : LEGACY_MAX_MESSAGES;
    }

    /**
     * Keep the final answer and the user request that produced it even when the
     * answer is much longer than the character budget. Older messages fill the
     * remainder, newest first.
     * @param {Array<{ role: string, text: string }>} all
     * @param {number} maxChars
     * @param {number} maxMessages
     */
    function packConversation(all, maxChars, maxMessages) {
      let lastAssistant = -1;
      let lastUser = -1;
      for (let index = all.length - 1; index >= 0; index -= 1) {
        if (lastAssistant < 0 && all[index].role === 'assistant') lastAssistant = index;
        if (lastUser < 0 && all[index].role === 'user') lastUser = index;
        if (lastAssistant >= 0 && lastUser >= 0) break;
      }
      if (lastAssistant < 0) return [];

      const picked = [];
      const used = new Set();
      let budget = Math.max(1, maxChars);
      const add = (index, cap, keepTail) => {
        if (index < 0 || used.has(index) || picked.length >= maxMessages) return false;
        const room = Math.min(cap, budget);
        if (room < 20) return false;
        let text = all[index].text;
        if (text.length > room) {
          text = keepTail ? text.slice(text.length - room) : text.slice(0, room);
        }
        text = text.trim();
        if (text === '') return false;
        picked.push({ index, role: all[index].role, text });
        used.add(index);
        budget -= text.length;
        return true;
      };

      add(lastAssistant, Math.max(40, Math.floor(maxChars * 0.55)), true);
      add(lastUser, Math.max(40, Math.floor(maxChars * 0.35)), false);

      for (let index = all.length - 1; index >= 0 && picked.length < maxMessages && budget > 40; index -= 1) {
        if (used.has(index)) continue;
        add(index, budget, true);
      }

      picked.sort((left, right) => left.index - right.index);
      return picked.map(({ role, text }) => ({ role, text }));
    }

    /**
     * Max mode packing: reserve the earliest user request before spending the
     * budget, so the message that says what the user actually wants cannot be
     * crowded out by newer answers. The final answer keeps the largest share,
     * the last request is next, and whatever is left fills newest-first.
     *
     * Still a character estimate, not tokens: `maxChars` is the same knob the
     * rest of the plugin already exposes.
     * @param {Array<{ role: string, text: string }>} all
     * @param {number} maxChars
     * @param {number} maxMessages
     */
    function packConversationSmart(all, maxChars, maxMessages) {
      let lastAssistant = -1;
      for (let index = all.length - 1; index >= 0; index -= 1) {
        if (all[index].role === 'assistant') {
          lastAssistant = index;
          break;
        }
      }
      if (lastAssistant < 0) return [];

      // The oldest still-relevant request: the first user message of the turn
      // that produced the latest answer, or the very first one in the window.
      let firstUser = -1;
      for (let index = 0; index < all.length; index += 1) {
        if (all[index].role === 'user') {
          firstUser = index;
          break;
        }
      }
      let lastUser = -1;
      for (let index = lastAssistant - 1; index >= 0; index -= 1) {
        if (all[index].role === 'user') {
          lastUser = index;
          break;
        }
      }

      const picked = [];
      const used = new Set();
      let budget = Math.max(1, maxChars);
      const add = (index, cap, keepTail) => {
        if (index < 0 || used.has(index) || picked.length >= maxMessages) return false;
        const room = Math.min(cap, budget);
        if (room < 20) return false;
        let text = all[index].text;
        if (text.length > room) {
          text = keepTail ? text.slice(text.length - room) : text.slice(0, room);
        }
        text = text.trim();
        if (text === '') return false;
        picked.push({ index, role: all[index].role, text });
        used.add(index);
        budget -= text.length;
        return true;
      };

      // Reserve the opening request first. It is usually short, and without it
      // the predictor only sees what was asked most recently, not the goal.
      add(firstUser, Math.max(40, Math.floor(maxChars * 0.2)), false);
      // Then the request that produced the latest answer, and that answer.
      add(lastUser, Math.max(40, Math.floor(maxChars * 0.25)), false);
      add(lastAssistant, Math.max(40, Math.floor(maxChars * 0.45)), true);

      for (let index = all.length - 1; index >= 0 && picked.length < maxMessages && budget > 40; index -= 1) {
        if (used.has(index)) continue;
        add(index, budget, true);
      }

      picked.sort((left, right) => left.index - right.index);
      return picked.map(({ role, text }) => ({ role, text }));
    }

    /**
     * Recent human and assistant text from the loaded Session window, oldest
     * first, plus the route that produced the latest answer.
     * @param {any} sessions
     * @param {string | undefined} sessionId
     * @param {{ maxMode: boolean, smartPack: boolean } | null} maxSettings
     */
    function readConversation(sessions, sessionId, maxSettings) {
      if (sessions === undefined || sessions === null || sessionId === undefined || sessionId === null) {
        return { messages: EMPTY, model: null, answerKey: null };
      }
      let binding;
      try {
        binding = sessions.binding(sessionId);
      } catch {
        return { messages: EMPTY, model: null, answerKey: null };
      }
      if (binding === undefined || binding === null) return { messages: EMPTY, model: null, answerKey: null };
      const source = binding.eventSource;
      if (source === undefined || source === null || typeof source.getSnapshot !== 'function') {
        return { messages: EMPTY, model: null, answerKey: null };
      }
      let snapshot;
      try {
        snapshot = source.getSnapshot();
      } catch {
        return { messages: EMPTY, model: null, answerKey: null };
      }
      if (snapshot === undefined || snapshot === null || !Array.isArray(snapshot.entries)) {
        return { messages: EMPTY, model: null, answerKey: null };
      }

      const all = [];
      let model = null;
      let answerKey = null;
      const pushText = (role, text) => {
        const last = all[all.length - 1];
        if (last !== undefined && last.role === role && last.text === text) return;
        all.push({ role, text });
      };
      for (const entry of snapshot.entries) {
        if (entry === null || entry === undefined || entry.type !== 'event') continue;
        const event = entry.event;
        if (event === null || event === undefined || event.surfaceOp !== 'append') continue;

        if (event.type === 'user/message') {
          const data = event.data;
          if (data === null || data === undefined) continue;
          if (data.source === null || data.source === undefined || data.source.kind !== 'user') continue;
          const text = contentText(data.content);
          if (text !== '') pushText('user', text);
          continue;
        }

        if (event.type === 'assistant/message') {
          const message = event.data === null || event.data === undefined ? null : event.data.message;
          if (message === null || message === undefined) continue;
          const text = contentText(message.content);
          if (text !== '') pushText('assistant', text);
          if (typeof event.seq === 'number') answerKey = 'seq:' + event.seq;
          else if (message.id !== undefined && message.id !== null) answerKey = 'id:' + String(message.id);
          const from = message.source;
          if (from !== null && from !== undefined && typeof from.provider === 'string'
            && typeof from.model === 'string' && from.provider !== '' && from.model !== '') {
            model = { provider: from.provider, model: from.model };
          }
        }
      }

      // The Max mode switches and the budgets they own. The budgets are only
      // read in Max mode; with Max off, packing keeps the hardcoded 0.5.x
      // values and never looks at the settings.
      const max = maxSettings !== null && maxSettings !== undefined && maxSettings.maxMode === true;
      const contextChars = contextCharsForSettings(maxSettings, max);
      const maxMessages = maxMessagesForSettings(maxSettings, max);
      const messages = max && maxSettings.smartPack === true
        ? packConversationSmart(all, contextChars, maxMessages)
        : packConversation(all, contextChars, maxMessages);
      const toolActivity = max && maxSettings.includeToolActivity === true
        ? toolActivitySummary(snapshot.entries, MAX_TOOL_ACTIVITY_CHARS)
        : '';
      return { messages, model, answerKey, toolActivity };
    }

    /** The Lexical root the overlay is anchored to. */
    function findEditor(card) {
      if (card === null || card === undefined) return null;
      return card.querySelector('[data-lexical-editor="true"]')
        || card.querySelector('[contenteditable="true"]')
        || card.querySelector('[contenteditable]:not([contenteditable="false"])');
    }

    function createComposerNextInput(ctx) {
      return function ComposerNextInput(props) {
      const options = props || {};
      const useInput = typeof options.useInput === 'function'
        ? options.useInput
        : (select) => select({ draft: '', phase: 'plain' });
      const useSession = typeof options.useSession === 'function'
        ? options.useSession
        : (select) => select(undefined);
      const inputActions = options.inputActions;
      const sessionId = options.sessionId;

      const draft = useInput((state) => (state !== null && state !== undefined && typeof state.draft === 'string' ? state.draft : ''));
      const phase = useInput((state) => (state !== null && state !== undefined && typeof state.phase === 'string' ? state.phase : 'inert'));
      const running = useSession((state) => (state !== null && state !== undefined && state.running === true));

      // Re-read on every locale revision: the dictionaries may register, or the
      // interface language switch, after this entry first rendered. The outlet
      // already re-renders on locale changes; this keeps the copy correct even
      // when the plugin is mounted outside one. The revision is kept in a local
      // so the effect below can depend on the number, not on the helper.
      const localeNow = React.useSyncExternalStore(
        React.useCallback((notify) => subscribeLocale(ctx, notify), []),
        () => localeRevision(ctx),
        () => 0,
      );

      const t = (key) => translate(ctx, key);

      const rootRef = React.useRef(null);
      const inputActionsRef = React.useRef(inputActions);
      const suggestionRef = React.useRef(null);
      const draftRef = React.useRef('');
      const phaseRef = React.useRef('inert');
      const sessionRef = React.useRef(sessionId);
      const runningRef = React.useRef(running);
      const previousRef = React.useRef({ sessionId, running });
      const requestSeqRef = React.useRef(0);
      const abortRef = React.useRef(null);
      const timerRef = React.useRef(0);
      const mountedRef = React.useRef(true);
      const restoreRetryRef = React.useRef(0);
      const lookupRef = React.useRef(null);
      const lookupInFlightRef = React.useRef(null);
      const dismissedRef = React.useRef(null);
      // `sessionId|answerKey` pairs that already consumed a model call in this
      // page (or were settled after it). Mirrored on the HTML root so the
      // marks outlive an overlay remount, which a per-mount ref cannot.
      const requestedRef = React.useRef(new Set());
      // Same marks as history.replaceState patches: no server request and no
      // history entries; cleared by a page reload.
      const routeRef = React.useRef(null);
      // Window-behind retries for one scheduled prediction; reset on schedule.
      const attemptsRef = React.useRef(0);
      // Max mode switches read once per page from the settings route. The
      // packing happens in this half, so it needs the Host's values; a failed
      // read leaves the 0.5.x packing in place.
      const maxRef = React.useRef(null);

      const [suggestion, setSuggestion] = React.useState(null);
      const [box, setBox] = React.useState(null);
      const [fallbackReady, setFallbackReady] = React.useState(false);
      const [restoreTick, setRestoreTick] = React.useState(0);

      draftRef.current = typeof draft === 'string' ? draft : '';
      phaseRef.current = phase;
      sessionRef.current = sessionId;
      runningRef.current = running;
      suggestionRef.current = suggestion;
      inputActionsRef.current = inputActions;

      const clearTimer = () => {
        if (timerRef.current !== 0) {
          window.clearTimeout(timerRef.current);
          timerRef.current = 0;
        }
      };

      const cancelPending = () => {
        clearTimer();
        requestSeqRef.current += 1;
        if (abortRef.current !== null) {
          abortRef.current.abort();
          abortRef.current = null;
        }
      };

      const clearSuggestion = () => {
        suggestionRef.current = null;
        setSuggestion(null);
      };

      const readMarks = () => {
        const route = routeRef.current;
        if (route !== null) return route;
        try {
          const root = document.documentElement;
          return readSessionMarks(root === null || root === undefined ? '' : root.getAttribute(SESSION_MARKS_ATTR));
        } catch {
          return {};
        }
      };

      /** Merge `patch` into the page's Session marks. Never throws. */
      const mark = (patch) => {
        try {
          const merged = { ...readMarks(), ...patch };
          // Keep the attribute short: history.replaceState patches treat it as
          // page state, and only the latest answer matters.
          for (const name of ['hit', 'routed', 'tab', 'key']) {
            if (merged[name] !== patch[name] && merged[name] !== undefined) delete merged[name];
          }
          Object.assign(merged, patch);
          routeRef.current = merged;
          const root = document === undefined ? undefined : document.documentElement;
          if (root === null || root === undefined || typeof root.setAttribute !== 'function') return;
          const text = Object.entries(merged).map(([name, value]) => name + ':' + value).join(';');
          root.setAttribute(SESSION_MARKS_ATTR, text);
        } catch {
          // Marks are an optimisation; a missing DOM must never break the ghost.
        }
      };

      const dismissPrediction = (session, answerKey) => {
        if (session === undefined || session === null || answerKey === undefined || answerKey === null || answerKey === '') return;
        dismissedRef.current = session + '|' + answerKey;
        mark({ tab: session + '|' + answerKey });
        void fetch(DISMISS_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: session, answerKey }),
        }).catch(() => {});
      };

      const accept = (send = false) => {
        const current = suggestionRef.current;
        const actions = inputActionsRef.current;
        if (current === null || actions === undefined || actions === null) return;
        if (current.sessionId !== undefined && current.sessionId !== sessionRef.current) {
          // A Session switch raced the clearing effect; never write into the
          // previous Session's composer.
          clearSuggestion();
          return;
        }
        const session = current.sessionId;
        cancelPending();
        try {
          // Prefer the undoable insertion API; setDraft is the fallback for
          // composers/versions that do not expose it.
          let filled = false;
          if (typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
            try {
              filled = actions.insertText(current.text, actions.captureInsertion()) === true;
            } catch {
              filled = false;
            }
          }
          if (!filled) actions.setDraft(current.text);
        } catch (error) {
          console.error('next-input: the composer refused the predicted draft', error);
          return;
        }
        dismissPrediction(session, current.answerKey);
        // Drop the preview before React re-renders so a held/repeated Tab cannot
        // be claimed twice in the same frame.
        clearSuggestion();
        const root = rootRef.current;
        const card = root === null ? null : root.closest('[data-composer-card]');
        const editor = findEditor(card);
        if (editor !== null) {
          window.requestAnimationFrame(() => {
            try {
              editor.focus({ preventScroll: true });
            } catch {
              // Focus is a polish step; the draft is already filled.
            }
          });
        }

        if (!send || session === undefined) return;
        // Enter needs the draft to be committed before the composer's submit
        // reads it. Wait one frame, verify the draft still holds exactly this
        // prediction, then dispatch the same send the Send button uses.
        const submitDraft = (attempt = 0) => {
          if (!mountedRef.current || sessionRef.current !== session) return;
          if (runningRef.current || phaseRef.current !== 'plain') return;
          if (draftRef.current === '') {
            if (attempt < 2) window.setTimeout(() => submitDraft(attempt + 1), 50);
            return;
          }
          if (draftRef.current !== current.text) return;
          if (typeof actions.submit !== 'function') {
            console.debug('next-input: this composer exposes no submit action; accepted without sending');
            return;
          }
          try {
            actions.submit();
          } catch (error) {
            console.error('next-input: the composer refused the predicted send', error);
          }
        };
        window.requestAnimationFrame(() => submitDraft(0));
      };

      const generate = async () => {
        if (!mountedRef.current) return;
        if (draftRef.current !== '' || runningRef.current || phaseRef.current !== 'plain') return;
        const sessions = ctx.get('sessions');
        const session = sessionRef.current;
        if (sessions === undefined || sessions === null || session === undefined || session === null) return;

        const conversation = readConversation(sessions, session, maxRef.current);
        const selection = readSelection(sessions, session);
        const last = conversation.messages[conversation.messages.length - 1];
        // The event window can trail the running flag by a frame; retry briefly
        // instead of dropping the turn. The attempt budget belongs to one
        // schedule() call, so a lagging window cannot re-arm it forever.
        if (conversation.model === null || last === undefined || last.role !== 'assistant') {
          attemptsRef.current += 1;
          if (attemptsRef.current <= 3) schedule(150);
          return;
        }
        // One answer, one model call per page: remounts and route effects that
        // repeat for the same answer must not spend tokens again.
        const answerId = session + '|' + (conversation.answerKey ?? '');
        const marks = readMarks();
        if (requestedRef.current.has(answerId) || marks.hit === answerId) return;
        requestedRef.current.add(answerId);
        mark({ t0: String(Date.now()), key: answerId });

        const seq = requestSeqRef.current + 1;
        requestSeqRef.current = seq;
        if (abortRef.current !== null) abortRef.current.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        // The Host enforces its own timeout; this bound keeps a stalled carrier
        // from leaving the prediction pending forever.
        const timeout = window.setTimeout(() => controller.abort(), 25000);

        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              provider: conversation.model.provider,
              model: conversation.model.model,
              ...(selection === null ? {} : { selection }),
              sessionId: session,
              answerKey: conversation.answerKey ?? '',
              messages: conversation.messages,
              ...(conversation.toolActivity === undefined || conversation.toolActivity === ''
                ? {}
                : { toolActivity: conversation.toolActivity }),
            }),
            signal: controller.signal,
          });
          if (!response.ok) return;
          const data = await response.json();
          if (!mountedRef.current || seq !== requestSeqRef.current) return;
          if (draftRef.current !== '' || runningRef.current || phaseRef.current !== 'plain') return;
          if (sessionRef.current !== session) return;
          // Any answered call was cached by the Host; a later reload will
          // restore it, so the guard must not block that.
          if (conversation.answerKey !== null) mark({ hit: session + '|' + conversation.answerKey });
          const text = data !== null && data !== undefined && typeof data.suggestion === 'string'
            ? data.suggestion.trim()
            : '';
          if (text === '') return;
          setSuggestion({
            text,
            sessionId: session,
            enterToSend: data.enterToSend === true,
            answerKey: conversation.answerKey,
          });
        } catch (error) {
          if (error === null || error === undefined || error.name !== 'AbortError') {
            console.debug('next-input: no prediction for this turn', error);
          }
        } finally {
          window.clearTimeout(timeout);
          if (abortRef.current === controller) abortRef.current = null;
        }
      };

      const schedule = (delay) => {
        clearTimer();
        attemptsRef.current = 0;
        timerRef.current = window.setTimeout(() => {
          timerRef.current = 0;
          void generate();
        }, delay);
      };

      // Read the Max mode switches once per mount. Packing happens here, so the
      // Host's values have to reach this half; a failed read keeps `null`, and
      // every prediction falls back to the 0.5.x packing.
      React.useEffect(() => {
        let cancelled = false;
        void (async () => {
          try {
            const response = await fetch(SETTINGS_ROUTE);
            const data = await response.json().catch(() => null);
            if (cancelled || data === null || data.values === undefined || data.values === null) return;
            maxRef.current = {
              maxMode: data.values.maxMode === true,
              smartPack: data.values.smartPack === true,
              includeToolActivity: data.values.includeToolActivity === true,
              maxContextChars: data.values.maxContextChars,
              maxMessages: data.values.maxMessages,
            };
          } catch {
            // Keep the fallback packing.
          }
        })();
        return () => {
          cancelled = true;
        };
      }, []);

      // A completed turn is the trigger. New turns and Session switches cancel
      // work; a non-empty draft means the user already knows what to type.
      React.useEffect(() => {
        const previous = previousRef.current;
        previousRef.current = { sessionId, running };

        if (previous.sessionId !== sessionId) {
          // The Host owns the cache; reset only the lookup bookkeeping for the
          // new Session. The restore effect below asks the Host for its entry.
          restoreRetryRef.current = 0;
          lookupRef.current = null;
          lookupInFlightRef.current = null;
          cancelPending();
          clearSuggestion();
          return;
        }
        if (running) {
          cancelPending();
          clearSuggestion();
          restoreRetryRef.current = 0;
          return;
        }
        if (previous.running && draftRef.current === '' && phaseRef.current === 'plain') {
          const conversation = readConversation(ctx.get('sessions'), sessionId);
          const answerId = conversation.answerKey === null ? null : sessionId + '|' + conversation.answerKey;
          const marks = readMarks();
          if (answerId !== null && (marks.routed === answerId || marks.hit === answerId)) {
            // Already handled in this page (switch away and back, remount, or a
            // previous activation lookup): the restore effect shows the ghost.
            mark({ routed: answerId });
            return;
          }
          if (answerId !== null) mark({ routed: answerId });
          schedule(SETTLE_DELAY_MS);
        }
      }, [running, sessionId]);

      React.useEffect(() => {
        if (draft !== '' || phase !== 'plain') {
          cancelPending();
          if (suggestionRef.current !== null) clearSuggestion();
        }
      }, [draft, phase]);

      // Ask the Host for a prediction that belongs to this exact assistant
      // answer. The Host cache survives page reloads, port changes, remounts,
      // and multiple tabs; it is the single source of truth.
      React.useEffect(() => {
        if (draft !== '' || phase !== 'plain' || running) return undefined;
        if (suggestionRef.current !== null) return undefined;
        const sessions = ctx.get('sessions');
        const conversation = readConversation(sessions, sessionId);
        if (conversation.answerKey === null) {
          // The event window may still be loading after a Session switch.
          if (restoreRetryRef.current >= 20) return undefined;
          restoreRetryRef.current += 1;
          const timer = window.setTimeout(() => setRestoreTick((value) => value + 1), 150);
          return () => window.clearTimeout(timer);
        }
        restoreRetryRef.current = 0;
        const key = sessionId + '|' + conversation.answerKey;
        if (dismissedRef.current === key) return undefined;
        const marks = readMarks();
        if (marks.hit === key && marks.tab === key) {
          // Accepted after a prediction in this page: the Host holds the
          // dismissal tombstone, so there is nothing to restore or generate.
          return undefined;
        }
        // A prediction that started in the previous page cannot be back-filled:
        // the Host finishes it and caches it before its client gives up ~25s in.
        const startedAt = marks.key === key ? Number(marks.t0) : NaN;
        if (Number.isFinite(startedAt) && Date.now() - startedAt < RELOAD_GUARD_MS) return undefined;
        if (lookupRef.current === key || lookupInFlightRef.current === key) return undefined;
        // The turn-end path already schedules or runs a prediction; do not
        // duplicate it with an activation lookup.
        if (timerRef.current !== 0 || abortRef.current !== null) return undefined;
        lookupInFlightRef.current = key;
        const controller = new AbortController();
        let cancelled = false;
        const query = new URLSearchParams({ sessionId, answerKey: conversation.answerKey });
        void (async () => {
          try {
            const response = await fetch(CACHE_ROUTE + '?' + query.toString(), { signal: controller.signal });
            const data = await response.json().catch(() => null);
            if (cancelled || sessionRef.current !== sessionId) return;
            if (draftRef.current !== '' || phaseRef.current !== 'plain' || runningRef.current) return;
            lookupRef.current = key;
            if (data !== null && typeof data.suggestion === 'string' && data.suggestion !== '') {
              setSuggestion({
                text: data.suggestion,
                sessionId,
                enterToSend: data.enterToSend === true,
                answerKey: conversation.answerKey,
              });
              return;
            }
            if (data !== null && data.dismissed === true) return;
            if (data !== null && data.predictOnActivate === true) {
              mark({ routed: key });
              schedule(50);
            }
          } catch (error) {
            if (error === null || error === undefined || error.name !== 'AbortError') {
              console.debug('next-input: cache lookup failed', error);
            }
          } finally {
            if (lookupInFlightRef.current === key) lookupInFlightRef.current = null;
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
          if (lookupInFlightRef.current === key) lookupInFlightRef.current = null;
        };
      }, [sessionId, draft, phase, running, restoreTick]);

      React.useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          cancelPending();
        };
      }, [sessionId]);

      // Tab — and, when configured, Enter — are captured on the document and
      // claimed only while the ghost is visible inside this Session's composer.
      // Once accepted, the ghost is gone and the keys resume their normal jobs.
      React.useEffect(() => {
        const onKeyDown = (event) => {
          const current = suggestionRef.current;
          if (current === null) return;
          const root = rootRef.current;
          const card = root === null ? null : root.closest('[data-composer-card]');
          const editor = findEditor(card);
          // Only handle keys while the caret is actually in the editor; a
          // focused toolbar/dialog keeps its own Escape and Tab behavior.
          if (card === null || editor === null || !editor.contains(event.target)) return;
          if (event.key === 'Escape') {
            // Dismiss without claiming the key; the composer and shortcuts keep
            // their own Escape behavior.
            cancelPending();
            dismissPrediction(sessionRef.current, current.answerKey);
            clearSuggestion();
            return;
          }
          if (draftRef.current !== '' || phaseRef.current !== 'plain' || runningRef.current) return;
          if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
          if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
          const isTab = event.key === 'Tab';
          const isEnter = event.key === 'Enter' && current.enterToSend === true;
          if (!isTab && !isEnter) return;
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
          accept(isEnter);
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, []);

      // Keep the ghost on the editor's first line. The draft is empty whenever
      // the ghost is visible, so the caret is the editor's text origin. After a
      // Session switch or a Host-cache restore the composer may still be
      // mounting, so retry until a connected, laid-out editor exists.
      React.useLayoutEffect(() => {
        if (suggestion === null || suggestion.sessionId !== sessionId || draft !== '' || phase !== 'plain') {
          setBox(null);
          return undefined;
        }

        let disposed = false;
        let frame = 0;
        let scrollFrame = 0;
        let attempts = 0;
        let card = null;
        let editor = null;
        let scrollEl = null;
        let observer = null;
        let mutation = null;
        let resizeAttached = false;

        const stopObservers = () => {
          if (observer !== null) {
            observer.disconnect();
            observer = null;
          }
          if (mutation !== null) {
            mutation.disconnect();
            mutation = null;
          }
          if (scrollEl !== null) {
            scrollEl.removeEventListener('scroll', onScroll);
            scrollEl = null;
          }
          if (scrollFrame !== 0) {
            window.cancelAnimationFrame(scrollFrame);
            scrollFrame = 0;
          }
          if (resizeAttached) {
            window.removeEventListener('resize', measure);
            resizeAttached = false;
          }
        };

        // The ghost is painted in the card's overlay, outside the scrollport that
        // owns its room, so a scrollport that widens (scrollbar, sidebar, zoom)
        // or scrolls has to move the clip box with it.
        const onScroll = () => {
          if (scrollFrame !== 0) return;
          scrollFrame = window.requestAnimationFrame(() => {
            scrollFrame = 0;
            measure();
          });
        };

        const measure = () => {
          if (disposed || card === null || editor === null) return;
          const cardRect = card.getBoundingClientRect();
          const editorRect = editor.getBoundingClientRect();
          // A hidden or detached composer must never produce a ghost position;
          // it also must not suppress the placeholder through CSS.
          if (!card.isConnected || !editor.isConnected
            || cardRect.width <= 0 || editorRect.width <= 0) {
            setBox(null);
            if (!disposed && attempts <= 300) {
              attempts += 1;
              stopObservers();
              frame = window.requestAnimationFrame(attach);
            }
            return;
          }
          attempts = 0;
          const style = window.getComputedStyle(editor);
          const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
          const paddingRight = Number.parseFloat(style.paddingRight) || 0;
          const paddingTop = Number.parseFloat(style.paddingTop) || 0;
          // The placeholder sits exactly at the empty editor's text origin and
          // keeps a real box even when the editor root itself is temporarily
          // collapsed during a layout transition.
          const placeholder = card.querySelector('[data-composer-placeholder]');
          const usePlaceholder = placeholder !== null && placeholder.isConnected;
          const targetRect = usePlaceholder ? placeholder.getBoundingClientRect() : editorRect;
          if (targetRect.width <= 0 || targetRect.height <= 0) {
            setBox(null);
            return;
          }
          const width = usePlaceholder
            ? Math.max(48, targetRect.width)
            : Math.max(48, editorRect.width - paddingLeft - paddingRight);
          // The scrollport is the ghost's clip box: the prediction may be taller
          // than the composer's height cap, and everything below that cap has to
          // scroll inside the box instead of painting over the tool row.
          const scrollRect = scrollEl === null ? null : scrollEl.getBoundingClientRect();
          const scroll = scrollRect === null || scrollRect.height <= 0 ? null : {
            left: scrollRect.left - cardRect.left,
            top: scrollRect.top - cardRect.top,
            width: scrollRect.width,
            height: scrollRect.height,
          };
          const next = {
            left: targetRect.left - cardRect.left + (usePlaceholder ? 0 : paddingLeft),
            top: targetRect.top - cardRect.top + (usePlaceholder ? 0 : paddingTop),
            width,
            scroll,
            direction: style.direction === 'rtl' ? 'rtl' : 'ltr',
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
          };
          setBox((previous) => (previous !== null
            && previous.left === next.left
            && previous.top === next.top
            && previous.width === next.width
            && sameClip(previous.scroll, next.scroll)
            && previous.direction === next.direction
            && previous.fontFamily === next.fontFamily
            && previous.fontSize === next.fontSize
            && previous.lineHeight === next.lineHeight
            && previous.letterSpacing === next.letterSpacing
            ? previous
            : next));
        };

        const attach = () => {
          if (disposed) return;
          const root = rootRef.current;
          card = root === null ? null : root.closest('[data-composer-card]');
          editor = findEditor(card);
          if (card === null || editor === null || !card.isConnected || !editor.isConnected) {
            attempts += 1;
            if (attempts <= 300) frame = window.requestAnimationFrame(attach);
            return;
          }
          const cardRect = card.getBoundingClientRect();
          const editorRect = editor.getBoundingClientRect();
          if (cardRect.width <= 0 || editorRect.width <= 0) {
            attempts += 1;
            if (attempts <= 300) frame = window.requestAnimationFrame(attach);
            return;
          }
          scrollEl = editor.closest('[data-input-scroll]');
          if (scrollEl !== null) scrollEl.addEventListener('scroll', onScroll, { passive: true });

          measure();
          frame = window.requestAnimationFrame(measure);

          observer = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => measure())
            : null;
          if (observer !== null) {
            observer.observe(card);
            observer.observe(editor);
          }
          mutation = typeof MutationObserver === 'function'
            ? new MutationObserver(() => measure())
            : null;
          if (mutation !== null) {
            mutation.observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['class', 'style', 'data-theme'],
            });
            if (document.body !== null) {
              mutation.observe(document.body, {
                attributes: true,
                attributeFilter: ['class', 'style'],
              });
            }
          }
          window.addEventListener('resize', measure);
          resizeAttached = true;
        };

        attach();
        return () => {
          disposed = true;
          if (frame !== 0) window.cancelAnimationFrame(frame);
          stopObservers();
        };
      }, [suggestion, draft, phase, sessionId, localeNow]);

      // Hide the placeholder only after the ghost is actually positioned, and
      // only when this build still exposes the marker. If the composer changes,
      // leave its placeholder alone instead of blanking an empty input.
      React.useLayoutEffect(() => {
        if (suggestion === null || suggestion.sessionId !== sessionId || box === null || draft !== '' || phase !== 'plain') return undefined;
        const root = rootRef.current;
        const card = root === null ? null : root.closest('[data-composer-card]');
        if (card === null || card.querySelector('[data-composer-placeholder]') === null) return undefined;
        card.setAttribute(GHOST_ATTR, '');
        return () => card.removeAttribute(GHOST_ATTR);
      }, [suggestion, box, draft, phase, sessionId]);

      // A wrapped prediction must not cover the tool row: let the composer grow
      // under it like it grows under a typed draft. The room is reserved on the
      // element that wraps the editor, so the scrollport grows with it and the
      // card's own layout hooks follow. Past the composer's height cap the
      // scrollport stops growing and clips, and the ghost is painted inside that
      // clip box (see `ghost` below), so a long prediction scrolls in the box
      // instead of painting over the tool row and the status line.
      React.useLayoutEffect(() => {
        if (suggestion === null || suggestion.sessionId !== sessionId || box === null
          || draft !== '' || phase !== 'plain') {
          return undefined;
        }
        const root = rootRef.current;
        const card = root === null ? null : root.closest('[data-composer-card]');
        const ghost = root === null ? null : root.querySelector('[data-dsh-next-input-ghost]');
        const editor = findEditor(card);
        if (card === null || ghost === null || editor === null) return undefined;
        const scrollport = editor.closest('[data-input-scroll]');
        // The scrollport's content wrapper is the element whose height becomes
        // the composer's height; growing it is what a typed draft does.
        const host = (scrollport === null ? null : scrollport.firstElementChild)
          ?? (editor.parentElement === null ? editor : editor.parentElement);

        let applied = 0;
        let frame = 0;
        let timer = 0;
        const clear = () => {
          if (applied === 0) return;
          applied = 0;
          host.style.removeProperty('min-height');
          if (host.style.length === 0) host.removeAttribute('style');
        };
        const measure = () => {
          frame = 0;
          if (!host.isConnected || !editor.isConnected) {
            clear();
            return;
          }
          // Everything from the ghost's text origin down to its last line has to
          // fit in the flow; the first line already sits in the empty composer.
          // The anchor is measured against the flow wrapper, so both move with
          // the scroll content and scrolling never changes the reservation.
          const hostTop = host.getBoundingClientRect().top;
          const placeholder = card.querySelector('[data-composer-placeholder]');
          const base = placeholder !== null && placeholder.isConnected
            ? placeholder.getBoundingClientRect().top - hostTop
            : editor.getBoundingClientRect().top - hostTop
              + (Number.parseFloat(window.getComputedStyle(editor).paddingTop) || 0);
          const next = Math.ceil(base + ghost.getBoundingClientRect().height);
          if (next === applied) return;
          clear();
          if (next <= 0) return;
          applied = next;
          host.style.setProperty('min-height', next + 'px');
        };
        // Growing the wrapper may wrap the ghost differently (fonts, sidebar,
        // zoom, scrollbar): keep re-measuring until it settles. The first pass
        // runs before paint so the ghost never shows a frame over the tool row.
        const schedule = () => {
          if (frame !== 0) window.cancelAnimationFrame(frame);
          frame = window.requestAnimationFrame(measure);
        };
        measure();
        timer = window.setInterval(schedule, 250);
        return () => {
          window.clearInterval(timer);
          if (frame !== 0) window.cancelAnimationFrame(frame);
          clear();
        };
      }, [suggestion, box, draft, phase, sessionId]);

      React.useEffect(() => {
        if (suggestion === null || suggestion.sessionId !== sessionId
          || box !== null || draft !== '' || phase !== 'plain') {
          setFallbackReady(false);
          return undefined;
        }
        setFallbackReady(false);
        const timer = window.setTimeout(() => setFallbackReady(true), 600);
        return () => window.clearTimeout(timer);
      }, [suggestion, box, draft, phase, sessionId]);

      // The ghost is painted inside the scrollport's clip box, so a prediction
      // taller than the composer's height cap is cut at the box edge and scrolls
      // with the editor rather than painting over the tool row. The box sits in
      // the card's overlay, which keeps the ghost out of the editor's own layout.
      const showing = suggestion !== null && suggestion.sessionId === sessionId
        && box !== null && draft === '' && phase === 'plain';
      const clip = showing && box.scroll !== null && box.scroll.height > 0
        ? { left: box.scroll.left, top: box.scroll.top, width: box.scroll.width, height: box.scroll.height }
        : null;

      const ghost = showing
        ? h('div', {
          'data-dsh-next-input-ghost': '',
          'aria-hidden': 'true',
          title: suggestion.enterToSend === true ? t('hintEnter') : t('hint'),
          style: {
            position: 'absolute',
            left: clip === null ? box.left : box.left - clip.left,
            top: clip === null ? box.top : box.top - clip.top,
            width: box.width,
            maxWidth: box.width,
            // A prediction longer than one line wraps inside the composer
            // width, like typed text; the first line keeps `box.top`, and the
            // effect above reserves the wrapped height on the composer so the
            // card grows and the tool row moves down instead of being covered.
            // The key hints are inline after the text, so they follow its last
            // line rather than starting a flex line of their own.
            boxSizing: 'border-box',
            direction: box.direction,
            textAlign: box.direction === 'rtl' ? 'right' : 'left',
            fontFamily: box.fontFamily,
            fontSize: box.fontSize,
            lineHeight: box.lineHeight,
            letterSpacing: box.letterSpacing,
            color: 'var(--dsw-alias-label-secondary)',
            opacity: 0.8,
            overflow: 'hidden',
            pointerEvents: 'none',
            zIndex: 5,
          },
        },
        h('span', {
          key: 'text',
          style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
        }, suggestion.text),
        h('kbd', {
          key: 'tab',
          style: {
            display: 'inline-block',
            marginLeft: 6,
            padding: '0 4px',
            border: '0.5px solid var(--dsw-alias-border-l1)',
            borderRadius: 4,
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-secondary)',
            fontFamily: 'inherit',
            fontSize: 10,
            lineHeight: '16px',
            verticalAlign: 1,
          },
        }, t('tab')),
        suggestion.enterToSend === true ? h('span', {
          key: 'enter',
          style: {
            marginLeft: 4,
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 10,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          },
        }, t('enterSend')) : null)
        : null;

      const announce = suggestion !== null && suggestion.sessionId === sessionId
        ? (suggestion.enterToSend === true ? t('announceEnter') : t('announce'))
        : '';
      // Safety net for a composer whose editor cannot be measured (for example
      // after an internal DOM change): show the prediction above the card so
      // Tab still has a visible target.
      const fallback = fallbackReady && suggestion !== null && suggestion.sessionId === sessionId
        && draft === '' && phase === 'plain' && box === null
        ? h('div', {
          'data-dsh-next-input-fallback': '',
          'aria-hidden': 'true',
          title: suggestion.enterToSend === true ? t('hintEnter') : t('hint'),
          style: {
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 8,
            maxWidth: 'calc(100% - 16px)',
            padding: '4px 8px',
            border: '0.5px solid var(--dsw-alias-border-l1)',
            borderRadius: 8,
            background: 'var(--dsw-alias-bg-overlay)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 11,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            pointerEvents: 'none',
            zIndex: 6,
          },
        }, t('fallback') + ': ' + suggestion.text)
        : null;

      return h('div', {
        ref: rootRef,
        'data-dsh-next-input': '',
        style: {
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 5,
        },
      },
      h('style', { key: 'style' }, CSS),
      clip === null ? ghost : h('div', {
        key: 'clip',
        style: {
          position: 'absolute',
          left: clip.left,
          top: clip.top,
          width: clip.width,
          height: clip.height,
          overflow: 'hidden',
          pointerEvents: 'none',
        },
      }, ghost),
      fallback,
      h('span', {
        key: 'status',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        style: {
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          border: 0,
        },
      }, announce));
      };
    }


    function createSettingsPage(ctx) {
      const PAGE = {
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        maxWidth: 720,
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: '20px',
      };
      const TITLE = { fontSize: 16, lineHeight: '24px', fontWeight: 600 };
      const INTRO = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px', maxWidth: 560 };
      const HEAD = { padding: '6px 0 12px' };
      const SECTION = { display: 'flex', flexDirection: 'column', gap: 2 };
      const SECTION_TITLE = {
        fontSize: 11,
        lineHeight: '16px',
        fontWeight: 600,
        letterSpacing: '.04em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
        paddingBottom: 4,
      };
      const ROW = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '9px 0',
        borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
      };
      // Sub-switches of Max mode read as belonging to the master switch above
      // them, so they are indented and lose their own hairline.
      const SUB_ROW = {
        ...ROW,
        paddingLeft: 16,
        borderBottom: 'none',
      };
      const STACK = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 };
      const LABEL = { fontSize: 13, lineHeight: '20px' };
      const HINT = { fontSize: 11.5, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' };
      const INPUT = {
        boxSizing: 'border-box',
        height: 32,
        padding: '0 8px',
        borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
      };
      const ACTIONS = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        justifyContent: 'flex-start',
        paddingTop: 8,
        marginTop: 2,
        flexWrap: 'wrap',
        // The settings shell already scrolls the content column and owns its
        // horizontal padding, so the bar only needs a hairline and room to
        // breathe; it must not reach for the panel surface it sat on when this
        // page was a tab.
        borderTop: '0.5px solid var(--dsw-alias-border-l1)',
        paddingBottom: 4,
      };
      // Host button metrics: a 36px control that hugs its label with 16px of
      // side padding, so "Save" stays compact instead of stretching to a
      // minimum width.
      const BUTTON = {
        boxSizing: 'border-box',
        height: 36,
        padding: '0 16px',
        borderRadius: 8,
        border: '1px solid transparent',
        fontFamily: 'inherit',
        fontSize: 14,
        lineHeight: '22px',
        fontWeight: 500,
        cursor: 'pointer',
      };
      // `brand-primary` is the text/accent colour in both themes here, so a
      // white label on it disappears in the light theme. The Host's primary
      // button uses the button-primary pair instead: dark fill with a light
      // foreground in the light theme, the inverse in the dark theme.
      const PRIMARY = {
        ...BUTTON,
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
      };
      const COMPACT_PRIMARY = { ...PRIMARY, padding: '0 14px' };
      const PRIMARY_LABEL = { color: 'inherit', whiteSpace: 'nowrap' };
      const SECONDARY = {
        ...BUTTON,
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-primary)',
      };
      const COMPACT_SECONDARY = { ...SECONDARY, padding: '0 12px' };
      const SECONDARY_LABEL = { color: 'inherit', whiteSpace: 'nowrap' };
      const ACTIONS_INLINE = { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6 };
      const USAGE_GRID = {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 8,
        padding: '8px 0 10px',
      };
      const USAGE_CELL = {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '0.5px solid var(--dsw-alias-border-l1)',
      };
      const USAGE_ROUTES = { display: 'flex', flexDirection: 'column', gap: 2 };
      const USAGE_LABEL = { fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' };
      const STATUS = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' };
      const ERROR = { ...STATUS, color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary))' };

      const LABEL_KEYS = {
        maxSuggestionChars: 'maxSuggestionCharsLabel',
        maxContextChars: 'maxContextCharsLabel',
        maxMessages: 'maxMessagesLabel',
        maxTokens: 'maxTokensLabel',
        timeoutMs: 'timeoutLabel',
      };

      // Tab through a settings nav section folds the section into the content
      // column (narrower than the plugin tab's page), so the shared padding
      // lives here instead of in PAGE.
      // The shell scrolls the content column; sticky controls sit on the
      // panel surface. The page padding is symmetric on purpose: with a left
      // padding only, the sticky bar starts where the scrolled content starts
      // and the panel shows through on both sides.
      const column = (children) => React.createElement('div', {
        style: { padding: '18px 0 0', maxWidth: 720, boxSizing: 'border-box' },
      }, React.createElement('div', { style: PAGE }, children));

      function toForm(values) {
        return {
          enterToSend: values !== null && values !== undefined && values.enterToSend === true,
          predictOnActivate: values !== null && values !== undefined && values.predictOnActivate === true,
          predictionProvider: values !== null && values !== undefined && typeof values.predictionProvider === 'string' ? values.predictionProvider : '',
          predictionModel: values !== null && values !== undefined && typeof values.predictionModel === 'string' ? values.predictionModel : '',
          maxSuggestionChars: String(values !== null && values !== undefined ? values.maxSuggestionChars : ''),
          maxContextChars: String(values !== null && values !== undefined ? values.maxContextChars : ''),
          maxMessages: String(values !== null && values !== undefined ? values.maxMessages : ''),
          maxTokens: String(values !== null && values !== undefined ? values.maxTokens : ''),
          timeoutMs: String(values !== null && values !== undefined ? values.timeoutMs : ''),
          maxMode: values !== null && values !== undefined && values.maxMode === true,
          includeToolActivity: values !== null && values !== undefined && values.includeToolActivity === true,
          smartPack: values !== null && values !== undefined && values.smartPack === true,
          allowMultiline: values !== null && values !== undefined && values.allowMultiline === true,
          reasoningEffort: values !== null && values !== undefined && typeof values.reasoningEffort === 'string' ? values.reasoningEffort : 'model',
          retryOnFailure: values !== null && values !== undefined && values.retryOnFailure === true,
          predictOnEndOnly: values !== null && values !== undefined && values.predictOnEndOnly === true,
          promptVariant: values !== null && values !== undefined && typeof values.promptVariant === 'string' ? values.promptVariant : 'next',
        };
      }

      return function NextInputSettings() {
        React.useSyncExternalStore(
          React.useCallback((notify) => subscribeLocale(ctx, notify), []),
          () => localeRevision(ctx),
          () => 0,
        );
        const t = (key) => translate(ctx, key);

        const [form, setForm] = React.useState(null);
        const [providers, setProviders] = React.useState([]);
        const [loading, setLoading] = React.useState(true);
        const [saving, setSaving] = React.useState(false);
        const [editable, setEditable] = React.useState(true);
        const [error, setError] = React.useState('');
        const [saved, setSaved] = React.useState(false);
        const [usage, setUsage] = React.useState(null);

        React.useEffect(() => {
          const controller = new AbortController();
          let cancelled = false;
          void (async () => {
            try {
              const response = await fetch(SETTINGS_ROUTE, { signal: controller.signal });
              const data = await response.json().catch(() => null);
              if (cancelled) return;
              if (!response.ok || data === null) {
                setError(t('loadFailed'));
                setLoading(false);
                return;
              }
              setForm(toForm(data.values));
              setProviders(Array.isArray(data.providers) ? data.providers : []);
              setEditable(data.editable !== false);
              setUsage(data.usage === null || data.usage === undefined ? null : data.usage);
              setLoading(false);
            } catch (failure) {
              if (cancelled || (failure !== null && failure !== undefined && failure.name === 'AbortError')) return;
              setError(t('loadFailed'));
              setLoading(false);
            }
          })();
          return () => {
            cancelled = true;
            controller.abort();
          };
        }, []);

        const update = (key, value) => {
          setForm((previous) => (previous === null ? previous : { ...previous, [key]: value }));
          setSaved(false);
          setError('');
        };

        const errorText = (data) => {
          if (data !== null && data !== undefined && data.error === 'prediction_route_incomplete') {
            return t('providerPair');
          }
          if (data !== null && data !== undefined && data.error === 'out_of_range'
            && typeof data.field === 'string' && SETTINGS_LIMITS[data.field] !== undefined) {
            const range = SETTINGS_LIMITS[data.field];
            const label = LABEL_KEYS[data.field] === undefined ? data.field : t(LABEL_KEYS[data.field]);
            return label + ': ' + t('invalidNumber')
              .replace('{min}', String(range[0]))
              .replace('{max}', String(range[1]));
          }
          return t('saveFailed');
        };

        const save = async () => {
          if (form === null) return;
          const values = {};
          for (const key of Object.keys(SETTINGS_LIMITS)) {
            const range = SETTINGS_LIMITS[key];
            const number = Number(form[key]);
            if (!Number.isInteger(number) || number < range[0] || number > range[1]) {
              setError(t(LABEL_KEYS[key]) + ': ' + t('invalidNumber')
                .replace('{min}', String(range[0]))
                .replace('{max}', String(range[1])));
              return;
            }
            values[key] = number;
          }
          const provider = form.predictionProvider.trim();
          const model = form.predictionModel.trim();
          if ((provider === '') !== (model === '')) {
            setError(t('providerPair'));
            return;
          }
          values.enterToSend = form.enterToSend === true;
          values.predictOnActivate = form.predictOnActivate === true;
          values.predictionProvider = provider;
          values.predictionModel = model;
          // Max mode is saved even while it is off, so each sub-switch keeps
          // the choice the user made for the next time the master switch is on.
          values.maxMode = form.maxMode === true;
          values.includeToolActivity = form.includeToolActivity === true;
          values.smartPack = form.smartPack === true;
          values.allowMultiline = form.allowMultiline === true;
          values.reasoningEffort = form.reasoningEffort;
          values.retryOnFailure = form.retryOnFailure === true;
          values.predictOnEndOnly = form.predictOnEndOnly === true;
          values.promptVariant = form.promptVariant;
          setSaving(true);
          setError('');
          setSaved(false);
          try {
            const response = await fetch(SETTINGS_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ values }),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || data === null) {
              setError(errorText(data));
              return;
            }
            setForm(toForm(data.values));
            setSaved(true);
          } catch {
            setError(t('saveFailed'));
          } finally {
            setSaving(false);
          }
        };

        const reset = async () => {
          setSaving(true);
          setError('');
          setSaved(false);
          try {
            const response = await fetch(SETTINGS_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ reset: true }),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || data === null) {
              setError(t('saveFailed'));
              return;
            }
            setForm(toForm(data.values));
            setSaved(true);
          } catch {
            setError(t('saveFailed'));
          } finally {
            setSaving(false);
          }
        };

        const resetUsage = async () => {
          setSaving(true);
          setError('');
          try {
            const response = await fetch(SETTINGS_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ resetUsage: true }),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || data === null) {
              setError(t('saveFailed'));
              return;
            }
            setUsage(data.usage === null || data.usage === undefined ? null : data.usage);
          } catch {
            setError(t('saveFailed'));
          } finally {
            setSaving(false);
          }
        };

        const formatNumber = (value) => (typeof value === 'number' && Number.isFinite(value)
          ? value.toLocaleString()
          : '0');
        const formatSeconds = (value) => (typeof value === 'number' && Number.isFinite(value)
          ? (value / 1000).toFixed(1) + 's'
          : '0s');

        const usageSection = () => {
          if (usage === null) return null;
          const calls = typeof usage.calls === 'number' ? usage.calls : 0;
          const totalTokens = typeof usage.totalTokens === 'number' ? usage.totalTokens : 0;
          const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
          const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
          const cacheReadTokens = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
          const answered = typeof usage.answered === 'number' ? usage.answered : 0;
          const duplicate = typeof usage.duplicate === 'number' ? usage.duplicate : 0;
          const withoutUsage = typeof usage.withoutUsage === 'number' ? usage.withoutUsage : 0;
          const averageMs = calls === 0 ? 0 : (typeof usage.ms === 'number' ? usage.ms : 0) / calls;
          const averageTokens = calls === 0 ? 0 : totalTokens / calls;
          const value = (label, text) => React.createElement('div', { style: USAGE_CELL },
            React.createElement('div', { style: USAGE_LABEL }, label),
            React.createElement('div', { style: LABEL }, text));
          return section(t('sectionUsage'), [
            React.createElement('div', { style: USAGE_GRID },
              value(t('usageCalls'), formatNumber(calls)),
              value(t('usageTokens'), formatNumber(totalTokens)),
              value(t('usageAverage'), formatNumber(Math.round(averageTokens)) + ' · ' + formatSeconds(averageMs))),
            React.createElement('div', { style: USAGE_GRID },
              value(t('usageInput'), formatNumber(inputTokens)),
              value(t('usageOutput'), formatNumber(outputTokens)),
              value(t('usageCacheRead'), formatNumber(cacheReadTokens))),
            React.createElement('div', { style: HINT },
              t('usageServed')
                .replace('{answered}', formatNumber(answered))
                .replace('{duplicate}', formatNumber(duplicate))
                + (withoutUsage > 0 ? ' ' + t('usageNoReport').replace('{count}', formatNumber(withoutUsage)) : '')),
            ...(Array.isArray(usage.byRoute) && usage.byRoute.length > 0
              ? [React.createElement('div', { key: 'routes', style: USAGE_ROUTES },
                usage.byRoute.map((entry) => React.createElement('span', { key: entry.id, style: HINT },
                  (entry.id === undefined || entry.id === null ? '' : String(entry.id))
                    + ' · ' + formatNumber(entry.calls)
                    + ' · ' + formatNumber(entry.totalTokens) + ' ' + t('usageTokens'))))]
              : []),
            React.createElement('div', { style: HINT }, t('usageScope')),
            React.createElement('div', { style: ACTIONS_INLINE },
              React.createElement('button', {
                type: 'button',
                disabled: saving,
                onClick: resetUsage,
                'aria-label': t('usageReset'),
                style: saving ? { ...SECONDARY, opacity: 0.6, cursor: 'default' } : SECONDARY,
              }, React.createElement('span', { style: SECONDARY_LABEL }, t('usageReset')))),
          ]);
        };

        const toggle = (label, checked, onToggle, locked) => React.createElement('button', {
          type: 'button',
          role: 'switch',
          'aria-label': label,
          'aria-checked': checked === true,
          disabled: saving || locked === true,
          onClick: () => onToggle(checked !== true),
          style: {
            flex: 'none',
            boxSizing: 'border-box',
            width: 36,
            height: 20,
            padding: 2,
            borderRadius: 999,
            border: '0.5px solid var(--dsw-alias-border-l1)',
            background: checked === true ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
            boxShadow: 'inset 0 0 0 0.5px var(--dsw-alias-border-l1)',
            transition: 'background 120ms ease',
            cursor: saving || locked === true ? 'default' : 'pointer',
            opacity: saving || locked === true ? 0.6 : 1,
          },
        }, React.createElement('span', {
          style: {
            display: 'block',
            width: 16,
            height: 16,
            boxSizing: 'border-box',
            borderRadius: 999,
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '0.5px solid var(--dsw-alias-border-l2)',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.12)',
            transform: checked === true ? 'translateX(16px)' : 'none',
            transition: 'transform 120ms ease',
          },
        }));

        const switchRow = (label, hint, checked, onToggle, rowStyle, locked) => React.createElement('div', { style: rowStyle === undefined ? ROW : rowStyle },
          React.createElement('div', { style: STACK },
            React.createElement('div', { style: LABEL }, label),
            hint === '' ? null : React.createElement('div', { style: HINT }, hint),
          ),
          toggle(label, checked, onToggle, locked),
        );

        const inputRow = (label, hint, key, numeric, width, rowStyle, locked) => React.createElement('div', { style: rowStyle === undefined ? ROW : rowStyle },
          React.createElement('div', { style: STACK },
            React.createElement('div', { style: LABEL }, label),
            hint === '' ? null : React.createElement('div', { style: HINT }, hint),
          ),
          React.createElement('input', {
            type: numeric ? 'number' : 'text',
            inputMode: numeric ? 'numeric' : undefined,
            min: numeric ? SETTINGS_LIMITS[key][0] : undefined,
            max: numeric ? SETTINGS_LIMITS[key][1] : undefined,
            step: numeric ? 1 : undefined,
            value: form[key],
            'aria-label': label,
            disabled: saving || locked === true,
            spellCheck: false,
            onChange: (event) => update(key, event.target.value),
            style: {
              ...INPUT,
              width: width === undefined ? 160 : width,
              opacity: locked === true ? 0.6 : 1,
            },
          }),
        );

        const selectRow = (label, hint, value, options, onChange, disabled, width) => React.createElement('div', { style: ROW },
          React.createElement('div', { style: STACK },
            React.createElement('div', { style: LABEL }, label),
            hint === '' ? null : React.createElement('div', { style: HINT }, hint),
          ),
          React.createElement('select', {
            value,
            'aria-label': label,
            disabled: saving || disabled,
            onChange: (event) => onChange(event.target.value),
            style: { ...INPUT, width: width === undefined ? 220 : width, padding: '0 6px' },
          }, options),
        );

        const section = (title, rows) => React.createElement('div', { style: SECTION },
          React.createElement('div', { style: SECTION_TITLE }, title),
          rows,
        );

        const enumRow = (label, hint, key, values, labels) => React.createElement('div', { style: SUB_ROW },
          React.createElement('div', { style: STACK },
            React.createElement('div', { style: LABEL }, label),
            hint === '' ? null : React.createElement('div', { style: HINT }, hint),
          ),
          React.createElement('select', {
            value: form[key],
            'aria-label': label,
            disabled: saving || form.maxMode !== true,
            onChange: (event) => update(key, event.target.value),
            style: {
              ...INPUT,
              width: 160,
              padding: '0 6px',
              opacity: form.maxMode === true ? 1 : 0.6,
            },
          }, values.map((value) => React.createElement('option', {
            key: value,
            value,
          }, labels[value]))),
        );

        const subSwitch = (labelKey, hintKey, key) => switchRow(
          t(labelKey),
          t(hintKey),
          form[key] === true,
          (value) => update(key, value),
          SUB_ROW,
          form.maxMode !== true,
        );

        // Every sub-switch below is implemented and read by the Host; the
        // master switch only gates them, so while it is off each one stores the
        // choice without changing a prediction. Each budget also shows the
        // range the Host accepts, which a number input cannot display on its own.
        const budgetRow = (labelKey, key) => {
          const [min, max] = SETTINGS_LIMITS[key];
          return inputRow(
            t(labelKey),
            t('maxModeRangeHint') + ' ' + min + '–' + max,
            key,
            true,
            undefined,
            SUB_ROW,
            form.maxMode !== true,
          );
        };

        const maxModeSection = () => section(t('sectionMax'), [
          switchRow(t('maxModeLabel'), t('maxModeHint'), form.maxMode, (value) => update('maxMode', value)),
          subSwitch('includeToolActivityLabel', 'includeToolActivityHint', 'includeToolActivity'),
          subSwitch('smartPackLabel', 'smartPackHint', 'smartPack'),
          subSwitch('allowMultilineLabel', 'allowMultilineHint', 'allowMultiline'),
          enumRow(t('reasoningEffortLabel'), t('reasoningEffortHint'), 'reasoningEffort',
            ['model', 'low', 'medium', 'high'], {
              model: t('effortModel'),
              low: t('effortLow'),
              medium: t('effortMedium'),
              high: t('effortHigh'),
            }),
          subSwitch('retryOnFailureLabel', 'retryOnFailureHint', 'retryOnFailure'),
          subSwitch('predictOnEndOnlyLabel', 'predictOnEndOnlyHint', 'predictOnEndOnly'),
          enumRow(t('promptVariantLabel'), t('promptVariantHint'), 'promptVariant',
            ['legacy', 'next'], {
              legacy: t('variantLegacy'),
              next: t('variantNext'),
            }),
          React.createElement('div', { style: HINT }, t('maxModeBudgets')),
          budgetRow('maxTokensLabel', 'maxTokens'),
          budgetRow('maxContextCharsLabel', 'maxContextChars'),
          budgetRow('maxMessagesLabel', 'maxMessages'),
          budgetRow('maxSuggestionCharsLabel', 'maxSuggestionChars'),
          React.createElement('div', { style: HINT }, t('maxModeInert')),
        ]);

        if (loading) {
          return column([
            React.createElement('div', { style: STATUS }, t('loading')),
          ]);
        }
        if (form === null) {
          return column([
            React.createElement('div', { style: ERROR }, error === '' ? t('loadFailed') : error),
          ]);
        }
        if (!editable) {
          return column([
            React.createElement('div', { style: HEAD },
              React.createElement('div', { style: TITLE }, t('settingsTitle')),
              React.createElement('div', { style: INTRO }, t('settingsIntro')),
            ),
            React.createElement('div', { style: ERROR }, t('readOnly')),
          ]);
        }

        const providerEntry = providers.find((entry) => entry.id === form.predictionProvider);
        const models = providerEntry !== undefined && Array.isArray(providerEntry.models) ? providerEntry.models : [];
        const providerOptions = [
          React.createElement('option', { key: 'auto', value: '' }, t('automaticRoute')),
          ...providers.map((entry) => React.createElement('option', {
            key: 'provider-' + entry.id,
            value: entry.id,
          }, entry.name === undefined || entry.name === null ? entry.id : entry.name)),
          ...(form.predictionProvider !== '' && !providers.some((entry) => entry.id === form.predictionProvider)
            ? [React.createElement('option', {
              key: 'provider-current',
              value: form.predictionProvider,
            }, form.predictionProvider + ' (unavailable)')]
            : []),
        ];
        const modelOptions = [
          React.createElement('option', {
            key: 'model-empty',
            value: '',
            disabled: form.predictionProvider !== '',
          },
          form.predictionProvider === ''
            ? t('automaticRoute')
            : (models.length === 0 ? t('noModels') : t('selectModel'))),
          ...models.map((entry) => React.createElement('option', {
            key: 'model-' + entry.id,
            value: entry.id,
          }, entry.name === undefined || entry.name === null ? entry.id : entry.name)),
          ...(form.predictionModel !== '' && !models.some((entry) => entry.id === form.predictionModel)
            ? [React.createElement('option', {
              key: 'model-current',
              value: form.predictionModel,
            }, form.predictionModel + ' (unavailable)')]
            : []),
        ];
        const changeProvider = (value) => {
          // "Follow the conversation's model" clears both fields, so the Host
          // reports `source: session` and never treats a stale model as pinned.
          const entry = providers.find((provider) => provider.id === value);
          setForm((previous) => (previous === null ? previous : {
            ...previous,
            predictionProvider: value,
            predictionModel: value === ''
              ? ''
              : (entry === undefined || !Array.isArray(entry.models) || entry.models[0] === undefined
                ? ''
                : entry.models[0].id),
          }));
          setSaved(false);
          setError('');
        };

        return column([
          React.createElement('div', { style: HEAD },
            React.createElement('div', { style: TITLE }, t('settingsTitle')),
            React.createElement('div', { style: INTRO }, t('settingsIntro')),
          ),
          section(t('sectionPrediction'), [
            switchRow(t('enterToSendLabel'), t('enterToSendHint'), form.enterToSend, (value) => update('enterToSend', value)),
            switchRow(t('predictOnActivateLabel'), t('predictOnActivateHint'), form.predictOnActivate, (value) => update('predictOnActivate', value)),
          ]),
          section(t('sectionModel'), [
            selectRow(t('predictionProviderLabel'), t('predictionProviderHint'), form.predictionProvider, providerOptions, changeProvider, false, 220),
            selectRow(
              t('predictionModelLabel'),
              form.predictionProvider === ''
                ? t('predictionProviderHint')
                : (models.length === 0 ? t('noModels') : t('predictionModelHint')),
              form.predictionModel,
              modelOptions,
              (value) => update('predictionModel', value),
              form.predictionProvider === '' || models.length === 0,
              220,
            ),
            inputRow(t('timeoutLabel'), '', 'timeoutMs', true),
          ]),
          maxModeSection(),
          usageSection(),
          React.createElement('div', { style: ACTIONS },
            React.createElement('button', {
              type: 'button',
              disabled: saving,
              onClick: save,
              'aria-label': saving ? t('saving') : t('save'),
              style: saving ? { ...COMPACT_PRIMARY, opacity: 0.6, cursor: 'default' } : COMPACT_PRIMARY,
            }, saving ? React.createElement('span', { style: PRIMARY_LABEL }, t('saving')) : React.createElement('span', { style: PRIMARY_LABEL }, t('save'))),
            React.createElement('button', {
              type: 'button',
              disabled: saving,
              onClick: reset,
              'aria-label': t('reset'),
              style: saving ? { ...COMPACT_SECONDARY, opacity: 0.6, cursor: 'default' } : COMPACT_SECONDARY,
            }, React.createElement('span', { style: SECONDARY_LABEL }, t('reset'))),
            saved ? React.createElement('span', { style: STATUS, role: 'status' }, t('saved')) : null,
            error !== '' ? React.createElement('span', { role: 'alert', style: ERROR }, error) : null,
          ),
        ]);
      };
    }

    // Copy for the DSH locale service. Registered both unconditionally; the
    // built-in English table stays the fallback when the service is absent.
    const zhDictionary = {
        tab: 'Tab',
        hint: '按 Tab 采纳这则预测',
        enterSend: 'Enter 发送',
        hintEnter: '按 Tab 采纳，Enter 采纳并发送',
        fallback: '预测',
        announce: '有可用的下一步输入预测，按 Tab 采纳。',
        announceEnter: '有可用的下一步输入预测，按 Tab 采纳，或按 Enter 采纳并发送。',
        settingsNav: '下一步输入',
        settingsTitle: '下一步输入',
        settingsIntro: '每次回答结束后预测你的下一句话，以浅色文字预填在输入框内，按 Tab 采纳。修改会应用到下一次预测。',
        sectionPrediction: '预测',
        sectionModel: '模型与延迟',
        sectionUsage: '用量（本次 Host 运行）',
        sectionMax: 'Max 模式',
        maxModeLabel: '启用 Max 模式',
        maxModeHint: '对标 Codex 预测的改进，按下面的子项生效。关闭时完全使用当前逻辑，行为不变。',
        maxModeBudgets: '以下四项只在 Max 模式开启时生效；关闭时固定使用 8000 字符 / 24 条 / 512 token / 140 字符。',
        maxModeRangeHint: '可调范围',
        maxModeInert: '这些子项决定预测如何构建；总开关关闭时只保存选择，不生效。',
        includeToolActivityLabel: '带上工具活动',
        includeToolActivityHint: '把这一轮跑过的命令、读写的文件和执行的测试一并送入预测。',
        smartPackLabel: '改进上下文打包',
        smartPackHint: '按字符估算重新分配预算，保证最早那一轮提问不会被挤掉。',
        allowMultilineLabel: '允许多行建议',
        allowMultilineHint: '不再压成单行、不再按 140 字符硬截，多行建议按行边界收尾。',
        reasoningEffortLabel: '推理档位',
        reasoningEffortHint: '“模型默认”不再强制最低档；其余选项指定固定档位。',
        effortModel: '模型默认',
        effortLow: '低',
        effortMedium: '中',
        effortHigh: '高',
        retryOnFailureLabel: '失败后重试',
        retryOnFailureHint: '一次失败后按退避再试一次，整体仍受上面的超时限制。',
        predictOnEndOnlyLabel: '只在回答结束后预测',
        predictOnEndOnlyHint: '忽略“打开会话时预生成”，减少一次模型调用。',
        promptVariantLabel: '预测提示词',
        promptVariantHint: '“新版”要求引用本轮的具体对象，并跟随你平时的写法长度。',
        variantLegacy: '当前版',
        variantNext: '新版',
        usageCalls: '预测调用次数',
        usageTokens: '消耗 token',
        usageAverage: '平均每次',
        usageInput: '输入 token',
        usageOutput: '输出 token',
        usageCacheRead: '命中缓存的输入',
        usageServed: '缓存直接命中 {answered} 次 · 拒绝重复请求 {duplicate} 次',
        usageNoReport: '（{count} 次调用未返回 token 用量）',
        usageScope: '只统计本插件在 Host 进程内存里的计数，DSH 重启后清零；“重置计数”不会改动任何设置。',
        usageReset: '重置计数',
        enterToSendLabel: 'Enter 采纳并发送',
        enterToSendHint: 'Tab 只采纳；普通 Enter 会采纳并发送预测。',
        predictOnActivateLabel: '打开会话时预生成',
        predictOnActivateHint: '当前回答没有缓存时，打开会话会生成一次预测；会多一次模型调用。',
        predictionProviderLabel: '预测 provider',
        predictionProviderHint: '默认跟随当前对话中选中的模型（取不到时用产生最后一条回答的模型）。只有想固定一个更快、专用的模型时才需要选择。',
        predictionModelLabel: '预测 model',
        predictionModelHint: '仅在上一项选了 provider 时生效。',
        maxTokensLabel: '最大输出 token',
        timeoutLabel: '超时（毫秒）',
        maxContextCharsLabel: '最大上下文字符',
        maxMessagesLabel: '最大消息条数',
        maxSuggestionCharsLabel: '最大建议字符',
        save: '保存',
        saving: '保存中…',
        reset: '重置为 profile 默认值',
        saved: '已保存，应用到下一次预测。',
        loadFailed: '无法加载配置。',
        saveFailed: '无法保存配置。',
        loading: '加载中…',
        providerPair: 'provider 和 model 必须同时填写，或同时留空。',
        automaticRoute: '跟随当前对话的模型',
        selectModel: '选择模型',
        noModels: '没有可用模型',
        invalidNumber: '请输入 {min} 到 {max} 之间的整数。',
        readOnly: '当前 profile 不允许编辑配置。',
    };
    
    const enDictionary = {
        tab: 'Tab',
        hint: 'Press Tab to accept this prediction',
        enterSend: 'Enter sends',
        hintEnter: 'Press Tab to accept or Enter to accept and send',
        fallback: 'Prediction',
        announce: 'A next-input prediction is available. Press Tab to accept.',
        announceEnter: 'A next-input prediction is available. Press Tab to accept, or Enter to accept and send.',
        settingsNav: 'Next input',
        settingsTitle: 'Next input',
        settingsIntro: 'Predicts your next message after each answer and offers it as ghost text: press Tab to accept. Changes apply to the next prediction.',
        sectionPrediction: 'Prediction',
        sectionModel: 'Model & latency',
        sectionUsage: 'Usage (this Host session)',
        sectionMax: 'Max mode',
        maxModeLabel: 'Enable Max mode',
        maxModeHint: 'The improvements modelled on Codex predictions, each gated below. While off, predictions use the current logic and behaviour does not change.',
        maxModeBudgets: 'These four apply only while Max mode is on; with it off the prediction uses a fixed 8000 characters / 24 messages / 512 tokens / 140 characters.',
        maxModeRangeHint: 'Range',
        maxModeInert: 'These switches decide how a prediction is built; while the master switch is off they only store the choice.',
        includeToolActivityLabel: 'Include tool activity',
        includeToolActivityHint: 'Send the commands, files and tests this turn touched along with the prediction request.',
        smartPackLabel: 'Improved context packing',
        smartPackHint: 'Rebalance the character budget so the earliest request is never crowded out.',
        allowMultilineLabel: 'Allow multiline suggestions',
        allowMultilineHint: 'Stop collapsing to one line and cutting at 140 characters; trim multiline suggestions on a line boundary.',
        reasoningEffortLabel: 'Reasoning effort',
        reasoningEffortHint: '“Model default” stops forcing the lowest effort; the other options pin a level.',
        effortModel: 'Model default',
        effortLow: 'Low',
        effortMedium: 'Medium',
        effortHigh: 'High',
        retryOnFailureLabel: 'Retry on failure',
        retryOnFailureHint: 'Retry once after a backoff; the timeout above still bounds the whole attempt.',
        predictOnEndOnlyLabel: 'Only predict after an answer',
        predictOnEndOnlyHint: 'Ignore “Predict on session open” and save one model call.',
        promptVariantLabel: 'Prediction prompt',
        promptVariantHint: '“New” asks for specifics from this turn and follows how long your own messages usually are.',
        variantLegacy: 'Current',
        variantNext: 'New',
        usageCalls: 'Prediction calls',
        usageTokens: 'Tokens used',
        usageAverage: 'Avg per call',
        usageInput: 'Input tokens',
        usageOutput: 'Output tokens',
        usageCacheRead: 'Cache-hit input',
        usageServed: '{answered} answers served from the cache · {duplicate} duplicate requests refused',
        usageNoReport: '({count} calls reported no token usage)',
        usageScope: 'Counted by this plugin only, in Host process memory: a DSH restart clears it. Resetting the counters never deletes settings.',
        usageReset: 'Reset counters',
        enterToSendLabel: 'Enter accepts and sends',
        enterToSendHint: 'Tab only accepts; plain Enter accepts and sends the prediction.',
        predictOnActivateLabel: 'Predict on session open',
        predictOnActivateHint: 'When no cached prediction exists, opening a session generates one. Costs one model call.',
        predictionProviderLabel: 'Prediction provider',
        predictionProviderHint: 'Default: follow the model selected in each conversation (falling back to the model that produced the last answer). Pick a route only to pin a dedicated, faster model.',
        predictionModelLabel: 'Prediction model',
        predictionModelHint: 'Only used with a provider picked above.',
        maxTokensLabel: 'Max output tokens',
        timeoutLabel: 'Timeout (ms)',
        maxContextCharsLabel: 'Max context characters',
        maxMessagesLabel: 'Max messages',
        maxSuggestionCharsLabel: 'Max suggestion characters',
        save: 'Save',
        saving: 'Saving…',
        reset: 'Reset to profile defaults',
        saved: 'Saved. Applies to the next prediction.',
        loadFailed: 'Could not load settings.',
        saveFailed: 'Could not save settings.',
        loading: 'Loading…',
        providerPair: 'Set both provider and model, or leave both empty.',
        automaticRoute: 'Follow the conversation’s model',
        selectModel: 'Select a model',
        noModels: 'No models advertised',
        invalidNumber: 'Enter a whole number between {min} and {max}.',
        readOnly: 'Settings are not editable in this profile.',
    };

    const api = {
      // Required for the settings labels: the slot table evaluates a section's
      // `label` outside any render, so the copy must come from a live locale
      // service. Waiting for `slots` only is not enough — `slots` is provided
      // before the locale plugin finishes its async apply.
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Both baseline languages in one call: the service keeps them for the
        // whole page session and switches between them natively. `inject` names
        // `locale`, so the service is there before this runs.
        ctx.effect(() => ctx.locale.register(NS, { zh: zhDictionary, en: enDictionary }), 'dsh-next-input: dictionaries');

        const label = (key) => () => translate(ctx, key);

        // One page, one place: the plugin's own top-level Settings section
        // (its own sidebar row and icon). It used to also register a tab under
        // Settings → Built-in plugins; a second copy of the same form is just
        // somewhere else to edit it.
        const SettingsPage = createSettingsPage(ctx);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'next-input',
          order: 40,
          label: label('settingsNav'),
        }, SettingsPage));

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'next-input',
          order: 40,
          label: label('settingsNav'),
        }, (props) => {
          const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16;
          return React.createElement('svg', {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': 'true',
          },
          React.createElement('path', {
            d: 'M2.5 8h7.5M7 4.5 10.5 8 7 11.5',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
          React.createElement('path', {
            d: 'M13 3v10',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            opacity: 0.45,
          }));
        }));

        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'next-input',
          order: 6,
        }, createComposerNextInput(ctx)));
      },
    };
    if (typeof window !== 'undefined' && window.__DSH_NEXT_INPUT_TEST__ === true) {
      api.__test = { readConversation, readSelection, packConversation, packConversationSmart, toolActivitySummary, contextCharsForSettings, maxMessagesForSettings };
    }
    return api;
  },
});
