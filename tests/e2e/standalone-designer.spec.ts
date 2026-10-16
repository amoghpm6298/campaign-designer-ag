// The standalone Campaign Designer: its own entry point, shell and tenant
// selector, with no dependency on ib-face-mock.html.
import { test, expect } from '@playwright/test';

const DESIGNER = 'http://localhost:5174/designer.html';

test.describe('standalone application', () => {
  test('loads directly, without ib-face-mock or Communication Hub', async ({ page }) => {
    await page.goto(DESIGNER);
    await expect(page.locator('.ds-brand-name')).toHaveText('Campaign Designer');
    // Its own shell — none of the mock app's chrome.
    await expect(page.locator('#sidebar')).toHaveCount(0);
    await expect(page.getByText('Communication Hub')).toHaveCount(0);
  });

  test('has its own navigation across all three views', async ({ page }) => {
    await page.goto(DESIGNER);
    await page.locator('.ds-nav').getByRole('button', { name: 'Knowledge Base' }).click();
    await expect(page.locator('.cd-page h1')).toHaveText('Knowledge Base');
    await page.locator('.ds-nav').getByRole('button', { name: 'Run Logs' }).click();
    await expect(page.locator('.cd-page h1')).toHaveText('Run Logs');
    await page.locator('.ds-nav').getByRole('button', { name: 'Design', exact: true }).click();
    await expect(page.locator('.ds-brand-name')).toHaveText('Campaign Designer');
  });
});

test.describe('global tenant selector', () => {
  test('is present, labels synthetic tenants, and persists across reloads', async ({ page }) => {
    await page.goto(DESIGNER);
    const select = page.locator('.ds-tenant select');
    await expect(select).toBeVisible();
    await expect(page.locator('.ds-synth')).toHaveText('Synthetic');
    // Every option says so, so no one mistakes it for a real bank.
    for (const opt of await select.locator('option').allTextContents()) {
      expect(opt).toMatch(/Synthetic/);
    }

    await select.selectOption('TEN-YES');
    await page.reload();
    await expect(page.locator('.ds-tenant select')).toHaveValue('TEN-YES');
  });

  test('is available on every view', async ({ page }) => {
    await page.goto(DESIGNER);
    for (const view of ['Knowledge Base', 'Run Logs', 'Design']) {
      await page.locator('.ds-nav').getByRole('button', { name: view, exact: true }).click();
      await expect(page.locator('.ds-tenant select')).toBeVisible();
    }
  });

  test('scopes the Knowledge Base to the selected tenant', async ({ page }) => {
    await page.goto(DESIGNER);
    await page.locator('.ds-tenant select').selectOption('TEN-IBL');
    await page.locator('.ds-nav').getByRole('button', { name: 'Knowledge Base' }).click();
    // Scope target and the context notice both follow the selected tenant.
    await expect(page.locator('.cd-upload-bar')).toContainText('IndusInd Bank (IBL) — Synthetic');
    await expect(page.locator('.cd-alert.note')).toContainText('IndusInd Bank (IBL)');

    // Template access is reference detail, so it lives in the disclosure.
    await page.getByRole('button', { name: /What else the agent knows/ }).click();
    await expect(page.locator('.cd-context')).toContainText('not reachable from Hyperface');

    await page.locator('.ds-tenant select').selectOption('TEN-DEMO');
    await expect(page.locator('.cd-context')).toContainText('sample demo library');
  });
});

test.describe('the mock application no longer exposes the designer', () => {
  test('Communication Hub has no Campaign Designer entries', async ({ page }) => {
    await page.goto('http://localhost:5183/drip-campaigns/');
    const items = await page.locator('.sb-sub-item').allTextContents();
    expect(items.join(' ')).not.toContain('Campaign Designer');
    expect(items.join(' ')).not.toContain('Knowledge Base');
    expect(items.join(' ')).not.toContain('Run Logs');
    // ...and the existing builder still works.
    await expect(page.locator('#dc-main')).toContainText('Drip Campaigns');
    await page.locator('#newCampaignBtn').click();
    await expect(page.locator('#dc-main')).toContainText('Basic Details');
  });
});
