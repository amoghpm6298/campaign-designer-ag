# Campaign Designer — the pages sales sends

Two artefacts, built here so they survive the session that made them. They
used to live in a conversation scratchpad, which meant the page could be
published and then become uneditable as soon as that directory was cleaned
up.

| File | Who reads it |
| --- | --- |
| `campaign-designer-sales.html` | **Clients.** The landing page. |
| `campaign-designer-internal.html` | **Sales, internally.** Positioning, the competitor table, the demo script, the do-not-say list. Never send this one out. |

## Changing the client page

Edit **`cd-sales.tpl.html`**, then:

```bash
python3 sales/build.py
```

That rewrites `campaign-designer-sales.html`. Do not edit the built file —
it is 1.1 MB of inlined assets and the next build overwrites it.

The build refuses to produce a page that still contains a `{{PLACEHOLDER}}`,
or that mentions a competitor by name or the phrase "Presenter mode". Those
belong in the internal brief.

## Why everything is inlined

The published page runs under a strict CSP that blocks every external host:
CDN scripts, stylesheets, fonts, remote images. A linked font does not error,
it silently falls back — which is how a page that looked right locally
shipped in the wrong typeface. So the fonts, the logo, the diagrams and the
product screenshots are all base64 inside `assets/assets.json`.

That file is 1.7 MB and the built page is 1.1 MB. The source JPEGs are not
kept here: they are regenerable from the designer with `npm run ux:shots`,
and storing both a picture and its base64 is storing it twice.

## Publishing

Republishing from this folder updates the artifact it was last published to.
Check the URL before you publish if you are not sure which one that is — a
different id is a different page, and the client may be looking at the other
one.
