#!/usr/bin/env python3
"""Append one live run to docs/live-run-log.html.

The log is an append-only record of real agent runs: timings, what the code
looked like at the time, the tool calls actually made, the dimension record and
the full transcript. New entries go in at a marker, newest first, so the file
never has to be rewritten.

  python3 appendRun.py <run-dir> --label "biz" --change "what changed before this run"

<run-dir> is a driver output directory containing turns/turn-N.json.
"""
import json, sys, glob, os, re, html, argparse
from datetime import datetime, timezone

LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'live-run-log.html')
MARKER = '<!-- APPEND-NEW-RUNS-HERE -->'

e = lambda s: html.escape(str(s if s is not None else ''))



def reply_html(text):
    """Render the reply EXACTLY as the product does.

    The app's RichText (CampaignDesigner.tsx) does two things and no more:
    a line starting "- " joins a <ul>, and **bold** becomes <strong>. A
    "**Approach**" line is therefore a bold LINE, not a heading. This log used
    to promote those to styled section headings, which made the page easier to
    read than the screen it was documenting -- the opposite of the job.
    """
    if not text:
        return '<p class="na">No reply.</p>'
    out, bullets = [], []

    def flush():
        if bullets:
            out.append('<ul>' + ''.join(f'<li>{b}</li>' for b in bullets) + '</ul>')
            bullets.clear()

    def inline(t):
        t = e(t)
        while '**' in t:
            a = t.find('**')
            b = t.find('**', a + 2)
            if b == -1:
                break
            t = t[:a] + '<strong>' + t[a + 2:b] + '</strong>' + t[b + 2:]
        return t

    for raw in text.split('\n'):
        if raw.startswith('- '):
            bullets.append(inline(raw[2:]))
            continue
        flush()
        if raw.strip():
            out.append(f'<div>{inline(raw)}</div>')
    flush()
    return ''.join(out)


def block(title, body, cls=''):
    return f'<div class="blk {cls}"><div class="blk-t">{e(title)}</div>{body}</div>'


def render(run_dir, label, change, verdict):
    # Only plain turn-N.json. Sibling backups such as turn-2-EMPTY-FAILURE.json
    # are evidence kept beside the run, not turns of it.
    cand = glob.glob(os.path.join(run_dir, 'turns', 'turn-*.json'))
    files = sorted([f for f in cand if re.fullmatch(r'turn-\d+\.json', os.path.basename(f))],
                   key=lambda f: int(re.findall(r'turn-(\d+)\.json', os.path.basename(f))[0]))
    if not files:
        sys.exit(f'no turn records in {run_dir}')
    when = datetime.fromtimestamp(os.path.getmtime(files[0]), timezone.utc).astimezone()
    total = 0.0
    parts, nturn = [], 0

    for f in files:
        d = json.load(open(f))
        r = d['response']
        total += d['ms'] / 1000
        nturn += 1

        # per-round model behaviour, where the harness captured it
        rows = []
        for ev in d['events']:
            if ev.get('type') != 'model.completed':
                continue
            dt = ev.get('data') or {}
            u = dt.get('usage') or {}
            td = (u.get('output_tokens_details') or {}).get('thinking_tokens')
            rows.append(
                f"<tr><td>{e(dt.get('round'))}</td><td>{e(dt.get('stopReason'))}</td>"
                f"<td>{e(', '.join(dt.get('blockTypes') or []))}</td><td class=n>{e(dt.get('textChars'))}</td>"
                f"<td class=n>{e(u.get('output_tokens'))}</td><td class=n>{e(td)}</td></tr>")
        rounds = ('<table class="g"><thead><tr><th>Round<th>Stop<th>Blocks<th>Text<th>Out tok<th>Thinking'
                  f'</tr></thead><tbody>{"".join(rows)}</tbody></table>' if rows
                  else '<p class="na">Per-round data not captured by the harness for this run.</p>')

        # tool calls, grouped by round, repeats flagged
        tcs, rnd = [], 0
        for ev in d['events']:
            if ev.get('type') == 'model.started':
                rnd += 1
            if str(ev.get('type', '')).startswith('model.tool_call.comp') or str(ev.get('type', '')).startswith('model.tool_call.fail'):
                rep = ' <span class="tag rep">repeat</span>' if 'already fetched' in (ev.get('detail') or '') else ''
                bad = ' <span class="tag bad">failed</span>' if ev['type'].endswith('failed') else ''
                tcs.append(f"<li><code>r{rnd}</code> {e(ev.get('title'))}{rep}{bad}"
                           f"<div class=sub>{e((ev.get('detail') or '')[:160])}</div></li>")
        tools = f'<ul class="tl">{"".join(tcs)}</ul>' if tcs else '<p class="na">No tool calls.</p>'

        b = r.get('brief') or {}
        cc = b.get('contextChecked') or []
        ccs = ('<ul class=tl>' + ''.join(
            f'<li>{e(c["source"])} <span class="tag {"ok" if c.get("found") else "warn"}">'
            f'{"found" if c.get("found") else "nothing found"}</span></li>' for c in cc) + '</ul>'
               ) if cc else '<p class="na">Not recorded in this run.</p>'

        sc = b.get('successCriteria') or []
        scs = ('<ul>' + ''.join(f'<li>{e(x)}</li>' for x in sc) + '</ul>') if sc else \
              '<p class="na">Empty — not settled at this point in the conversation.</p>'

        dims = b.get('dimensions') or []
        if dims:
            ds = ''.join(
                f'<li><span class="tag st-{e(x["status"])}">{e(x["status"])}</span>'
                f'<span class="tag bs">{e(x["basis"])}</span> <b>{e(x["name"])}</b>'
                + (f'<div class=sub><i>why</i> {e(x["rationale"])}</div>' if x.get('rationale') else '')
                + (f'<div class=sub><i>note</i> {e(x["note"])}</div>' if x.get('note') else '')
                + '</li>' for x in dims)
            dimh = f'<ul class="tl dims">{ds}</ul>'
        else:
            dimh = '<p class="na">No dimension record produced.</p>'

        qs = r.get('questions') or []
        qsh = ('<ol class=qs>' + ''.join(f'<li>{e(q)}</li>' for q in qs) + '</ol>') if qs else \
              '<p class="na">No questions put to the user.</p>'

        bp = r.get('pendingBlueprint') or r.get('blueprint')
        bph = ''
        if bp:
            steps = []
            for i, s in enumerate(bp.get('steps') or [], 1):
                k = s.get('kind')
                if k == 'send':
                    steps.append(f'<li><b>SEND</b> {e(s.get("name"))} <span class="tag ch">'
                                 f'{e(",".join(s.get("channelPreference") or []))}</span>'
                                 f'<div class=sub>{e(s.get("copy"))}</div>'
                                 f'<div class=sub><i>cta</i> {e(s.get("cta"))}</div></li>')
                elif k == 'wait':
                    steps.append(f'<li><b>WAIT</b> {e(s.get("durationHours"))}h<div class=sub>{e(s.get("why"))}</div></li>')
                elif k == 'waitForEvent':
                    steps.append(f'<li><b>WAIT FOR EVENT</b> {e(s.get("eventCategory"))}/{e(s.get("eventType"))}'
                                 f' · timeout {e(s.get("timeoutDays"))}d</li>')
                elif k == 'exit':
                    steps.append(f'<li><b>EXIT</b><div class=sub>{e(s.get("reason"))}</div></li>')
                else:
                    steps.append(f'<li><b>{e(str(k).upper())}</b></li>')
            bph = block('',
                        f'<p><b>{e(bp.get("campaignName"))}</b> · control {e(bp.get("controlPct"))}%</p>'
                        f'<p class=sub>{e(bp.get("description"))}</p>'
                        f'<pre class=j>entry: {e(json.dumps(bp.get("entry")))}\ngoal : {e(json.dumps(bp.get("goal")))}</pre>'
                        f'<ol class=steps>{"".join(steps)}</ol>')

        ntools = len([1 for ev in d['events'] if str(ev.get('type','')).startswith('model.tool_call.comp')])
        nrounds = len(rows)

        # --- the product surface: ONLY what the person actually sees ---
        # Mirrors CampaignDesigner.tsx: .cd-msg/.cd-msg-role/.cd-msg-bubble,
        # the numbered .cd-q list, and the .cd-confirm gate with its real copy.
        chat = (
            f'<div class="cd-msg user"><div class="cd-msg-role">You</div>'
            f'<div class="cd-msg-bubble">{e(d["userMessage"])}</div></div>'
            f'<div class="cd-msg agent"><div class="cd-msg-role">Agent</div>'
            f'<div class="cd-msg-bubble">{reply_html(r.get("reply"))}</div></div>'
        )
        if qs:
            chat += ('<div class="cd-qs">' + ''.join(
                f'<div class="cd-q"><span class="cd-q-n">{i}</span>{e(q)}</div>'
                for i, q in enumerate(qs, 1)) + '</div>')
        if r['phase'] == 'awaiting-confirmation':
            chat += ('<div class="cd-confirm"><div class="cd-confirm-t">Generate this campaign?</div>'
                     '<p>Nothing has been built yet. Confirm to create the journey, or tell the agent '
                     'what to change.</p><div class="cd-confirm-actions">'
                     '<span class="cd-btn pri">Confirm and generate</span>'
                     '<span class="cd-btn">Keep refining</span></div></div>')

        parts.append(
            f'<section class="turn">'
            f'<div class="screen"><div class="screen-hd">On screen'
            f'<span class="tag ph-{e(r["phase"])}">{e(r["phase"])}</span>'
            f'<span class="tag t">{d["ms"]/1000:.1f}s</span></div>'
            f'<div class="screen-body">{chat}</div></div>'

            f'<div class="behind"><div class="behind-hd">Not on screen &mdash; what the application recorded</div>'
            + block('Dimension record', dimh)
            + block('Success criteria', scs)
            + f'<details class="dx"><summary>Run detail &mdash; {nrounds} model round'
            + ('s' if nrounds != 1 else '') + f', {ntools} tool call'
            + ('s' if ntools != 1 else '') + '</summary>'
            + block('Model rounds', rounds) + block('Tool calls', tools)
            + block('Sources checked', ccs) + '</details>'
            + (f'<details class="dx"><summary>Blueprint behind the confirm button</summary>{bph}</details>' if bph else '')
            + '</div></section>')

    return (f'\n<article class="run" id="run-{e(label)}" data-label="{e(label)}" '
            f'data-when="{when:%Y-%m-%d %H:%M}" data-verdict="{e(verdict)}" '
            f'data-turns="{nturn}" data-secs="{total:.0f}">\n'
            f'<h3>{e(label)} <span class="tag d">{when:%Y-%m-%d %H:%M %Z}</span>'
            f'<span class="tag t">{total:.1f}s total</span>'
            f'<span class="tag t">{nturn} turn{"s" if nturn != 1 else ""}</span>'
            f'<span class="tag v-{ "ok" if verdict=="readable" else "bad" }">{e(verdict)}</span></h3>\n'
            f'{block("Code state at this run", f"<p>{e(change)}</p>", "chg")}\n'
            f'{"".join(parts)}\n</article>\n')


ap = argparse.ArgumentParser()
ap.add_argument('run_dir')
ap.add_argument('--label', required=True)
ap.add_argument('--change', required=True)
ap.add_argument('--verdict', default='readable', choices=['readable', 'failed'])
a = ap.parse_args()

entry = render(a.run_dir, a.label, a.change, a.verdict)
src = open(LOG).read()
if MARKER not in src:
    sys.exit('append marker missing from the log')
open(LOG, 'w').write(src.replace(MARKER, MARKER + entry, 1))
print(f'appended "{a.label}" to {LOG}')
