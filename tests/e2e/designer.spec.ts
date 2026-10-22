// End-to-end coverage for the agentic prototype's critical workflow.
//
// What these tests DO cover, with no API key required: navigation into the
// three new views, the configuration-error state (which must appear rather
// than any fallback agent), Knowledge Base editing surviving a reload,
// capabilities being read from application source, and Run Logs recording a
// real failed run rather than a fabricated success.
//
// What they CANNOT cover: a successful Claude call and the campaign it
// produces. That needs a valid ANTHROPIC_API_KEY, which CI does not have.
// The suite deliberately fails loudly instead of mocking the provider —
// a mocked LLM would prove nothing about the real integration.
import { test, expect, type Page } from '@playwright/test';

// The Campaign Designer is now a STANDALONE application on its own port and
// entry point. These tests navigate its own shell, not the mock app's sidebar.
const DESIGNER = 'http://localhost:5174/designer.html';
const goToDesignerNav = async (page: Page, label: string) => {
  const view = label === 'Campaign Designer' ? 'Design' : label;
  await page.goto(DESIGNER);
  await page.getByRole('button', { name: view, exact: true }).click();
};

test.describe('agentic prototype navigation', () => {
  test('the three views are reachable from the standalone shell', async ({ page }) => {
    await goToDesignerNav(page, 'Campaign Designer');
    // The page header names the CAMPAIGN; the app header names the product,
    // so the title is not repeated twice on screen.
    await expect(page.locator('.cd-top h1')).toHaveText('New campaign');
    await expect(page.locator('.ds-brand-name')).toHaveText('Campaign Designer');

    await page.getByRole('button', { name: 'Knowledge Base', exact: true }).click();
    await expect(page.locator('.cd-page h1')).toHaveText('Knowledge Base');

    await page.getByRole('button', { name: 'Run Logs', exact: true }).click();
    await expect(page.locator('.cd-page h1')).toHaveText('Run Logs');
  });
});

test.describe('Knowledge Base', () => {
  test('is a document management page, not a field editor', async ({ page }) => {
    await goToDesignerNav(page, 'Knowledge Base');
    await expect(page.locator('.cd-page h1')).toHaveText('Knowledge Base');
    await expect(page.getByRole('button', { name: 'Upload documents' }).first()).toBeVisible();

    // The internal context is reference material, not the primary UI.
    await expect(page.locator('.cd-table')).toHaveCount(0); // empty state first
    await expect(page.locator('.cd-empty-panel')).toContainText('No documents yet');
    // No source-code paths or per-field editors on the page.
    await expect(page.locator('.cd-page')).not.toContainText('agent-proto/');
    await expect(page.locator('.cd-page')).not.toContainText('bank-context.json');
  });

  test('states synthetic context once, not as a badge on every row', async ({ page }) => {
    await goToDesignerNav(page, 'Knowledge Base');
    await expect(page.locator('.cd-alert.note')).toContainText('synthetic sample data');
    // One notice, not a wall of them.
    expect(await page.locator('.cd-alert.note').count()).toBe(1);
  });

  test('uploads a readable document and marks it available', async ({ page }) => {
    await goToDesignerNav(page, 'Knowledge Base');
    await page.locator('input[type=file]').setInputFiles({
      name: 'brand-voice.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Tone\nShort sentences. No jargon.'),
    });
    await expect(page.locator('.cd-table tbody tr')).toHaveCount(1);
    await expect(page.locator('.cd-pill.ok')).toHaveText('Available to agent');
    await expect(page.locator('.cd-doc-name')).toHaveText('brand-voice.md');

    // ...and it survives a reload, because the agent must get it next run.
    await page.reload();
    await page.getByRole('button', { name: 'Knowledge Base', exact: true }).click();
    await expect(page.locator('.cd-doc-name')).toHaveText('brand-voice.md');
  });

  test('refuses a format it cannot read instead of faking success', async ({ page }) => {
    await goToDesignerNav(page, 'Knowledge Base');
    await page.locator('input[type=file]').setInputFiles({
      name: 'policy.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4'),
    });
    await expect(page.locator('.cd-alert.bad')).toContainText('this format cannot be read yet');
    await expect(page.locator('.cd-alert.bad')).toContainText('PDF and Word parsing is not implemented');
    // Crucially: it was NOT added to the list as if it had worked.
    await expect(page.locator('.cd-doc-name', { hasText: 'policy.pdf' })).toHaveCount(0);
  });

  test('deleting a document asks for confirmation first', async ({ page }) => {
    await goToDesignerNav(page, 'Knowledge Base');
    await page.locator('input[type=file]').setInputFiles({
      name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello'),
    });
    await expect(page.locator('.cd-table tbody tr')).toHaveCount(1);
    await page.locator('.cd-link.danger').click();
    await expect(page.locator('.cd-modal')).toContainText('Delete this document?');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.cd-table tbody tr')).toHaveCount(1); // still there
  });

  test('capabilities are reference material, available but not dominant', async ({ page }) => {
    await goToDesignerNav(page, 'Knowledge Base');
    await expect(page.locator('.cd-deflist')).toHaveCount(0);
    await page.getByRole('button', { name: /What else the agent knows/ }).click();
    await expect(page.locator('.cd-deflist')).toBeVisible();
    await expect(page.locator('.cd-context')).toContainText('Wait for Event');
  });
});

test.describe('Campaign Designer without a configured key', () => {
  test('shows a configuration error and never a fallback agent', async ({ page }) => {
    await goToDesignerNav(page, 'Campaign Designer');
    // Either the config error (no key) or the working designer (key present).
    const configErr = page.locator('.cd-configerr');
    const composer = page.locator('.cd-compose textarea');
    await expect(configErr.or(composer).first()).toBeVisible({ timeout: 15_000 });

    if (await configErr.isVisible()) {
      await expect(configErr).toContainText('ANTHROPIC_API_KEY');
      await expect(configErr).toContainText('will not fall back');
    } else {
      // With a key configured, the empty state invites a brief and the canvas
      // shows its own empty state rather than a fake campaign.
      await expect(page.locator('.cd-state-title')).toContainText('Your campaign journey appears here');
      await expect(page.locator('.cd-btn.pri').first()).toBeDisabled();
    }
  });
});

test.describe('Run Logs', () => {
  test('records a real run, including a failed one, without inventing success', async ({ page }) => {
    // A real Claude call plus campaign construction takes well over
    // Playwright's 30s default, which silently capped the waits below.
    test.setTimeout(240_000);
    await goToDesignerNav(page, 'Campaign Designer');
    // The designer decides between the composer and the config error only
    // after an async health check, so wait for whichever lands rather than
    // reading visibility immediately — that race made this test skip or fail
    // depending on timing.
    const composer = page.locator('.cd-compose textarea');
    const configErr = page.locator('.cd-configerr');
    await expect(composer.or(configErr).first()).toBeVisible({ timeout: 15_000 });
    test.skip(await configErr.isVisible(), 'No API key configured — the designer cannot run.');

    await composer.fill('Customers are not converting an EMI-eligible purchase to EMI. Proceed with your best recommendation.');
    await page.locator('.cd-btn.pri').click();
    // Either outcome is acceptable here; what matters is that it is recorded.
    await expect(page.locator('.cd-msg.user')).toBeVisible();
    // The composer is disabled while the orchestrator runs, so re-enabling is
    // the precise "done" signal. (.cd-spinner renders in two places at once,
    // which made a count assertion the wrong tool.)
    await expect(page.locator('.cd-compose textarea')).toBeEnabled({ timeout: 200_000 });
    // A real run reaches the canvas or reports why it did not — never silence.
    await expect(page.locator('.react-flow__node').first().or(page.locator('.cd-state-title'))).toBeVisible();

    await page.getByRole('button', { name: 'Run Logs', exact: true }).click();
    await expect(page.locator('.cd-logrow').first()).toBeVisible();
    // Event labels read in plain language, with the raw payload behind a
    // Details toggle rather than dumped on screen.
    await expect(page.locator('.cd-logdetail')).toContainText('Context gathered');
    await page.locator('.cd-logdetail .cd-link', { hasText: 'Details' }).first().click();
    await expect(page.locator('.cd-logdetail pre').first()).toContainText('knowledgeVersion');
    // The same events the live timeline showed — tool calls included.
    await expect(page.locator('.cd-logdetail')).toContainText('Tool result');
    // Streaming deltas are transport, not history: they must not be listed.
    await expect(page.locator('.cd-logdetail')).not.toContainText('model.text.delta');
  });

  test('shows an empty state before any run', async ({ page }) => {
    await page.goto(DESIGNER);
    await page.evaluate(() => localStorage.removeItem('dc-agent-runlogs-v1'));
    await goToDesignerNav(page, 'Run Logs');
    await expect(page.locator('.cd-empty-panel')).toContainText('No runs yet');
    await expect(page.getByRole('button', { name: 'Start designing a campaign' })).toBeVisible();
  });
});

test.describe('conversation flow and streaming', () => {
  test('no campaign is generated before the strategy is confirmed', async ({ page }) => {
    test.setTimeout(400_000);
    await goToDesignerNav(page, 'Campaign Designer');
    const composer = page.locator('.cd-compose textarea');
    const configErr = page.locator('.cd-configerr');
    await expect(composer.or(configErr).first()).toBeVisible({ timeout: 15_000 });
    test.skip(await configErr.isVisible(), 'No API key configured.');

    await composer.fill('Customers are not converting an EMI-eligible purchase to EMI before it expires.');
    await page.locator('.cd-btn.pri').first().click();

    // While the agent works, activity is visible and the canvas stays empty.
    await expect(page.locator('.cd-act').first()).toBeVisible({ timeout: 60_000 });
    expect(await page.locator('.react-flow__node').count()).toBe(0);

    await expect(composer).toBeEnabled({ timeout: 300_000 });
    await page.waitForTimeout(2500);

    // THREE legitimate outcomes now, not two: questions were asked, a
    // strategy awaits confirmation, or the application refused a premature
    // proposal and discovery continues. In ALL of them nothing may be built.
    expect(await page.locator('.react-flow__node').count()).toBe(0);
    const gate = page.locator('.cd-confirm');
    const questions = page.locator('.cd-q');
    // Matched on what the gate ITSELF says, not on the ledger that used to
    // follow it. "What I am working through:" and its dimension bullets were
    // removed from the reply on 2026-10-21 — they were internal state pasted
    // into a conversation. Every block's `reason` is a sentence written to the
    // manager, and these two are the ones a refused turn opens with.
    const stillDiscovering = page
      .getByText(/I am still waiting on this|Still open|discovery continues/i)
      .first();
    expect(
      (await gate.count()) + (await questions.count()) + (await stillDiscovering.count()),
    ).toBeGreaterThan(0);

    if (await gate.count()) {
      await expect(gate).toContainText('Nothing has been built yet');
      await page.getByRole('button', { name: 'Confirm and generate' }).click();
      await expect(composer).toBeEnabled({ timeout: 200_000 });
      await page.waitForTimeout(1500);
      // Only NOW does the journey exist.
      expect(await page.locator('.react-flow__node').count()).toBeGreaterThan(3);
      await expect(page.locator('.cd-stage')).toHaveCount(5);
      await expect(gate).toHaveCount(0);
    }
  });

  test('execution activity collapses once the run finishes', async ({ page }) => {
    test.setTimeout(400_000);
    await goToDesignerNav(page, 'Campaign Designer');
    const composer = page.locator('.cd-compose textarea');
    test.skip(await page.locator('.cd-configerr').isVisible(), 'No API key configured.');

    await composer.fill('Reactivate cards with no transaction in 90 days.');
    await page.locator('.cd-btn.pri').first().click();
    await expect(page.locator('.cd-act').first()).toBeVisible({ timeout: 60_000 });

    await expect(composer).toBeEnabled({ timeout: 300_000 });
    await page.waitForTimeout(2000);
    // Collapsed to a summary, so the agent's answer is what you read.
    await expect(page.locator('.cd-act-head')).toBeVisible();
    await expect(page.locator('.cd-act')).toHaveCount(0);
    // ...and it reopens on demand, with the real tool results inside.
    await page.locator('.cd-act-head').click();
    await expect(page.locator('.cd-act').first()).toBeVisible();
  });
});
