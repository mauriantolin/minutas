#!/usr/bin/env python3
"""
Measure caption RECALL of the WPF desktop watcher and attribute every lost line to a
pipeline stage. Runs on Linux — no Windows needed once you have the two capture files.

Inputs
  --raw    teams-groundtruth-*.jsonl   (from Log-TeamsCaptionGroundTruth.ps1)
  --truth  teams-truth-*.json          (from groundtruth-devtools-observer.js, or a
                                         Live-Captions-Saver export normalized to
                                         [{"t":sec,"author":..,"text":..}, ...])

What it does
  1. Faithfully re-implements the watcher's gates (IsMeetingSurface root gate,
     GetCaptionCandidates, ConvertCandidatesToCaptions) and cross-poll pipeline
     (750 ms downsample, GetNewSnapshotItems dedup, SubmitObservation pending/IsRevision,
     PublishIfStable) over the raw log -> the set the desktop WOULD emit.
  2. Aligns emitted vs truth by fuzzy text match and reports word-level + line-level recall.
  3. For every truth line the desktop failed to emit, attributes the loss to the FIRST
     stage that dropped it:
        SOURCE      - text never appeared in ANY raw patternText poll (unrecoverable here)
        ROOT_GATE   - present in patternText but IsMeetingSurface rejected the root that poll
        EXTRACTION  - present + root kept, but GetCaptionCandidates/Convert dropped the line
        PIPELINE    - extracted but never emitted (dedup / revision / settle)

Usage
  python3 Analyze-CaptionRecall.py --raw teams-groundtruth-*.jsonl --truth teams-truth-*.json
"""
import argparse, glob, json, re, sys
from difflib import SequenceMatcher

# ---- faithful port of TeamsCaptionWatcher gates (kept 1:1 with the C#) -------------------
SPEAKER = re.compile(r'^(?P<name>[^,;:!?()]{2,90})\s+\((?P<org>[^)]+)\)$')

def norm_text(t): return t.replace('￼', '\n').replace('\r', '\n').replace('|', '\n').replace('\t', ' ')

def is_teams_chrome_line(line):
    if not line.strip(): return False
    if re.match(r'^(New message|Chats? \(|More filters|Copilot|Quick views|Mentions|Discover|Drafts|Favorites|Teams and channels|Chat participants|Shared$|[0-9]+ more tabs\.|Add a tab|Join$|View and add participants|Find in chat|Open chat details|More chat options|Type a message|See more|See all your teams|Communities|Join communities|Resize left panel|Meeting ended|Meeting started)', line, re.I): return True
    if re.match(r'^.+:\s*(joined the conversation\.|named the meeting|Chat has been turned on|Meeting ended:|[0-9]{1,2}:[0-9]{2}\s*(AM|PM).*(Meeting ended|Meeting started))', line, re.I): return True
    return False

def is_speaker_line(m):
    if not m: return False
    if is_teams_chrome_line(m.group(0).strip()): return False
    name, org = m.group('name').strip(), m.group('org').strip()
    if ' ' not in name: return False
    if re.search(r'Ctrl|Alt|Shift|\+|You|more tabs|participants?', org, re.I): return False
    if re.match(r'^(Meeting with|Chat|Chats|New message|Teams|General|All Company|Shared|Join|See more|Type a message)', name, re.I): return False
    return True

def is_meeting_surface(text):
    v, s = norm_text(text), 0
    if re.search(r'\b(Leave|Salir|Abandonar|Colgar)\b', v, re.I): s += 3
    if re.search(r'\b(Share content|Compartir contenido|Presentar)\b', v, re.I): s += 2
    if re.search(r'\b(Raise your hand|Levantar la mano)\b', v, re.I): s += 2
    if re.search(r'\b(Open audio options|Opciones de audio|Mute mic|Silenciar|Unmute|Reactivar audio)\b', v, re.I): s += 2
    if re.search(r'\b(Open video options|Opciones de video|Turn camera on|Activar c[aá]mara|Camera|C[aá]mara)\b', v, re.I): s += 2
    if re.search(r'\b(People|Personas|Participants|Participantes|React|Reaccionar|Rooms|Salas|Notes|Notas)\b', v, re.I): s += 1
    return s >= 5

def get_caption_candidates(pattern_text):
    lines = [l.strip() for l in norm_text(pattern_text).split('\n') if l.strip()]
    start, fb = -1, -1
    for i, l in enumerate(lines):
        if re.match(r'^(Invite people to join you|Live Captions)$', l): start = i
        if fb < 0 and is_speaker_line(SPEAKER.match(l)): fb = i
    if start < 0:
        if fb < 0: return []
        start = fb - 1
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if re.search(r'Closed captions overflow menu|Hide live captions|More options|Calling controls', lines[i], re.I) or is_teams_chrome_line(lines[i]):
            end = i; break
    if end <= start + 1: return []
    out = []
    for i in range(start + 1, end):
        line = lines[i]
        if is_teams_chrome_line(line): continue
        if re.match(r'^(Settings and more|Calling indicators|Encryption status|Elapsed time|Meeting controls|Chat|People|Raise your hand|React|View|More|Turn camera|Open video|Open audio|Mute mic|Share content|Leave|Shared content view|Invite people to join you|Live Captions)$', line, re.I): continue
        if re.match(r'^\d{1,2}:\d{2}$', line): continue
        out.append(line)
    return out

def is_caption_ui_line(line):
    if not line.strip(): return True
    return bool(re.match(r'^(Captions will be shown|Live Caption,|Closed captions|Hide live captions|Caption Settings|Open captions|Live captions language|Speaker attribution|Turn off live captions|Show captions|Subtitles|More options)', line, re.I))

def convert_to_caption(line):
    if not line.strip(): return ('', '')
    m = re.match(r'^(?P<speaker>.+?\([^)]+\))\s+(?P<text>.+)$', line)
    return (m.group('speaker').strip(), m.group('text').strip()) if m else ('', line.strip())

def convert_candidates(cands):
    cur, out = '', []
    for c in cands:
        if is_caption_ui_line(c): continue
        m = SPEAKER.match(c)
        if is_speaker_line(m): cur = c.strip(); continue
        sp, tx = convert_to_caption(c)
        if not tx.strip(): continue
        if not sp.strip() and cur.strip(): sp = cur
        out.append((sp, tx))
    return out

def comparable(t): return re.sub(r'\s+', ' ', t.strip()).rstrip('.,;:?! ')

REVISION_SIMILARITY_THRESHOLD = 0.6

def _levenshtein(a, b):
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[len(b)]

def similarity(a, b):
    a, b = a.lower(), b.lower()
    if not a or not b: return 0.0
    return 1.0 - _levenshtein(a, b) / max(len(a), len(b))

def is_revision(prev, cur):
    p, c = comparable(prev), comparable(cur)
    if not p: return False
    if len(c) >= len(p) and c.lower().startswith(p.lower()): return True
    return similarity(p, c) >= REVISION_SIMILARITY_THRESHOLD

# ---- cross-poll pipeline simulation (750 ms downsample of the raw high-freq log) ---------
def simulate_emitted(records, poll_ms=750, stable_ms=2000):
    """records: list of {elapsedMs, patternText} for the meeting root, time-sorted."""
    emitted, pending, pending_at, prev_snap, seeded = [], None, None, [], False
    next_poll = 0
    def publish():
        nonlocal pending, pending_at
        if pending: emitted.append(pending); pending, pending_at = None, None
    def submit(cap, t):
        nonlocal pending, pending_at
        sp, tx = cap
        if not tx.strip(): return
        if pending is None: pending, pending_at = cap, t; return
        same = pending[0] == sp
        if same and is_revision(pending[1], tx):
            if len(comparable(tx)) > len(comparable(pending[1])): pending, pending_at = cap, t
            return
        if same and is_revision(tx, pending[1]): return
        publish(); pending, pending_at = cap, t
    for r in records:
        t = r['elapsedMs']
        if t < next_poll: continue
        next_poll = t + poll_ms
        # Root gate (post-fix): a root with caption-like text is kept even when the meeting
        # toolbar is auto-hidden. Set legacy_root_gate=True to reproduce the pre-fix loss.
        cands = convert_candidates(get_caption_candidates(r['patternText']))
        gate = is_meeting_surface(r['patternText']) or bool(cands)
        snap = cands if gate else []
        if snap:
            if not seeded: prev_snap, seeded = snap, True
            else:
                prev_keys = set(f"{s}|{x}" for s, x in prev_snap)
                for cap in snap:
                    if f"{cap[0]}|{cap[1]}" not in prev_keys: submit(cap, t)
                prev_snap = snap
        if pending is not None and pending_at is not None and (t - pending_at) >= stable_ms:
            publish()
    publish()
    return emitted

# ---- loss attribution --------------------------------------------------------------------
def similar(a, b): return SequenceMatcher(None, comparable(a).lower(), comparable(b).lower()).ratio()

def best_match(text, pool):
    best, score = None, 0.0
    for p in pool:
        s = similar(text, p)
        if s > score: best, score = p, s
    return best, score

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw', required=True)
    ap.add_argument('--truth', required=True)
    ap.add_argument('--match', type=float, default=0.6, help='fuzzy match threshold')
    a = ap.parse_args()

    raw_path = sorted(glob.glob(a.raw))[-1] if glob.glob(a.raw) else a.raw
    truth_path = sorted(glob.glob(a.truth))[-1] if glob.glob(a.truth) else a.truth
    recs = [json.loads(l) for l in open(raw_path) if l.strip()]
    truth = json.load(open(truth_path))

    # meeting root = the record stream whose patternText looks like a live-caption surface
    meeting = [r for r in recs if get_caption_candidates(r['patternText'])]
    meeting.sort(key=lambda r: r['elapsedMs'])
    emitted = simulate_emitted(meeting)
    emitted_texts = [x[1] for x in emitted]

    # every raw patternText, ever (for SOURCE vs later attribution)
    all_raw_lines = []
    kept_raw_lines = []       # only polls where root gate passed
    extracted_lines = []      # after GetCaptionCandidates/Convert
    for r in meeting:
        gate = is_meeting_surface(r['patternText'])
        for l in norm_text(r['patternText']).split('\n'):
            l = l.strip()
            if l: all_raw_lines.append(l)
        if gate:
            for l in norm_text(r['patternText']).split('\n'):
                l = l.strip()
                if l: kept_raw_lines.append(l)
            extracted_lines += [x[1] for x in convert_candidates(get_caption_candidates(r['patternText']))]

    stages = {'MATCHED': 0, 'SOURCE': 0, 'ROOT_GATE': 0, 'EXTRACTION': 0, 'PIPELINE': 0}
    losses = []
    for e in truth:
        txt = e['text']
        _, s_emit = best_match(txt, emitted_texts)
        if s_emit >= a.match:
            stages['MATCHED'] += 1; continue
        _, s_extr = best_match(txt, extracted_lines)
        _, s_kept = best_match(txt, kept_raw_lines)
        _, s_raw = best_match(txt, all_raw_lines)
        if s_raw < a.match:
            stage = 'SOURCE'
        elif s_kept < a.match:
            stage = 'ROOT_GATE'
        elif s_extr < a.match:
            stage = 'EXTRACTION'
        else:
            stage = 'PIPELINE'
        stages[stage] += 1
        losses.append((stage, e.get('author', '?'), txt))

    total = len(truth)
    tw = sum(len(comparable(e['text']).split()) for e in truth)
    mw = sum(len(comparable(e['text']).split()) for e in truth if best_match(e['text'], emitted_texts)[1] >= a.match)
    print(f"raw log     : {raw_path}  ({len(meeting)} meeting-root polls)")
    print(f"truth       : {truth_path}  ({total} finalized captions)")
    print(f"desktop emit: {len(emitted)} captions")
    print()
    print(f"LINE recall : {stages['MATCHED']}/{total} = {100*stages['MATCHED']/max(total,1):.1f}%")
    print(f"WORD recall : {mw}/{tw} = {100*mw/max(tw,1):.1f}%")
    print()
    print("LOSS ATTRIBUTION (first stage that dropped each missing line):")
    for k in ('SOURCE', 'ROOT_GATE', 'EXTRACTION', 'PIPELINE'):
        n = stages[k]
        print(f"  {k:11s}: {n:4d}  ({100*n/max(total,1):.1f}%)")
    print()
    if losses:
        print("SAMPLE LOST LINES:")
        for stage, auth, txt in losses[:40]:
            print(f"  [{stage:10s}] {auth}: {txt[:90]}")

if __name__ == '__main__':
    main()
