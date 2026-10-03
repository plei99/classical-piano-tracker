// Injected into every benchmark page before any of the app's scripts run
// (Playwright addInitScript). Everything here is generic over the four builds:
// they share the DOM and class names (li.row, .row--selected, .footer .status,
// the list summary), so one set of selectors and predicates fits all of them.
//
// Exposes window.__bench:
//   marks         load milestones in performance.now() ms (same clock as Navigation Timing)
//   arm(kind, arg, key) / wait()   one interaction measurement
//   check()       the armed predicate, for the independent Playwright-side measure
//   state()       a snapshot of the DOM state the predicates read
(() => {
  if (window.__bench) return;
  const opts = window.__benchOptions ?? {};
  const now = () => performance.now();
  const raf = (fn) => requestAnimationFrame(() => fn());
  performance.setResourceTimingBufferSize(10000);
  const B = (window.__bench = { marks: {}, armed: null, last: null, wasmMemories: [], probeDispatched: 0 });

  // ---- WebAssembly memory (not part of the JS heap) ----
  for (const name of ['instantiate', 'instantiateStreaming']) {
    const orig = WebAssembly[name];
    if (typeof orig !== 'function') continue;
    WebAssembly[name] = function (...args) {
      return orig.apply(this, args).then((r) => {
        const inst = r instanceof WebAssembly.Instance ? r : r.instance;
        try {
          for (const v of Object.values(inst.exports)) if (v instanceof WebAssembly.Memory) B.wasmMemories.push(v);
        } catch {}
        return r;
      });
    };
  }

  // ---- DOM state the predicates read ----
  const q = (sel) => document.querySelector(sel);
  const text = (sel) => q(sel)?.textContent?.trim() ?? '';
  const selectedId = () => q('li.row--selected')?.id ?? null;
  const summary = () => text('.pane--list .pane__header .muted');
  const status = () => text('.footer .status');
  const state = () => ({
    selected: selectedId(),
    selectedY: (() => {
      const m = /translateY\((-?[\d.e+]+)px\)/.exec(q('li.row--selected')?.getAttribute('style') ?? '');
      return m ? Number(m[1]) : null;
    })(),
    summary: summary(),
    status: status(),
    editor: q('section.editor') !== null,
    starsOn: document.querySelectorAll('.stars--input .star--on').length,
    activeTag: document.activeElement?.tagName ?? null,
    activeType: document.activeElement?.getAttribute?.('type') ?? null,
    rows: document.querySelectorAll('li.row').length,
  });
  B.state = state;

  // A predicate is built at arm time from the state before the key, so it
  // means "the DOM now shows this key's effect".
  const predicates = {
    // j / k / g / G: a different row is selected and rendered.
    selChange: (before) => () => {
      const s = selectedId();
      return s !== null && s !== before.selected;
    },
    // o: the summary's sort label changed.
    sortChange: (before) => {
      const label = (s) => / sort: (.+)$/.exec(s)?.[1] ?? '';
      return () => label(summary()) !== '' && label(summary()) !== label(before.summary);
    },
    // A search keystroke: the status shows the new query and the list summary
    // agrees with the status's match count (one render updated both).
    search: (before, prefix) => () => {
      const st = status();
      const want = `Search /${prefix}_ (`;
      if (!st.startsWith(want)) return false;
      const m = /\((\d+)\/(\d+)\)$/.exec(st);
      if (!m) return false;
      const sum = summary();
      return prefix.trim() === '' ? sum.startsWith(`${m[2]} loaded`) : sum.startsWith(`${m[1]}/${m[2]} shown`);
    },
    // Esc out of search: the search status is gone and the full list is back.
    searchExit: () => () => !status().startsWith('Search /') && / loaded · /.test(summary()),
    editorOpen: () => () => q('section.editor') !== null,
    // A star digit sets the stars and moves the editor's focus to the opinion field.
    stars: (before, n) => () =>
      q('section.editor') !== null &&
      document.querySelectorAll('.stars--input .star--on').length === n &&
      q('.field--focused #opinion') !== null,
    // Save: a new "Saved N/5 rating for track ID" status.
    statusNew: (before, prefix) => () => {
      const st = status();
      return st.startsWith(prefix) && st !== before.status;
    },
  };

  function evaluate() {
    const a = B.armed;
    if (a === null || a.keyTs === null || a.domT !== null) return;
    if (!a.pred()) return;
    a.domT = now();
    // The Playwright-side cross-check: tell Node now (its own clock).
    if (typeof window.__benchSeen === 'function') window.__benchSeen();
    raf(() => {
      a.frameT = now();
      B.armed = null;
      // Requests this key caused (Resource Timing; EventSource pushes are not listed).
      const reqs = performance
        .getEntriesByType('resource')
        .filter((e) => e.startTime >= a.keyTs - 0.5 && e.startTime <= a.domT && e.name.startsWith(location.origin))
        .map((e) => ({ path: new URL(e.name).pathname, start: e.startTime - a.keyTs, end: e.responseEnd - a.keyTs }));
      B.last = {
        reqs,
        kind: a.kind,
        key: a.key,
        dom: a.domT - a.keyTs,
        frame: a.frameT - a.keyTs,
        keyToHandlerStart: a.keyHandled - a.keyTs,
      };
      a.resolve(B.last);
    });
  }

  B.arm = (kind, arg, key) => {
    const before = state();
    performance.clearResourceTimings();
    let resolve;
    const done = new Promise((r) => (resolve = r));
    B.armed = {
      kind,
      key,
      pred: predicates[kind](before, arg),
      keyTs: null,
      keyHandled: null,
      domT: null,
      frameT: null,
      resolve,
      done,
    };
    B.last = null;
    // No polling while armed: a requestAnimationFrame loop or a timer changes
    // how quickly Chromium delivers the server's response (measured: a rAF
    // loop roughly doubled go's `j` latency, a 4 ms timer halved it). Detection
    // is passive: mutations, focus changes, and the keydown itself.
    return before;
  };
  B.check = () => {
    const a = B.armed;
    return a === null ? B.last !== null : a.keyTs !== null && a.pred();
  };
  B.wait = (timeoutMs = 5000) => {
    const a = B.armed;
    if (a === null) return Promise.resolve(B.last);
    return Promise.race([
      a.done,
      new Promise((r) => setTimeout(() => r({ kind: a.kind, timeout: true, state: state() }), timeoutMs)),
    ]);
  };

  // Capture phase on window, registered before the app's own listeners.
  window.addEventListener(
    'keydown',
    (e) => {
      const a = B.armed;
      if (a !== null && a.keyTs === null && e.key === a.key) {
        a.keyTs = e.timeStamp;
        a.keyHandled = now();
        queueMicrotask(evaluate);
      }
    },
    true,
  );

  const mo = new MutationObserver(() => {
    const m = B.marks;
    if (m.firstRow === undefined && q('li.row') !== null) {
      m.firstRow = now();
      raf(() => (m.firstRowFrame = now()));
    }
    if (B.probe) probeCheck();
    evaluate();
  });
  mo.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  window.addEventListener('focusin', () => queueMicrotask(evaluate), true);
  window.addEventListener('focusout', () => queueMicrotask(evaluate), true);

  // ---- Interactive probe: dispatch `j` every few ms from document start
  // until the selection moves; "interactive" is when that first shows. ----
  let initialSel = null;
  function probeCheck() {
    const m = B.marks;
    if (m.interactive !== undefined) return;
    const s = selectedId();
    if (s === null) return;
    if (initialSel === null) {
      initialSel = s;
      m.initialSelection = now();
      return;
    }
    if (s !== initialSel) {
      m.interactive = now();
      clearInterval(B.probe);
      raf(() => (m.interactiveFrame = now()));
    }
  }
  if (opts.probe) {
    B.probe = setInterval(() => {
      if (B.marks.interactive !== undefined) return;
      const target = document.activeElement ?? document.body ?? document.documentElement;
      if (!target) return;
      const init = { key: 'j', code: 'KeyJ', bubbles: true, cancelable: true, composed: true };
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      B.probeDispatched++;
      probeCheck();
    }, opts.probeIntervalMs ?? 5);
  }

  // ---- Paint milestones ----
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') B.marks.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
  } catch {}
})();
