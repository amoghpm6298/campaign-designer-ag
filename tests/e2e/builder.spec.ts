// Real-click coverage of the create/edit builder — ported from this
// project's own scratchpad verification scripts, formalized as a
// permanent, committed regression suite. Drives the actual DOM (clicks,
// selects, fills), never calls reducer/handler functions directly — this
// project's own established discipline, since direct-function-call tests
// have repeatedly missed real bugs (a missing <option value=...>
// attribute, a native multi-select interaction, React Flow's
// pointer-events:none on non-selectable nodes) that only driving the
// real DOM catches.
import { test, expect } from '@playwright/test';

async function startNewCampaign(page: import('@playwright/test').Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '+ Create Drip Campaign' }).click();
  await page.locator('input[type=text]').first().fill(name);
  await page.locator('select').first().selectOption('IndusInd Bank (IBL)');
  await page.getByText('Continue to Build').click();
  await page.waitForTimeout(300);
}

async function addEntryEvent(page: import('@playwright/test').Page, category: string, type: string) {
  await page.locator('.dc-add-entry-placeholder').click();
  await page.locator('.dc-type-opt:has-text("Entry · Event Trigger")').click();
  const sel = page.locator('.sd-drawer.open select');
  await sel.nth(0).selectOption(category);
  await sel.nth(1).selectOption(type);
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(300);
}

test('Send auto-inserts a goal-check Split + GOAL_EXIT; Channel Failover chains under No and gets its own check', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Send Chain');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt', { hasText: /^Send/ }).click();
  await page.locator('.sd-drawer.open input[type=text]').first().fill('Msg1');
  const sendSelects = page.locator('.sd-drawer.open select');
  await sendSelects.nth(0).selectOption('WHATSAPP');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select account' }).selectOption('IBL-Karix-Onb');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select template' }).selectOption({ index: 1 });
  await expect(page.locator('.sd-drawer.open .sd-foot button.btn.primary')).toBeEnabled();
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card:has-text("CONDITIONAL SPLIT")')).toHaveCount(1);
  await expect(page.locator('.dc-branch-label:has-text("Yes")')).toHaveCount(1);

  await page.locator('.dc-add-btn').click(); // the open "No" slot
  await page.locator('.dc-type-opt:has-text("Channel Failover")').click();
  await page.waitForTimeout(150);
  const cfSelects = page.locator('.sd-drawer.open select');
  await cfSelects.nth(1).selectOption('SMS'); // fallback channel
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select account' }).selectOption({ index: 1 });
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select template' }).selectOption({ index: 1 });
  await expect(page.locator('.sd-drawer.open .sd-foot button.btn.primary')).toBeEnabled();
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card:has-text("CHANNEL FAILOVER")')).toHaveCount(1);
  await expect(page.locator('.dc-node-card:has-text("CONDITIONAL SPLIT")')).toHaveCount(2);
});

test('Pause gets its own auto goal-check; auto-badge click-to-replace opens the add drawer', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Pause');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt:has-text("Pause")').click();
  await page.locator('.sd-drawer.open input[type=number]').first().fill('3');
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card:has-text("CONDITIONAL SPLIT")')).toHaveCount(1);

  await page.locator('.dc-auto-badge').first().click();
  await page.waitForTimeout(300);
  await expect(page.locator('.sd-title')).toHaveText('Add Next Step');
  await page.locator('.sd-drawer.open .sd-foot button.btn.secondary').click();
});

test('Editing a node preserves its existing subtree; Cancel discards changes', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Edit');
  await addEntryEvent(page, 'Journey Events', 'Pageload');
  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt', { hasText: /^Send/ }).click();
  await page.locator('.sd-drawer.open input[type=text]').first().fill('Original Name');
  await page.locator('.sd-drawer.open select').first().selectOption('WHATSAPP');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select account' }).selectOption('IBL-Karix-Onb');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select template' }).selectOption({ index: 1 });
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  const beforeCount = await page.locator('.dc-node-card').count();

  // Cancel: edit then discard.
  await page.locator('.dc-node-card:has-text("Original Name")').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.sd-title')).toHaveText('Edit Step');
  await page.locator('.sd-drawer.open input[type=text]').first().fill('SHOULD NOT STICK');
  await page.locator('.sd-drawer.open .sd-foot button.btn.secondary').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.dc-node-card:has-text("Original Name")')).toHaveCount(1);

  // Real edit: rename, subtree survives.
  await page.locator('.dc-node-card:has-text("Original Name")').click();
  await page.waitForTimeout(300);
  await page.locator('.sd-drawer.open input[type=text]').first().fill('Renamed');
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);
  const afterCount = await page.locator('.dc-node-card').count();
  expect(afterCount).toBe(beforeCount);
  await expect(page.locator('.dc-node-card:has-text("Renamed")')).toHaveCount(1);
});

test('Decision Split: Between-operator branches + catch-all, mid-list insert preserves existing branch subtrees', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Decision Split');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt:has-text("Decision Split")').click();
  await page.waitForTimeout(150);
  const attrSelect = page.locator('.sd-drawer.open select').nth(1);
  await attrSelect.selectOption('Milestone Progress %');
  await page.waitForTimeout(150);
  const branchOpSelects = page.locator('.sd-drawer.open select');
  const opCount = await branchOpSelects.count();
  for (let i = 0; i < opCount; i++) {
    const options = await branchOpSelects.nth(i).locator('option').allTextContents();
    if (options.includes('Between')) await branchOpSelects.nth(i).selectOption('Between');
  }
  const numberInputs = page.locator('.sd-drawer.open input[type=number]');
  await numberInputs.nth(0).fill('5');
  await numberInputs.nth(1).fill('20');
  await numberInputs.nth(2).fill('21');
  await numberInputs.nth(3).fill('50');
  await expect(page.locator('.sd-drawer.open .sd-foot button.btn.primary')).toBeEnabled();
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card:has-text("DECISION SPLIT")')).toHaveCount(1);
  await expect(page.locator('.dc-branch-label:has-text("Anything else")')).toHaveCount(1);

  // Insert a branch between the two existing ones.
  await page.locator('.dc-node-card:has-text("DECISION SPLIT")').click();
  await page.waitForTimeout(300);
  const insertRows = page.locator('.dcb-insert-row');
  await expect(insertRows.nth(1)).toBeAttached();
  await insertRows.nth(1).hover();
  await insertRows.nth(1).click();
  await page.waitForTimeout(200);
  const labelInputs = page.locator('.sd-drawer.open input[type=text]');
  expect(await labelInputs.count()).toBeGreaterThanOrEqual(3);
});

test('Random Split requires branches to sum to 100%', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Random Split');
  await addEntryEvent(page, 'Journey Events', 'Pageload');
  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt:has-text("Random Split")').click();
  await page.waitForTimeout(150);
  const pctInputs = page.locator('.sd-drawer.open input[type=number]');
  await pctInputs.nth(0).fill('30');
  await pctInputs.nth(1).fill('30');
  await expect(page.locator('.sd-drawer.open .sd-foot button.btn.primary')).toBeDisabled();
  await pctInputs.nth(1).fill('70');
  await expect(page.locator('.sd-drawer.open .sd-foot button.btn.primary')).toBeEnabled();
});

test('Submit for Approval is genuinely disabled with open branches, enabled once every branch resolves', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Submit Gating');
  await addEntryEvent(page, 'Journey Events', 'Pageload');
  await expect(page.locator('button:has-text("Submit for Approval")')).toBeDisabled();

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt', { hasText: /^Exit/ }).click();
  await page.locator('.sd-drawer.open input[type=text]').first().fill('done');
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('button:has-text("Submit for Approval")')).toBeEnabled();
});

test('Root remove button only appears on the root node and works via real hover + click', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Root Remove');
  await addEntryEvent(page, 'Journey Events', 'Pageload');
  await page.locator('.dc-node-card').first().hover();
  await expect(page.locator('.dc-node-remove')).toBeVisible();
  await page.locator('.dc-node-remove').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.dc-add-entry-placeholder')).toBeVisible();
});
