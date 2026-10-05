// earpiece recorder for the Zoom web client. Run in the meeting tab's top frame.
// Prefers the "View full transcript" panel (speaker + time per line); falls back to the
// caption overlay, naming speakers from caption initials or the active-speaker tile.
// Finalized lines are queued and POSTed to the local sink; they stay queued until the sink
// accepts them. Every ~10s a heartbeat ({mode, err}) is posted even with no new lines.
// Set window.__earpiecePort first to use a port other than 8765. Re-running restarts cleanly.
(() => {
  const W = window;
  if (W.__rec) clearInterval(W.__rec.timer);
  const R = W.__rec = {
    panel: new Map(), porder: [], psent: new Set(), els: new WeakMap(), seq: 0,
    list: [], sent: 0, lastOut: '', mode: '', err: '',
    q: [], busy: false, lastPost: 0, sinkErr: '',
  };
  const SINK = `http://127.0.0.1:${W.__earpiecePort || 8765}/`;
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

  // Move settled lines (or all lines, when forced) from the current mode into the outbox.
  function collect(force) {
    const now = Date.now(), settle = force ? 0 : SETTLE;
    if (R.mode === 'panel') {
      for (const k of R.porder) {
        if (R.psent.has(k)) continue;
        const e = R.panel.get(k); if (now - e.upd < settle) break;
        R.q.push(`${e.ts} | ${e.sp}: ${e.t}`); R.psent.add(k); R.lastOut = e.t;
      }
    } else if (R.mode === 'overlay') {
      while (R.sent < R.list.length) {
        const e = R.list[R.sent]; if (now - e.upd < settle) break;
        const piece = trim(e.t); R.lastOut = e.t; R.sent++;
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
      .catch(e => { R.sinkErr = 'sink unreachable: ' + e.message; })
      .finally(() => { R.busy = false; });
  }

  R.timer = setInterval(() => {
    try {
      const d = mdoc();
      if (!d) { R.mode = 'no-meeting'; send(); return; }
      const items = d.querySelectorAll('.lt-full-transcript__item');
      const next = items.length ? 'panel' : 'overlay', prev = R.mode;
      // On a mode switch, flush everything the old mode still holds before changing over.
      if (prev !== next && (prev === 'panel' || prev === 'overlay')) collect(true);
      if (next === 'panel') {
        scanPanel(items);
        // The panel shows the whole history; skip what the overlay already covered.
        if (prev === 'overlay' && R.sent > 0) R.porder.forEach(k => R.psent.add(k));
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
