// Screenshot every Campaign Designer screen, from recorded runs.
//
// WHY THIS EXISTS. "Looks broken" in a UI is a geometry question, and this
// repo has twice fixed the wrong thing by reasoning about a screenshot
// instead of measuring it (the parallel-path label, the Journey tab's dead
// gutter). Judging a screen means looking at the rendered pixels, and doing
// that reliably means the screens have to be reproducible without a model
// call, an API key, or clicking through four turns by hand.
//
// It replays `eval/runs/<id>/turns/turn-N.json` into the SSE endpoint, in
// the exact frame format `server/apiPlugin.ts` writes and `stream.ts`
// parses, so what renders is what the server really produced on that turn.
// Everything else — health, tenants, knowledge — is served by the real dev
// plugin, because mocking those put the app into its config-error screen and
// cost an hour the first time.
//
//   npm run ux:shots                 every screen, 1440×900, into .ux-shots/
//   npm run ux:shots -- --width 1280 the laptop a demo actually runs on
//   npm run ux:shots -- --only 03    one screen while iterating
//
// The dev server must already be up:  npm run dev:designer
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const OUT = resolve(REPO, arg('--out', '.ux-shots'));
const PORT = arg('--port', '5174');
const WIDTH = Number(arg('--width', '1440'));
const HEIGHT = Number(arg('--height', '900'));
const ONLY = arg('--only', '');
const DESIGNER = `http://localhost:${PORT}/designer.html`;

/**
 * Screens worth a picture, each the state a client actually sees.
 *
 * A run id plus a turn number, not a hand-built fixture: a screen that only
 * exists in a fixture is a screen nobody has shipped. `eval/runs/` is
 * gitignored, so a missing run is skipped with a line rather than a crash.
 */
const SCREENS = [
  { id: '01-start', what: 'Nothing typed yet — the first thing a client sees.' },
  { id: '02-brief', what: 'Discovery: the agent is asking.', run: 'ui-s-1793613837789', turn: 1 },
  { id: '03-plan', what: 'A plan on the table, Confirm live.', run: 'ui-s-1792843757296', turn: 4 },
  { id: '04-built', what: 'The journey on the canvas.', run: 'ui-s-1792843757296', turn: 5 },
  { id: '05-chats', what: 'Past conversations.', nav: 'Chats' },
  { id: '06-knowledge', what: 'What the agent knows about this bank.', nav: 'Knowledge Base' },
];

const frames = (turn) =>
  [
    ...(turn.events ?? []).map((e) => `event: event\ndata: ${JSON.stringify(e)}\n\n`),
    `event: result\ndata: ${JSON.stringify(turn.response)}\n\n`,
  ].join('');

const OBJECTIVE = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
let shot = 0;

for (const screen of SCREENS) {
  if (ONLY && !screen.id.startsWith(ONLY)) continue;

  let body = null;
  if (screen.run) {
    try {
      body = frames(JSON.parse(readFileSync(`${REPO}/eval/runs/${screen.run}/turns/turn-${screen.turn}.json`, 'utf8')));
    } catch {
      console.log(`skip ${screen.id} — eval/runs/${screen.run} is not in this clone`);
      continue;
    }
  }

  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  // ONLY the run is faked. Health, tenants and knowledge come from the real
  // plugin — stubbing them lands the app on its configuration-error screen.
  if (body) {
    await page.route('**/api/designer/stream', (r) =>
      r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body }),
    );
  }

  await page.goto(DESIGNER, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  if (screen.nav) {
    // By role and label, not by class. `.hf-rail` was the navy rail's own
    // class and went with it in the agent360 port; a selector pinned to a
    // class name breaks on a restyle that changed no behaviour.
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: screen.nav, exact: true })
      .click();
    await page.waitForTimeout(800);
  }
  if (body) {
    await page.locator('textarea').first().fill(OBJECTIVE);
    await page.getByRole('button', { name: /^Design campaign$/ }).first().click();
    await page.waitForTimeout(3000);
  }

  const file = `${OUT}/${screen.id}-${WIDTH}.png`;
  await page.screenshot({ path: file, fullPage: false });
  // The fold is the point: a decision below it is a decision nobody makes.
  // Full-page too, so nothing that scrolled away goes unexamined.
  await page.screenshot({ path: `${OUT}/${screen.id}-${WIDTH}-full.png`, fullPage: true });
  console.log(`${screen.id}  ${screen.what}\n          ${file}`);
  shot += 1;
  await ctx.close();
}

await browser.close();
if (!shot) {
  console.error(`No screens shot. Is the designer running on ${PORT}?  npm run dev:designer`);
  process.exit(1);
}
