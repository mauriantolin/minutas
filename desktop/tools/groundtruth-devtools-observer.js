// REFERENCE TRUTH capture — paste into DevTools console (F12) on the Teams meeting tab,
// with live captions ON. It mirrors extension/src/teams-dom-adapter.ts observeCaptions
// (event-driven MutationObserver, lossless) and records EVERY finalized caption line with a
// timestamp aligned to the same wall clock as Log-TeamsCaptionGroundTruth.ps1.
//
// Stop with: __gt.stop()  -> downloads teams-truth-<ts>.json  (array of {t, iso, author, text}).
// Run this and the PowerShell logger in the SAME meeting; then Analyze-CaptionRecall.py diffs them.

(() => {
  const PANE = ['[data-tid="closed-caption-renderer-wrapper"]','[data-tid="closed-caption-v2-window-wrapper"]','[data-tid="closed-captions-renderer"]','[class*="closed-captions"]'];
  const ITEM = ['[data-tid="closed-caption-message"]','.fui-ChatMessageCompact','.ui-chat__item__message','[class*="caption-item"]'];
  const AUTHOR = ['[data-tid="author"]','[class*="author"]','[class*="displayName"]'];
  const TEXT = ['[data-tid="closed-caption-text"]','[class*="caption-text"]'];
  const CAPTION_SETTLE_MS = 1200;
  const first = (r, sels) => { for (const s of sels) { const e = r.querySelector(s); if (e) return e; } return null; };
  const clean = (raw) => raw.split(/[,·|]/)[0].replace(/\b(is speaking|está hablando|muted|silenciado)\b.*$/i,"").replace(/\(unverified\)/i,"").trim();
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  const log = [];
  const record = (t, author, text) => { if (text && author) log.push({ t: +t.toFixed(3), iso: new Date().toISOString(), author, text }); };

  const itemSel = ITEM.join(","), paneSel = PANE.join(",");
  const tracked = new Map(), superseded = new Set();
  let settleTimer;
  const readText = (it) => first(it, TEXT)?.textContent?.trim() ?? "";
  const readAuthor = (it) => { const a = first(it, AUTHOR)?.textContent; return a ? clean(a) : ""; };
  const emit = (it) => { const e = tracked.get(it); tracked.delete(it); superseded.delete(it); if (e && e.text && e.author) record(e.t, e.author, e.text); };
  const scheduleSettle = () => { clearTimeout(settleTimer); settleTimer = setTimeout(() => { for (const it of [...superseded]) emit(it); }, CAPTION_SETTLE_MS); };
  const touch = (it) => {
    const text = readText(it); if (!text) return;
    const prev = tracked.get(it); const isNew = !tracked.has(it);
    const author = readAuthor(it) || prev?.author || ""; if (!author) return;
    if (prev && author !== prev.author) { record(prev.t, prev.author, prev.text); superseded.delete(it); tracked.set(it, { t: now(), author, text }); }
    else { tracked.set(it, { t: prev?.t ?? now(), author, text }); }
    if (isNew) { for (const o of tracked.keys()) if (o !== it) superseded.add(o); if (superseded.size) scheduleSettle(); }
  };
  const itemOf = (node) => { const el = node instanceof Element ? node : node.parentElement; const it = el?.closest(itemSel) ?? null; return it?.closest(paneSel) ? it : null; };
  const obs = new MutationObserver((recs) => {
    for (const rec of recs) {
      const tgt = itemOf(rec.target); if (tgt) touch(tgt);
      for (const added of rec.addedNodes) {
        if (!(added instanceof Element)) continue;
        const self = added.closest(itemSel); if (self && self !== tgt && self.closest(paneSel)) touch(self);
        added.querySelectorAll(itemSel).forEach((el) => { if (el !== tgt && el.closest(paneSel)) touch(el); });
      }
    }
    for (const el of [...tracked.keys()]) if (!el.isConnected) emit(el);
  });
  obs.observe(document.body, { subtree: true, childList: true, characterData: true });

  window.__gt = {
    count: () => log.length,
    stop: () => {
      obs.disconnect(); clearTimeout(settleTimer); for (const el of [...tracked.keys()]) emit(el);
      const blob = new Blob([JSON.stringify(log, null, 0)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = `teams-truth-${new Date().toISOString().replace(/[:.]/g,"-")}.json`; a.click();
      console.log(`[groundtruth] downloaded ${log.length} finalized captions`);
      return log.length;
    },
  };
  console.log("[groundtruth] observing. __gt.count() to peek, __gt.stop() to download.");
})();
