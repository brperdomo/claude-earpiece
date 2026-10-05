// earpiece recorder for the Zoom web client. Run in the meeting tab's top frame.
// Prefers the "View full transcript" panel (speaker + time per line); falls back to the
// caption overlay, naming speakers from caption initials or the active-speaker tile.
// Finalized lines are POSTed to the local sink. Re-running restarts cleanly.
(() => {
  const W = window;
  if (W.__rec) clearInterval(W.__rec.timer);
  const R = W.__rec = { panel: new Map(), porder: [], psent: new Set(), list: [], sent: 0, lastOut: '', mode: '' };
  const SINK = 'http://127.0.0.1:8765/';
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const initials = n => n.split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase();
  const mdoc = () => {
    const f = [...document.querySelectorAll('iframe')].find(f => /webmeeting|\/wc\/\d+\/(join|start)/.test(f.src || ''));
    try { return f && f.contentDocument; } catch (e) { return null; }
  };
  // Drop text already sent: rolling captions repeat the previous tail.
  const trim = t => { const p = R.lastOut; for (let k = Math.min(p.length, t.length); k >= 15; k--) if (p.endsWith(t.slice(0, k))) return t.slice(k).trim(); return t; };

  function scanPanel(d) {
    const items = d.querySelectorAll('.lt-full-transcript__item');
    if (!items.length) return false;
    let cur = null;
    items.forEach(it => {
      const q = s => { const e = it.querySelector(s); return e ? norm(e.innerText) : ''; };
      const name = q('.lt-full-transcript__display-name'), ts = q('.lt-full-transcript__time'), t = q('.lt-full-transcript__message');
      if (name) cur = name;
      if (!t) return;
      const key = ts + '|' + t.slice(0, 12).toLowerCase();
      const e = R.panel.get(key);
      const sp = name || cur || (e && e.sp) || '?';
      if (!e) { R.panel.set(key, { ts, sp, t, upd: Date.now() }); R.porder.push(key); }
      else {
        if (t !== e.t && t.length >= e.t.length - 3) { e.t = t; e.upd = Date.now(); }
        if (name && name !== e.sp) { e.sp = name; e.upd = Date.now(); }
      }
    });
    return true;
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

  function flush() {
    const now = Date.now(), out = [];
    if (R.mode === 'panel') {
      for (const k of R.porder) {
        if (R.psent.has(k)) continue;
        const e = R.panel.get(k); if (now - e.upd < 6000) break;
        out.push(`${e.ts} | ${e.sp}: ${e.t}`); R.psent.add(k);
      }
    } else {
      while (R.sent < R.list.length) {
        const e = R.list[R.sent]; if (now - e.upd < 6000) break;
        const piece = trim(e.t); R.lastOut = e.t; R.sent++;
        if (piece) out.push(`${e.ts} | ${e.sp}: ${piece}`);
      }
    }
    if (out.length) fetch(SINK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) })
      .catch(() => { R.err = 'sink unreachable'; });
  }

  R.timer = setInterval(() => {
    try {
      const d = mdoc(); if (!d) { R.mode = 'no-meeting'; return; }
      if (scanPanel(d)) R.mode = 'panel'; else { scanOverlay(d); R.mode = 'overlay'; }
      flush();
    } catch (e) { R.err = String(e); }
  }, 700);
  return 'recorder running';
})();
