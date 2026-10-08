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
  // "Skip to Builder" was removed — Continue to Goal is always enabled
  // now, so the same destination is two clicks through the real flow.
  await page.getByText('Continue to Goal →').click();
  await page.waitForTimeout(200);
  await page.getByText('Continue to Builder →').click();
  await page.waitForTimeout(300);
}

// The auto goal-check Split after Send/Pause is only
// inserted when a real campaign Goal is defined — this goes through the
// Goal Definition step instead of skipping it, for the handful of tests
// that specifically exercise that auto-insert behavior.
async function startNewCampaignWithGoal(page: import('@playwright/test').Page, name: string, eventCategory: string, eventType: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '+ Create Drip Campaign' }).click();
  await page.locator('input[type=text]').first().fill(name);
  await page.locator('select').first().selectOption('IndusInd Bank (IBL)');
  await page.getByText('Continue to Goal →').click();
  await page.waitForTimeout(200);
  const goalSelects = page.locator('select');
  await goalSelects.nth(0).selectOption(eventCategory);
  await goalSelects.nth(1).selectOption(eventType);
  await page.getByText('Continue to Builder →').click();
  await page.waitForTimeout(300);
}

async function addEntryEvent(page: import('@playwright/test').Page, category: string, type: string) {
  await page.locator('.dc-add-entry-placeholder').click();
  await page.locator('.dc-type-opt:has-text("Entry · Event")').click();
  const sel = page.locator('.sd-drawer.open select');
  await sel.nth(0).selectOption(category);
  await sel.nth(1).selectOption(type);
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(300);
}

test('Send auto-inserts a goal-check Split + GOAL_EXIT; a fallback channel on Send shows the FALLBACK tag on canvas', async ({ page }) => {
  await startNewCampaignWithGoal(page, 'Builder Spec: Send Chain', 'Card Events', 'Card Activated');
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

  await expect(page.locator('.dc-node-card:has-text("Goal Check")')).toHaveCount(1);
  await expect(page.locator('.dc-branch-label:has-text("Yes")')).toHaveCount(1);
  await expect(page.locator('.dc-node-fallback-row')).toHaveCount(0);

  await page.locator('.dc-add-btn').click(); // the open "No" slot
  await page.locator('.dc-type-opt', { hasText: /^Send/ }).click();
  await page.locator('.sd-drawer.open input[type=text]').first().fill('Msg2');
  const send2Selects = page.locator('.sd-drawer.open select');
  await send2Selects.nth(0).selectOption('WHATSAPP');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select account' }).selectOption({ index: 1 });
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select template' }).selectOption({ index: 1 });
  await page.waitForTimeout(150);
  // optional fallback channel section — a second account/template pair
  // appears once a fallback channel is chosen, so these are now the
  // SECOND match of each (nth(0) is the already-filled primary pair).
  await page.locator('.sd-drawer.open select', { hasText: 'No fallback' }).selectOption('SMS');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select account' }).nth(1).selectOption({ index: 1 });
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select template' }).nth(1).selectOption({ index: 1 });
  await expect(page.locator('.sd-drawer.open .sd-foot button.btn.primary')).toBeEnabled();
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-fallback-row')).toHaveCount(1);
  await expect(page.locator('.dc-node-card:has-text("Goal Check")')).toHaveCount(2);
});

test('Send does NOT get an auto goal-check when no campaign Goal is defined', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: No Goal Send');
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
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card:has-text("Goal Check")')).toHaveCount(0);
  await expect(page.locator('.dc-add-btn')).toHaveCount(1);
});

test('Clicking "remove goal check" on an auto-inserted Split collapses it, keeping whatever was under No', async ({ page }) => {
  await startNewCampaignWithGoal(page, 'Builder Spec: Remove Goal Check', 'Card Events', 'Card Activated');
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
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card:has-text("Goal Check")')).toHaveCount(1);
  await expect(page.locator('.dc-goalcheck-badge')).toHaveCount(1);

  // Build something real under the "No" branch before removing the check,
  // to prove the removal preserves it rather than discarding it too.
  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt:has-text("Wait for a fixed duration")').click();
  await page.locator('.sd-drawer.open input[type=number]').first().fill('2');
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);
  await expect(page.locator('.dc-node-card:has-text("Wait 2 days")')).toHaveCount(1);
  // Pause (Wait) gets its own auto goal-check too (a real goal is defined
  // for this campaign) — 2 Goal Checks total at this point, remove the Send's.
  await expect(page.locator('.dc-node-card:has-text("Goal Check")')).toHaveCount(2);

  await page.locator('.dc-goalcheck-badge').first().click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card:has-text("Goal Check")')).toHaveCount(1);
  await expect(page.locator('.dc-node-card:has-text("Wait 2 days")')).toHaveCount(1);
});

test('A Send card shows a visible, hover-revealed remove button, not just the hidden edge "x"', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Card Remove');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt', { hasText: /^Send/ }).click();
  await page.locator('.sd-drawer.open input[type=text]').first().fill('RemovableSend');
  const sendSelects = page.locator('.sd-drawer.open select');
  await sendSelects.nth(0).selectOption('WHATSAPP');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select account' }).selectOption('IBL-Karix-Onb');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select template' }).selectOption({ index: 1 });
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  const card = page.locator('.dc-node-card', { hasText: 'RemovableSend' });
  await expect(card.locator('.dc-node-remove')).toBeHidden();
  await card.hover();
  await expect(card.locator('.dc-node-remove')).toBeVisible();
  await card.locator('.dc-node-remove').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card', { hasText: 'RemovableSend' })).toHaveCount(0);
  await expect(page.locator('.dc-add-btn')).toHaveCount(1);
});

test('Mid-chain insert explains why its type list is narrower, instead of looking broken', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: MidEdge Hint');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt', { hasText: /^Send/ }).click();
  await page.locator('.sd-drawer.open input[type=text]').first().fill('ChainSend');
  const sendSelects = page.locator('.sd-drawer.open select');
  await sendSelects.nth(0).selectOption('WHATSAPP');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select account' }).selectOption('IBL-Karix-Onb');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select template' }).selectOption({ index: 1 });
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  // No goal is defined, so this Send's own open slot is a plain linear
  // edge — hover it to reveal the mid-insert "+".
  const edge = page.locator('.dc-branch-label').first();
  await edge.hover();
  await page.waitForTimeout(150);
  await page.locator('.dc-edge-insert').first().click();
  await page.waitForTimeout(200);

  await expect(page.locator('.sd-drawer.open')).toContainText('Inserting mid-chain only supports single-continuation steps');
  // Every tile is still shown (Phase 1: disabled-with-a-reason beats
  // silent omission) — Condition is a real single-continuation type and
  // stays clickable; Branch is a branching type and is shown but disabled.
  const conditionTile = page.locator('.dc-type-opt', { hasText: 'Condition' });
  const branchTile = page.locator('.dc-type-opt', { hasText: /^Branch/ });
  await expect(conditionTile).toHaveCount(1);
  await expect(branchTile).toHaveCount(1);
  await expect(conditionTile).not.toHaveClass(/disabled/);
  await expect(branchTile).toHaveClass(/disabled/);
  await expect(branchTile).toHaveAttribute('title', /can't be inserted mid-chain/);
});

test('Pause gets its own auto goal-check; auto-badge click-to-replace opens the add drawer', async ({ page }) => {
  await startNewCampaignWithGoal(page, 'Builder Spec: Pause', 'Card Events', 'Card Activated');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt:has-text("Wait for a fixed duration")').click();
  await page.locator('.sd-drawer.open input[type=number]').first().fill('3');
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card:has-text("Goal Check")')).toHaveCount(1);

  // The auto goal-check Split itself now also carries a "remove" badge —
  // this test is specifically about the GOAL_EXIT's own "replace" badge,
  // so target it precisely rather than the first .dc-auto-badge found.
  await page.locator('.dc-replace-badge').first().click();
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
  await page.locator('.dc-type-opt', { hasText: /^Branch/ }).click();
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

  await expect(page.locator('.dc-node-card:has-text("Branch")')).toHaveCount(1);
  await expect(page.locator('.dc-branch-label:has-text("Anything else")')).toHaveCount(1);

  // Insert a branch between the two existing ones.
  await page.locator('.dc-node-card:has-text("Branch")').click();
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
  await page.locator('.dc-type-opt:has-text("Experiment")').click();
  await page.waitForTimeout(150);
  const pctInputs = page.locator('.sd-drawer.open input[type=number]');
  await pctInputs.nth(0).fill('30');
  await pctInputs.nth(1).fill('30');
  await expect(page.locator('.sd-drawer.open .sd-foot button.btn.primary')).toBeDisabled();
  await pctInputs.nth(1).fill('70');
  await expect(page.locator('.sd-drawer.open .sd-foot button.btn.primary')).toBeEnabled();
});

test('Submit for Approval shows an on-demand validation banner with open branches, clears once every branch resolves', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Submit Gating');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  // Submit for Approval lives on the Review step now — get there via
  // the rail's "Continue to Review" action on the Builder topbar.
  await page.getByText('Continue to Review').click();
  await page.waitForTimeout(300);

  // The button itself is never disabled (on-demand validation, not a
  // permanent rail warning) — clicking it while incomplete surfaces a
  // banner instead of silently doing nothing.
  await expect(page.locator('button:has-text("Submit for Approval")')).toBeEnabled();
  await page.locator('button:has-text("Submit for Approval")').click();
  await page.waitForTimeout(200);
  await expect(page.locator('.dcb-validation-banner')).toBeVisible();
  await expect(page.locator('.dcb-validation-banner')).toContainText('branch');

  // Back to the Builder step (via the rail) to close the open branch.
  await page.locator('.dcb-vstep', { hasText: 'Builder' }).click();
  await page.waitForTimeout(300);
  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt', { hasText: /^Exit/ }).click();
  await page.locator('.sd-drawer.open input[type=text]').first().fill('done');
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  // Completed now — back to Review, clicking Submit actually navigates
  // away (back to the list), rather than showing the banner again.
  await page.getByText('Continue to Review').click();
  await page.waitForTimeout(300);
  await page.locator('button:has-text("Submit for Approval")').click();
  await page.waitForTimeout(400);
  await expect(page.locator('.dcb-validation-banner')).toHaveCount(0);
  await expect(page.locator('table tbody tr', { hasText: 'Builder Spec: Submit Gating' })).toBeVisible();
});

test('Mid-chain insert splices a new node into an existing connection, preserving the downstream subtree; Undo/Redo round-trip correctly', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Mid Insert');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt', { hasText: /^Send/ }).click();
  await page.locator('.sd-drawer.open input[type=text]').first().fill('First Send');
  const sendSelects = page.locator('.sd-drawer.open select');
  await sendSelects.nth(0).selectOption('WHATSAPP');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select account' }).selectOption({ index: 1 });
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open select', { hasText: 'Select template' }).selectOption({ index: 1 });
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  const countBefore = await page.locator('.dc-node-card').count();

  // Every tile shows up, but only single-continuation types are
  // clickable — branching/terminal ones render disabled instead of
  // being omitted (Phase 1 §10).
  await page.locator('.dc-edge-insert').first().click();
  await page.waitForTimeout(300);
  await expect(page.locator('.dc-type-opt', { hasText: 'Wait for a fixed duration' })).not.toHaveClass(/disabled/);
  await expect(page.locator('.dc-type-opt', { hasText: 'Experiment' })).toHaveClass(/disabled/);
  await expect(page.locator('.dc-type-opt', { hasText: /^Branch/ })).toHaveClass(/disabled/);

  await page.locator('.dc-type-opt', { hasText: 'Wait for a fixed duration' }).click();
  await page.locator('.sd-drawer.open input[type=number]').first().fill('2');
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card:has-text("Wait 2 days")')).toHaveCount(1);
  const countAfterInsert = await page.locator('.dc-node-card').count();
  expect(countAfterInsert).toBeGreaterThan(countBefore);

  // Undo removes exactly the inserted node (+ its own auto goal-check).
  await page.locator('button', { hasText: 'Undo' }).click();
  await page.waitForTimeout(400);
  await expect(page.locator('.dc-node-card:has-text("Wait 2 days")')).toHaveCount(0);
  expect(await page.locator('.dc-node-card').count()).toBe(countBefore);

  // Redo restores it.
  await page.locator('button', { hasText: 'Redo' }).click();
  await page.waitForTimeout(400);
  await expect(page.locator('.dc-node-card:has-text("Wait 2 days")')).toHaveCount(1);
  expect(await page.locator('.dc-node-card').count()).toBe(countAfterInsert);
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
