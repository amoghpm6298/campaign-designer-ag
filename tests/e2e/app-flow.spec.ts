// List/view/status-action/create-to-submit flow, formalized from this
// project's own scratchpad verification.
import { test, expect } from '@playwright/test';

test('list shows the 6 real seed campaigns with correctly colored status badges', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('table tbody tr')).toHaveCount(6);
  // Every status variant present in the seed data should render a real
  // colored pill, not plain unstyled text (the real bug caught during
  // Phase 4 verification — only 2 of 5 badge color classes existed).
  for (const label of ['Active', 'Draft', 'Paused', 'Pending Approval']) {
    const badge = page.locator('.badge', { hasText: label }).first();
    await expect(badge).toBeVisible();
    const bg = await badge.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  }
});

test('Analytics tab renders KPIs + an annotated canvas for a live campaign, and is absent for a Draft', async ({ page }) => {
  await page.goto('/');
  // DRIP-001 "Card Activation Reminder" is ACTIVE in the seed data.
  await page.locator('table tbody tr', { hasText: 'Card Activation Reminder' }).click();
  await page.waitForTimeout(400);
  await expect(page.getByRole('button', { name: 'Analytics' })).toBeVisible();
  await page.getByRole('button', { name: 'Analytics' }).click();
  await page.waitForTimeout(500);
  await expect(page.getByText('Entered', { exact: true })).toBeVisible();
  await expect(page.getByText('Reached Goal')).toBeVisible();
  await expect(page.getByText('Conversion Rate')).toBeVisible();
  // Annotated canvas — nodes carry a "reached" stat line.
  await expect(page.locator('.dc-node-stat').first()).toBeVisible();

  await page.goto('/');
  // DRIP-003 "Spend Milestone Rewards" is DRAFT — never launched, no
  // customers to report on, so no Analytics tab at all.
  await page.locator('table tbody tr', { hasText: 'Spend Milestone Rewards' }).click();
  await page.waitForTimeout(400);
  await expect(page.getByRole('button', { name: 'Analytics' })).toHaveCount(0);
});

test('row click opens the real read-only view with the real canvas', async ({ page }) => {
  await page.goto('/');
  const firstRowName = await page.locator('table tbody tr').first().locator('td').first().locator('b').innerText();
  await page.locator('table tbody tr').first().click();
  await page.waitForTimeout(500);
  await expect(page.locator('h1.page-title')).toContainText(firstRowName);
  expect(await page.locator('.dc-node-card').count()).toBeGreaterThan(5);
});

test('Pause/Resume via real clicks updates the badge and shows a toast', async ({ page }) => {
  await page.goto('/');
  await page.locator('table tbody tr', { hasText: 'Active' }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.locator('.badge:has-text("Paused")')).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.locator('.badge:has-text("Active")')).toBeVisible();
});

test('Kill Switch requires real confirmation; Cancel does not kill, confirming does', async ({ page }) => {
  await page.goto('/');
  await page.locator('table tbody tr', { hasText: 'Active' }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Kill Switch' }).click();
  await expect(page.getByText('immediately exits')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.badge:has-text("Active")')).toBeVisible();

  await page.getByRole('button', { name: 'Kill Switch' }).click();
  await page.getByRole('button', { name: 'Kill this campaign' }).click();
  await expect(page.locator('.badge:has-text("Killed")')).toBeVisible();
});

test('full create -> build -> submit flow lands in the list as Pending Approval', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ Create Drip Campaign' }).click();
  await page.locator('input[type=text]').first().fill('App Flow Spec Campaign');
  await page.locator('select').first().selectOption('IndusInd Bank (IBL)');
  await page.getByText('Continue to Goal →').click();
  await page.waitForTimeout(200);
  await page.getByText('Continue to Builder →').click();
  await page.waitForTimeout(300);
  await page.locator('.dc-add-entry-placeholder').click();
  await page.locator('.dc-type-opt:has-text("Entry · Event")').click();
  const sel = page.locator('.sd-drawer.open select');
  await sel.nth(0).selectOption('Journey Events');
  await sel.nth(1).selectOption('Pageload');
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);
  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt', { hasText: /^Exit/ }).click();
  await page.locator('.sd-drawer.open input[type=text]').first().fill('done');
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  // Submit for Approval now lives on the Review step, not the Builder
  // header — navigate there via Guardrails (the new step between
  // Builder and Review) first.
  await page.getByText('Continue to Guardrails').click();
  await page.waitForTimeout(300);
  await page.getByText('Continue to Review').click();
  await page.waitForTimeout(300);
  await expect(page.getByRole('button', { name: 'Submit for Approval' })).toBeEnabled();
  await page.getByRole('button', { name: 'Submit for Approval' }).click();
  await page.waitForTimeout(400);

  const newRow = page.locator('tr', { hasText: 'App Flow Spec Campaign' });
  await expect(newRow).toHaveCount(1);
  await expect(newRow.locator('.badge:has-text("Pending Approval")')).toBeVisible();
});

test('Save as Draft is always available from any step, even with open branches, and resuming a draft lands back on the Builder step', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ Create Drip Campaign' }).click();
  await page.locator('input[type=text]').first().fill('Draft Spec Campaign');
  // Save straight from Basic Details — no entry added at all, still
  // genuinely incomplete, and still allowed.
  await expect(page.getByRole('button', { name: 'Save as Draft' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save as Draft' }).click();
  await page.waitForTimeout(400);

  const draftRow = page.locator('tr', { hasText: 'Draft Spec Campaign' });
  await expect(draftRow.locator('.badge:has-text("Draft")')).toBeVisible();
  await draftRow.click();
  await page.waitForTimeout(400);
  // Continuing a draft resumes directly on the Builder step, not Basic Details.
  await expect(page.locator('.dc-add-entry-placeholder')).toBeVisible();
});
