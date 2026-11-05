#!/usr/bin/env python3
"""Build the client-facing Campaign Designer landing page.

    python3 sales/build.py        # from anywhere; paths are relative to THIS file

Reads `cd-sales.tpl.html` and inlines every asset, producing a single
self-contained `campaign-designer-sales.html`. Self-contained is a hard
requirement rather than a preference: the published page runs under a strict
CSP that blocks every external host, so a linked font or a remote image is a
silent fallback rather than an error.

MOVED OUT OF THE SCRATCHPAD, 2026-11-04. All four inputs used to live in a
session temp directory — `/tmp/ux/a/assets.json`, `/tmp/ux/twoway.svg`,
`/tmp/ux/mock.html` and the template — so the page could be published and
then become uneditable the moment that directory was cleaned up. Everything
it needs is in this folder now.

`assets.json` holds the fonts, the logo and the product screenshots already
base64'd, which is why it is 1.7 MB and the built page is 1.1 MB. The source
JPEGs are not kept: they are regenerable from the designer with
`npm run ux:shots`, and storing both a picture and its base64 is storing it
twice.
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
A = HERE / 'assets'

a = json.loads((A / 'assets.json').read_text())
s = (HERE / 'cd-sales.tpl.html').read_text()

# The two-route diagram sits in a LIGHT section, so it keeps its light
# palette; only its font is swapped to the one the page actually loads.
tw = (A / 'twoway.svg').read_text().replace('font-family="InterVar,sans-serif"', 'font-family="UncutSans,Inter,sans-serif"')

for k, v in [
    ('{{FONT_R}}', a['font-r']), ('{{FONT_M}}', a['font-m']), ('{{LOGO}}', a['logo-dark']),
    ('{{ILL}}', a['hero-ill']), ('{{LOOP}}', a['loop']), ('{{TWOWAY}}', tw),
    ('{{MOCK}}', (A / 'mock.html').read_text()),
    ('{{F0}}', a['f0-context']), ('{{F1}}', a['f1-discovery']), ('{{F2}}', a['f2-plan']),
    ('{{F2B}}', a['f2b-confirm']), ('{{F3B}}', a['f3b-wizard']), ('{{F4}}', a['f4-analytics']),
]:
    s = s.replace(k, v)

# A placeholder that survived means an asset key was renamed and the page
# would publish with `{{F2}}` on screen.
assert '{{' not in s, s[s.index('{{'):s.index('{{') + 30]

# THIS PAGE GOES TO CLIENTS. The competitor names belong in the internal
# brief and nowhere near it, and "Presenter mode" is an internal phrase.
for bad in ['MoEngage', 'CleverTap', 'Braze', 'Presenter mode']:
    assert bad.lower() not in s.lower(), 'LEAK ' + bad

out = HERE / 'campaign-designer-sales.html'
out.write_text(s)

body = re.sub(r'<script.*?</script>|<style.*?</style>', '', s, flags=re.S)
print(f'{out.name}: {len(s) // 1024} KB · {len(re.sub(r"<[^>]+>", " ", body).split())} words')
