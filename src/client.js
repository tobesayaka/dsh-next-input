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
    const MAX_CONTEXT_CHARS = 7000;
    const MAX_MESSAGES = 24;
    const SETTLE_DELAY_MS = 50;
    const EMPTY = [];

    const FALLBACK = {
      tab: 'Tab',
      hint: 'Tab to accept',
      enterSend: 'Enter sends',
      hintEnter: 'Tab to accept; Enter to accept and send',
      announce: 'A next-input prediction is available. Press Tab to accept.',
      announceEnter: 'A next-input prediction is available. Press Tab to accept, or Enter to accept and send.',
      fallback: 'Prediction',
      settingsTab: 'Next input',
      settingsTitle: 'Next input prediction',
      settingsIntro: 'Changes apply to the next prediction. Values are stored in DSH user data.',
      sectionPrediction: 'Prediction',
      sectionModel: 'Model & latency',
      sectionContext: 'Context & output',
      enterToSendLabel: 'Enter accepts and sends',
      enterToSendHint: 'Tab only accepts; plain Enter accepts and sends the prediction.',
      predictOnActivateLabel: 'Predict on session open',
      predictOnActivateHint: 'When no cached prediction exists, opening a session generates one. Costs one model call.',
      predictionProviderLabel: 'Prediction provider',
      predictionProviderHint: 'Leave both empty to reuse the latest answer’s route.',
      predictionModelLabel: 'Prediction model',
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
      automaticRoute: 'Use latest answer’s route',
      selectModel: 'Select a model',
      noModels: 'No models advertised',
      invalidNumber: 'Enter a whole number between {min} and {max}.',
      readOnly: 'Settings are not editable in this profile.',
    };

    const CSS = `
[${GHOST_ATTR}] [data-composer-placeholder]{visibility:hidden !important}
`;

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
     * Recent human and assistant text from the loaded Session window, oldest
     * first, plus the route that produced the latest answer.
     * @param {any} sessions
     * @param {string | undefined} sessionId
     */
    function readConversation(sessions, sessionId) {
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

      return { messages: packConversation(all, MAX_CONTEXT_CHARS, MAX_MESSAGES), model, answerKey };
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

      const localeRevision = React.useSyncExternalStore(
        React.useCallback((notify) => {
          const locale = ctx.get('locale');
          return locale === undefined || locale === null ? () => {} : locale.subscribe(notify);
        }, []),
        () => {
          const locale = ctx.get('locale');
          return locale === undefined || locale === null ? 0 : locale.getSnapshot().revision;
        },
        () => 0,
      );

      const t = (key) => {
        const locale = ctx.get('locale');
        if (locale === undefined || locale === null) return FALLBACK[key] || key;
        const text = locale.bind(NS)(key);
        return text === key ? (FALLBACK[key] || key) : text;
      };

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

      const dismissPrediction = (session, answerKey) => {
        if (session === undefined || session === null || answerKey === undefined || answerKey === null || answerKey === '') return;
        dismissedRef.current = session + '|' + answerKey;
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

      const generate = async (attempt = 0) => {
        if (!mountedRef.current) return;
        if (draftRef.current !== '' || runningRef.current || phaseRef.current !== 'plain') return;
        const sessions = ctx.get('sessions');
        const session = sessionRef.current;
        if (sessions === undefined || sessions === null || session === undefined || session === null) return;

        const conversation = readConversation(sessions, session);
        const last = conversation.messages[conversation.messages.length - 1];
        // The event window can trail the running flag by a frame; retry briefly
        // instead of dropping the turn.
        if (conversation.model === null || last === undefined || last.role !== 'assistant') {
          if (attempt < 3) schedule(150, attempt + 1);
          return;
        }

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
              sessionId: session,
              answerKey: conversation.answerKey ?? '',
              messages: conversation.messages,
            }),
            signal: controller.signal,
          });
          if (!response.ok) return;
          const data = await response.json();
          if (!mountedRef.current || seq !== requestSeqRef.current) return;
          if (draftRef.current !== '' || runningRef.current || phaseRef.current !== 'plain') return;
          if (sessionRef.current !== session) return;
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

      const schedule = (delay, attempt = 0) => {
        clearTimer();
        timerRef.current = window.setTimeout(() => {
          timerRef.current = 0;
          void generate(attempt);
        }, delay);
      };

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
            if (data !== null && data.predictOnActivate === true) schedule(50);
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
        let attempts = 0;
        let card = null;
        let editor = null;
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
          if (resizeAttached) {
            window.removeEventListener('resize', measure);
            resizeAttached = false;
          }
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
          const next = {
            left: targetRect.left - cardRect.left + (usePlaceholder ? 0 : paddingLeft),
            top: targetRect.top - cardRect.top + (usePlaceholder ? 0 : paddingTop),
            width,
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
      }, [suggestion, draft, phase, sessionId, localeRevision]);

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

      const ghost = suggestion !== null && suggestion.sessionId === sessionId
        && box !== null && draft === '' && phase === 'plain'
        ? h('div', {
          'data-dsh-next-input-ghost': '',
          'aria-hidden': 'true',
          title: suggestion.enterToSend === true ? t('hintEnter') : t('hint'),
          style: {
            position: 'absolute',
            left: box.left,
            top: box.top,
            width: box.width,
            maxWidth: box.width,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            direction: box.direction,
            textAlign: box.direction === 'rtl' ? 'right' : 'left',
            fontFamily: box.fontFamily,
            fontSize: box.fontSize,
            lineHeight: box.lineHeight,
            letterSpacing: box.letterSpacing,
            color: 'var(--dsw-alias-label-secondary)',
            opacity: 0.8,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            pointerEvents: 'none',
            zIndex: 5,
          },
        },
        h('span', {
          key: 'text',
          style: {
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, suggestion.text),
        h('kbd', {
          key: 'tab',
          style: {
            flex: 'none',
            display: 'inline-block',
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
            flex: 'none',
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
      ghost,
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
        padding: '18px 20px 28px',
        maxWidth: 720,
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: '20px',
      };
      const TITLE = { fontSize: 16, lineHeight: '24px', fontWeight: 600 };
      const INTRO = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px', maxWidth: 560 };
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
      const ACTIONS = { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, flexWrap: 'wrap' };
      const BUTTON = {
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      };
      const PRIMARY = {
        ...BUTTON,
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
      };
      const STATUS = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' };
      const ERROR = { ...STATUS, color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary))' };

      const LABEL_KEYS = {
        maxSuggestionChars: 'maxSuggestionCharsLabel',
        maxContextChars: 'maxContextCharsLabel',
        maxMessages: 'maxMessagesLabel',
        maxTokens: 'maxTokensLabel',
        timeoutMs: 'timeoutLabel',
      };

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
        };
      }

      return function NextInputSettings() {
        const localeRevision = React.useSyncExternalStore(
          React.useCallback((notify) => {
            const locale = ctx.get('locale');
            return locale === undefined || locale === null ? () => {} : locale.subscribe(notify);
          }, []),
          () => {
            const locale = ctx.get('locale');
            return locale === undefined || locale === null ? 0 : locale.getSnapshot().revision;
          },
          () => 0,
        );
        const t = (key) => {
          const locale = ctx.get('locale');
          if (locale === undefined || locale === null) return FALLBACK[key] || key;
          const text = locale.bind(NS)(key);
          return text === key ? (FALLBACK[key] || key) : text;
        };

        const [form, setForm] = React.useState(null);
        const [providers, setProviders] = React.useState([]);
        const [loading, setLoading] = React.useState(true);
        const [saving, setSaving] = React.useState(false);
        const [editable, setEditable] = React.useState(true);
        const [error, setError] = React.useState('');
        const [saved, setSaved] = React.useState(false);

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

        const toggle = (label, checked, onToggle) => React.createElement('button', {
          type: 'button',
          role: 'switch',
          'aria-label': label,
          'aria-checked': checked === true,
          disabled: saving,
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
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.6 : 1,
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

        const switchRow = (label, hint, checked, onToggle) => React.createElement('div', { style: ROW },
          React.createElement('div', { style: STACK },
            React.createElement('div', { style: LABEL }, label),
            hint === '' ? null : React.createElement('div', { style: HINT }, hint),
          ),
          toggle(label, checked, onToggle),
        );

        const inputRow = (label, hint, key, numeric, width) => React.createElement('div', { style: ROW },
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
            disabled: saving,
            spellCheck: false,
            onChange: (event) => update(key, event.target.value),
            style: { ...INPUT, width: width === undefined ? 160 : width },
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

        if (loading) {
          return React.createElement('div', { style: PAGE },
            React.createElement('div', { style: STATUS }, t('loading')));
        }
        if (form === null) {
          return React.createElement('div', { style: PAGE },
            React.createElement('div', { style: ERROR }, error === '' ? t('loadFailed') : error));
        }
        if (!editable) {
          return React.createElement('div', { style: PAGE },
            React.createElement('div', { style: TITLE }, t('settingsTitle')),
            React.createElement('div', { style: INTRO }, t('settingsIntro')),
            React.createElement('div', { style: ERROR }, t('readOnly')));
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
          const entry = providers.find((provider) => provider.id === value);
          setForm((previous) => (previous === null ? previous : {
            ...previous,
            predictionProvider: value,
            predictionModel: value === '' || entry === undefined || !Array.isArray(entry.models) || entry.models[0] === undefined
              ? ''
              : entry.models[0].id,
          }));
          setSaved(false);
          setError('');
        };

        return React.createElement('div', { style: PAGE },
          React.createElement('div', null,
            React.createElement('div', { style: TITLE }, t('settingsTitle')),
            React.createElement('div', { style: INTRO }, t('settingsIntro')),
          ),
          section(t('sectionPrediction'), [
            switchRow(t('enterToSendLabel'), t('enterToSendHint'), form.enterToSend, (value) => update('enterToSend', value)),
            switchRow(t('predictOnActivateLabel'), t('predictOnActivateHint'), form.predictOnActivate, (value) => update('predictOnActivate', value)),
          ]),
          section(t('sectionModel'), [
            selectRow(t('predictionProviderLabel'), t('predictionProviderHint'), form.predictionProvider, providerOptions, changeProvider, false, 220),
            selectRow(t('predictionModelLabel'), form.predictionProvider !== '' && models.length === 0 ? t('noModels') : '', form.predictionModel, modelOptions, (value) => update('predictionModel', value), form.predictionProvider === '' || models.length === 0, 220),
            inputRow(t('maxTokensLabel'), '', 'maxTokens', true),
            inputRow(t('timeoutLabel'), '', 'timeoutMs', true),
          ]),
          section(t('sectionContext'), [
            inputRow(t('maxContextCharsLabel'), '', 'maxContextChars', true),
            inputRow(t('maxMessagesLabel'), '', 'maxMessages', true),
            inputRow(t('maxSuggestionCharsLabel'), '', 'maxSuggestionChars', true),
          ]),
          React.createElement('div', { style: ACTIONS },
            React.createElement('button', {
              type: 'button',
              disabled: saving,
              onClick: save,
              style: saving ? { ...PRIMARY, opacity: 0.6, cursor: 'default' } : PRIMARY,
            }, saving ? t('saving') : t('save')),
            React.createElement('button', {
              type: 'button',
              disabled: saving,
              onClick: reset,
              style: saving ? { ...BUTTON, opacity: 0.6, cursor: 'default' } : BUTTON,
            }, t('reset')),
            saved ? React.createElement('span', { style: STATUS }, t('saved')) : null,
            error !== '' ? React.createElement('span', { role: 'alert', style: ERROR }, error) : null,
          ),
        );
      };
    }

    const api = {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale');
        if (locale !== undefined && locale !== null) {
          ctx.effect(() => locale.register(NS, 'zh', {
            tab: 'Tab',
            hint: '按 Tab 采纳这则预测',
            enterSend: 'Enter 发送',
            hintEnter: '按 Tab 采纳，Enter 采纳并发送',
            fallback: '预测',
            announce: '有可用的下一步输入预测，按 Tab 采纳。',
            announceEnter: '有可用的下一步输入预测，按 Tab 采纳，或按 Enter 采纳并发送。',
            settingsTab: '下一步输入',
            settingsTitle: '下一步输入预测',
            settingsIntro: '修改会应用到下一次预测；配置保存在 DSH 用户数据里。',
            sectionPrediction: '预测',
            sectionModel: '模型与延迟',
            sectionContext: '上下文与输出',
            enterToSendLabel: 'Enter 采纳并发送',
            enterToSendHint: 'Tab 只采纳；普通 Enter 会采纳并发送预测。',
            predictOnActivateLabel: '打开会话时预生成',
            predictOnActivateHint: '当前回答没有缓存时，打开会话会生成一次预测；会多一次模型调用。',
            predictionProviderLabel: '预测 provider',
            predictionProviderHint: '两项都留空表示复用最近回答的路由。',
            predictionModelLabel: '预测 model',
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
            automaticRoute: '使用最近回答的路由',
            selectModel: '选择模型',
            noModels: '没有可用模型',
            invalidNumber: '请输入 {min} 到 {max} 之间的整数。',
            readOnly: '当前 profile 不允许编辑配置。',
          }), 'next-input: zh dictionary');
          ctx.effect(() => locale.register(NS, 'en', {
            tab: 'Tab',
            hint: 'Press Tab to accept this prediction',
            enterSend: 'Enter sends',
            hintEnter: 'Press Tab to accept or Enter to accept and send',
            fallback: 'Prediction',
            announce: 'A next-input prediction is available. Press Tab to accept.',
            announceEnter: 'A next-input prediction is available. Press Tab to accept, or Enter to accept and send.',
            settingsTab: 'Next input',
            settingsTitle: 'Next input prediction',
            settingsIntro: 'Changes apply to the next prediction. Values are stored in DSH user data.',
            sectionPrediction: 'Prediction',
            sectionModel: 'Model & latency',
            sectionContext: 'Context & output',
            enterToSendLabel: 'Enter accepts and sends',
            enterToSendHint: 'Tab only accepts; plain Enter accepts and sends the prediction.',
            predictOnActivateLabel: 'Predict on session open',
            predictOnActivateHint: 'When no cached prediction exists, opening a session generates one. Costs one model call.',
            predictionProviderLabel: 'Prediction provider',
            predictionProviderHint: 'Leave both empty to reuse the latest answer’s route.',
            predictionModelLabel: 'Prediction model',
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
            automaticRoute: 'Use latest answer’s route',
            selectModel: 'Select a model',
            noModels: 'No models advertised',
            invalidNumber: 'Enter a whole number between {min} and {max}.',
            readOnly: 'Settings are not editable in this profile.',
          }), 'next-input: en dictionary');
        }

        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'next-input',
          order: 50,
          label: () => {
            const current = ctx.get('locale');
            return current === undefined || current === null ? 'Next input' : current.bind(NS)('settingsTab');
          },
        }, createSettingsPage(ctx)));

        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'next-input',
          order: 6,
        }, createComposerNextInput(ctx)));
      },
    };
    if (typeof window !== 'undefined' && window.__DSH_NEXT_INPUT_TEST__ === true) {
      api.__test = { readConversation };
    }
    return api;
  },
});
