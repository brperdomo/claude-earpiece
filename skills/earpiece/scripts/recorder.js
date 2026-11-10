// earpiece recorder for the Zoom and Microsoft Teams web clients. Run in the meeting tab's top frame.
// Zoom: prefers the "View full transcript" panel (speaker + time per line); falls back to the
// caption overlay, naming speakers from caption initials or the active-speaker tile.
// Teams: reads the live captions pane, where every line carries its speaker's name.
// Finalized lines are queued and POSTed to the local sink; they stay queued until the sink
// accepts them. Every ~10s a heartbeat ({mode, err}) is posted even with no new lines.
// Teams' CSP only allows http://localhost:4318, so the sink port defaults to 4318 there and
// 8765 on Zoom. Set window.__earpiecePort first to override, and window.__earpiecePlatform
// ('zoom' or 'teams') to skip hostname detection. Re-running restarts cleanly.
(() => {
  const W = window;
  if (W.__rec) { clearInterval(W.__rec.timer); document.removeEventListener('securitypolicyviolation', W.__rec.onCsp); }
  const R = W.__rec = {
    panel: new Map(), porder: [], psent: new Set(), els: new WeakMap(), tels: new WeakMap(), seq: 0,
    list: [], sent: 0, lastOut: '', mode: '', err: '',
    q: [], busy: false, lastPost: 0, sinkErr: '', csp: '',
  };
  const TEAMS = W.__earpiecePlatform ? W.__earpiecePlatform === 'teams' : /(^|\.)teams\.(microsoft\.com|cloud\.microsoft|live\.com)$/.test(location.hostname);
  const SINK = TEAMS ? `http://localhost:${W.__earpiecePort || 4318}/` : `http://127.0.0.1:${W.__earpiecePort || 8765}/`;
  R.onCsp = e => { if ((e.blockedURI || '').startsWith(SINK.slice(0, -1))) R.csp = `blocked by the page's CSP (${e.effectiveDirective})`; };
  document.addEventListener('securitypolicyviolation', R.onCsp);
  const SETTLE = 6000, HEARTBEAT = 10000, RETRY = 3000, QMAX = 5000;
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const initials = n => n.split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase();
  const words = s => new Set(s.toLowerCase().match(/[a-z0-9']+/g) || []);
  const similar = (a, b) => {
    const A = words(a), B = words(b); if (!A.size || !B.size) return false;
    let n = 0; A.forEach(w => { if (B.has(w)) n++; });
    return n / Math.min(A.size, B.size) >= 0.6;
  };
  const mdoc = () => {
    const f = [...document.querySelectorAll('iframe')].find(f => /webmeeting|\/wc\/\d+\/(join|start)/.test(f.src || ''));
    try { return f && f.contentDocument; } catch (e) { return null; }
  };
  // Drop text already sent: rolling captions repeat the previous tail.
  const trim = t => { const p = R.lastOut; for (let k = Math.min(p.length, t.length); k >= 15; k--) if (p.endsWith(t.slice(0, k))) return t.slice(k).trim(); return t; };

  // Panel items are matched to entries by DOM element first (Zoom updates an item in place,
  // often rewriting its start), then by same timestamp + similar wording.
  function scanPanel(items) {
    let cur = null;
    const claimed = new Set();
    items.forEach(it => {
      const q = s => { const e = it.querySelector(s); return e ? norm(e.innerText) : ''; };
      const name = q('.lt-full-transcript__display-name'), ts = q('.lt-full-transcript__time'), t = q('.lt-full-transcript__message');
      if (name) cur = name;
      if (!t) return;
      let key = R.els.get(it);
      if (!key) {
        key = R.porder.slice(-30).find(k => {
          if (claimed.has(k)) return false;
          const e = R.panel.get(k);
          return e.ts === ts && (e.t.startsWith(t.slice(0, 12)) || t.startsWith(e.t.slice(0, 12)) || similar(e.t, t));
        });
        if (key) R.els.set(it, key);
      }
      const e = key && R.panel.get(key);
      const sp = name || cur || (e && e.sp) || '?';
      if (!e) {
        key = 'p' + R.seq++; R.els.set(it, key);
        R.panel.set(key, { ts, sp, t, upd: Date.now() }); R.porder.push(key);
      } else {
        if (t !== e.t && t.length >= e.t.length - 3) { e.t = t; e.upd = Date.now(); }
        if (name && name !== e.sp) { e.sp = name; e.upd = Date.now(); }
      }
      claimed.add(key);
    });
  }

  function scanOverlay(d) {
    const box = d.querySelector('.live-transcription-subtitle__box'); if (!box) return;
    const a = d.querySelector('.speaker-active-container__wrap'); const act = a ? norm(a.innerText) : '';
    const ppl = [...new Set([...d.querySelectorAll('[class*="video-frame"]')].map(e => norm(e.innerText)).filter(t => t && t.length < 40))];
    let hint = '';
    [...box.querySelectorAll('.zmu-data-selector-item__icon, .live-transcription-subtitle__item')].forEach(el => {
      if (!el.classList.contains('live-transcription-subtitle__item')) { hint = norm(el.textContent); return; }
      const t = norm(el.innerText); if (!t) return;
      let sp = '';
      if (hint && hint.length <= 3) { const m = ppl.filter(n => initials(n) === hint || initials(n).startsWith(hint)); if (m.length === 1) sp = m[0]; }
      if (!sp) sp = act && act.split(' ').length < 6 ? act : '?';
      hint = '';
      const ex = R.list.slice(-8).find(e => e.t === t || t.startsWith(e.t.slice(0, 18)) || e.t.startsWith(t.slice(0, 18)));
      if (ex) { if (t.length > ex.t.length) { ex.t = t; ex.upd = Date.now(); } if (ex.sp === '?' && sp !== '?') ex.sp = sp; }
      else R.list.push({ ts: new Date().toTimeString().slice(0, 8), sp, t, upd: Date.now() });
    });
  }

  // Teams renders each caption as an author + text pair and refines the text in place.
  // Authors and texts are paired by document order (host and guest layouts nest them
  // differently). The list is virtualized: rows can be recycled for a new caption, or
  // re-mounted as fresh elements with the same final text.
  const TEAMS_WRAPPERS = ['[data-tid="closed-caption-renderer-wrapper"]', '[data-tid="closed-caption-v2-window-wrapper"]', '[data-tid="closed-captions-renderer"]'];
  function scanTeams() {
    let root = null;
    for (const s of TEAMS_WRAPPERS) if ((root = document.querySelector(s))) break;
    if (!root) return false;
    let sp = '';
    root.querySelectorAll('[data-tid="author"], [data-tid="closed-caption-text"]').forEach(el => {
      if (el.getAttribute('data-tid') === 'author') { sp = norm(el.innerText); return; }
      const t = norm(el.innerText); if (!t) return;
      const who = sp || '?';
      let e = R.tels.get(el);
      if (e && !(t.startsWith(e.t.slice(0, 12)) || e.t.startsWith(t.slice(0, 12)) || similar(e.t, t))) e = null;
      if (!e) e = R.list.slice(-50).find(x => x.t === t && (x.sp === who || x.sp === '?'));
      if (!e) { e = { ts: new Date().toTimeString().slice(0, 8), sp: who, t, upd: Date.now() }; R.list.push(e); }
      else {
        if (t !== e.t) { e.t = t; e.upd = Date.now(); }
        if (e.sp === '?' && who !== '?') e.sp = who;
      }
      R.tels.set(el, e);
    });
    return true;
  }

  // Move settled lines (or all lines, when forced) from the current mode into the outbox.
  function collect(force) {
    const now = Date.now(), settle = force ? 0 : SETTLE;
    if (R.mode === 'panel') {
      for (const k of R.porder) {
        if (R.psent.has(k)) continue;
        const e = R.panel.get(k); if (now - e.upd < settle) break;
        R.q.push(`${e.ts} | ${e.sp}: ${e.t}`); R.psent.add(k); R.lastOut = e.t;
      }
    } else if (R.mode === 'overlay' || R.mode === 'teams') {
      while (R.sent < R.list.length) {
        const e = R.list[R.sent]; if (now - e.upd < settle) break;
        const piece = R.mode === 'overlay' ? trim(e.t) : e.t; R.lastOut = e.t; R.sent++;
        if (piece) R.q.push(`${e.ts} | ${e.sp}: ${piece}`);
      }
    }
    if (R.q.length > QMAX) R.q.splice(0, R.q.length - QMAX);
  }

  // Lines leave the outbox only after the sink answers 2xx.
  function send() {
    const now = Date.now();
    if (R.busy) return;
    if (R.sinkErr ? now - R.lastPost < RETRY : !R.q.length && now - R.lastPost < HEARTBEAT) return;
    const lines = R.q.slice(0, 200);
    R.busy = true; R.lastPost = now;
    fetch(SINK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines, mode: R.mode, err: R.err }) })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); R.q.splice(0, lines.length); R.sinkErr = ''; })
      .catch(e => { R.sinkErr = 'sink unreachable: ' + (R.csp || e.message); })
      .finally(() => { R.busy = false; });
  }

  R.timer = setInterval(() => {
    try {
      if (TEAMS) {
        if (scanTeams()) { R.mode = 'teams'; collect(false); }
        else { if (R.mode === 'teams') collect(true); R.mode = 'no-captions'; }
        R.err = '';
        send(); return;
      }
      const d = mdoc();
      if (!d) { R.mode = 'no-meeting'; send(); return; }
      const items = d.querySelectorAll('.lt-full-transcript__item');
      const next = items.length ? 'panel' : 'overlay', prev = R.mode;
      // On a mode switch, flush everything the old mode still holds before changing over.
      if (prev !== next && (prev === 'panel' || prev === 'overlay')) collect(true);
      if (next === 'panel') {
        scanPanel(items);
        // The panel shows the whole history; skip only what the overlay already covered.
        if (prev === 'overlay' && R.sent > 0) {
          const seen = R.list.slice(Math.max(0, R.sent - 500), R.sent).map(e => e.t);
          R.porder.forEach(k => { if (seen.some(t => similar(t, R.panel.get(k).t))) R.psent.add(k); });
        }
      } else {
        const before = R.list.length;
        scanOverlay(d);
        // Captions on screen right now were already sent from the panel.
        if (prev === 'panel') { R.sent = R.list.length; if (R.list.length > before) R.lastOut = R.list[R.list.length - 1].t; }
      }
      R.mode = next; R.err = '';
      collect(false);
    } catch (e) { R.err = String(e); }
    send();
  }, 700);
  return 'recorder running';
})();
