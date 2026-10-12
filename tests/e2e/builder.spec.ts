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
  // Scoped by each field's own label, not position — Journey/Offer
  // Events now insert their own scoping selects (Journey+Batch or Offer
  // Type) between Event Category and Event Type, so a fixed index no
  // longer holds for every category.
  const drawer = page.locator('.sd-drawer.open');
  await drawer.locator('.f-group', { has: page.locator('label.f-label', { hasText: 'Event Category' }) }).locator('select').selectOption(category);
  await drawer.locator('.f-group', { has: page.locator('label.f-label', { hasText: 'Event Type' }) }).locator('select').selectOption(type);
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
  await addEntryEvent(page, 'Transaction Events', 'Transaction');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt', { hasText: /^Branch/ }).click();
  await page.waitForTimeout(150);
  // Source defaults to "Account attribute" — Account has no real
  // number-type attribute, so switch to "Entry event attribute" (the
  // entry is Transaction Events) to reach a real numeric field.
  const sourceSelect = page.locator('.sd-drawer.open select').nth(0);
  await sourceSelect.selectOption('Entry event attribute');
  await page.waitForTimeout(150);
  const attrSelect = page.locator('.sd-drawer.open select').nth(1);
  await attrSelect.selectOption('Transaction Amount');
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
  // Builder's topbar (-> Guardrails) then Guardrails' own footer (-> Review).
  await page.getByText('Continue to Guardrails').click();
  await page.waitForTimeout(300);
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
  await page.getByText('Continue to Guardrails').click();
  await page.waitForTimeout(300);
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

test('Condition "Transaction history" source: filters + lookback + existence render, and produce a real Yes/No graph', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Txn History Condition');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt:has-text("Condition")').first().click();
  await page.waitForTimeout(200);
  const sourceSelect = page.locator('.sd-drawer.open select').first();
  await sourceSelect.selectOption('Transaction history');
  await page.waitForTimeout(200);

  // Reuses the real ConditionRows UI (Transaction entity), not a
  // duplicate filter builder — the "+ Add condition" link is the same
  // one every other Condition source uses.
  await expect(page.locator('.sd-drawer.open .add-link', { hasText: 'Add condition' })).toBeVisible();

  // Lookback duration/unit, same shape as Pause.
  const lookback = page.locator('.sd-drawer.open input[type=number]').first();
  await lookback.fill('60');
  const unitSelect = page.locator('.sd-drawer.open select', { hasText: 'days' });
  await unitSelect.selectOption('hours');

  // Existence mode — both options present with explicit labels, not
  // hidden behind vague wording.
  const matchSelect = page.locator('.sd-drawer.open select').filter({ hasText: 'matching transaction exists' });
  await expect(matchSelect.locator('option')).toHaveCount(2);
  await matchSelect.selectOption('none');

  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  // Canvas shows a real, readable label (no filters set) and a real
  // Yes/No fork, not a generic placeholder.
  await expect(page.locator('.dc-node-card', { hasText: 'No transaction in 60 hours?' })).toHaveCount(1);
  await expect(page.locator('.dc-branch-label', { hasText: 'Yes' })).toBeVisible();
  await expect(page.locator('.dc-branch-label', { hasText: 'No' })).toBeVisible();
});

test('Condition "Milestone" source: pick a benefit, "Is" reveals Completed/Not Completed, builds a real Yes/No graph', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Milestone Condition');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt:has-text("Condition")').first().click();
  await page.waitForTimeout(200);
  const sel = () => page.locator('.sd-drawer.open select');
  await sel().first().selectOption('Milestone');
  await page.waitForTimeout(200);

  // Benefit picker (nth 1) + Condition/operator picker (nth 2) + the
  // "Is" value widget (nth 3) — same real benefit list and operator
  // vocabulary as ironbank-face-main's own Promotional Nudge form.
  await sel().nth(1).selectOption('MS-1002');
  await expect(sel().nth(2)).toHaveValue('IS'); // default operator
  await sel().nth(3).selectOption('COMPLETED');
  await page.waitForTimeout(150);

  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card', { hasText: 'Spend ₹75,000 in first 90 days — Completed?' })).toHaveCount(1);
  await expect(page.locator('.dc-branch-label', { hasText: 'Yes' })).toBeVisible();
  await expect(page.locator('.dc-branch-label', { hasText: 'No' })).toBeVisible();

  // Switching the operator to a percentage comparator swaps the value
  // widget from a status dropdown to a plain number input.
  await page.locator('.dc-node-card', { hasText: 'Spend ₹75,000 in first 90 days' }).click();
  await page.waitForTimeout(300);
  await sel().nth(2).selectOption('GTE_PCT');
  await page.waitForTimeout(150);
  await page.locator('.sd-drawer.open input[type=number]').fill('75');
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);
  await expect(page.locator('.dc-node-card', { hasText: 'Spend ₹75,000 in first 90 days ≥ 75%?' })).toHaveCount(1);
});

test('Entry · Audience entity = Milestone requires a complete condition before Add Step enables', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Milestone Entry');
  await page.locator('.dc-add-entry-placeholder').click();
  await page.locator('.dc-type-opt:has-text("Entry · Audience")').click();
  await page.waitForTimeout(200);

  await page.locator('.sd-drawer.open').getByText('+ Add condition to narrow').click();
  await page.waitForTimeout(150);
  const sel = () => page.locator('.sd-drawer.open select');
  await sel().nth(1).selectOption('Milestone');
  await page.waitForTimeout(150);

  // Benefit not yet picked — Add Step stays disabled, same discipline as
  // Transaction's own lookback-window requirement.
  await expect(page.locator('.sd-drawer.open .sd-foot button.btn.primary')).toBeDisabled();
  await sel().nth(2).selectOption('MS-1004');
  await page.waitForTimeout(150);
  await expect(page.locator('.sd-drawer.open .sd-foot button.btn.primary')).toBeEnabled();

  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);
  await expect(page.locator('.dc-node-card', { hasText: 'All eligible customers' })).toHaveCount(1);
});

test('Branch (Decision Split) "Milestone" source: one benefit, per-branch operators, real labels', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Milestone Branch');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt', { hasText: /^Branch/ }).click();
  await page.waitForTimeout(150);
  const sel = () => page.locator('.sd-drawer.open select');
  await sel().nth(0).selectOption('Milestone');
  await page.waitForTimeout(150);
  await sel().nth(1).selectOption('MS-1003');
  await page.waitForTimeout(150);

  // Branch 1: percentage comparator; Branch 2: Completed.
  await sel().nth(2).selectOption('LTE_PCT');
  await page.locator('.sd-drawer.open input[type=number]').first().fill('50');
  await sel().nth(3).selectOption('IS');
  await page.locator('.sd-drawer.open select').last().selectOption('COMPLETED');
  await page.waitForTimeout(150);

  await expect(page.locator('.sd-drawer.open .sd-foot button.btn.primary')).toBeEnabled();
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card', { hasText: 'Spend ₹1,50,000 in first 180 days' })).toHaveCount(1);
  await expect(page.locator('.dc-branch-label', { hasText: '≤ 50%' })).toBeVisible();
  await expect(page.locator('.dc-branch-label', { hasText: 'Completed' })).toBeVisible();
  await expect(page.locator('.dc-branch-label', { hasText: 'Anything else' })).toBeVisible();
});

test('Entry · Audience: Entity = Transaction reveals lookback + match fields (no separate toggle), and persists on save/reopen', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Txn Entity Entry');
  await page.locator('.dc-add-entry-placeholder').click();
  await page.locator('.dc-type-opt:has-text("Entry · Audience")').click();
  await page.waitForTimeout(200);

  // No entity picker, and no lookback/match fields, until a real
  // condition exists — same precedent as every other entity choice.
  await expect(page.locator('.sd-drawer.open input[type=number]')).toHaveCount(0);

  await page.locator('.sd-drawer.open').getByText('+ Add condition to narrow').click();
  await page.waitForTimeout(150);

  const sel = () => page.locator('.sd-drawer.open select');
  // 0=Runs, 1=Entity(primary)
  await expect(sel().nth(1)).toHaveCount(1);
  await sel().nth(1).selectOption('Transaction');
  await page.waitForTimeout(150);

  // Transaction is just another entity choice — Filters still renders via
  // the same ConditionRows every entity uses — but it also reveals a
  // Lookback number input and a Match select, which no other entity does.
  await expect(page.locator('.sd-drawer.open').getByText('Filters')).toBeVisible();
  await expect(page.locator('.sd-drawer.open input[type=number]')).toHaveCount(1);
  await page.locator('.sd-drawer.open input[type=number]').first().fill('90');
  await page.waitForTimeout(150);
  await sel().last().selectOption('none');
  await page.waitForTimeout(150);

  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  // Save as Draft lives on the Review step, not the Builder header.
  await page.getByText('Continue to Guardrails').click();
  await page.waitForTimeout(300);
  await page.getByText('Continue to Review').click();
  await page.waitForTimeout(300);
  await page.getByText('Save as Draft').click();
  await page.waitForTimeout(400);

  // Reopen the draft and confirm Entity + lookback + match all survived
  // the save/reopen round trip.
  await page.locator('tr', { hasText: 'Builder Spec: Txn Entity Entry' }).click();
  await page.waitForTimeout(400);
  await page.locator('.dc-node-card').first().click();
  await page.waitForTimeout(300);
  await expect(sel().nth(1)).toHaveValue('Transaction');
  await expect(page.locator('.sd-drawer.open input[type=number]').first()).toHaveValue('90');
  await expect(sel().last()).toHaveValue('none');
});

test('Goal Definition: Journey Events shows its own scoping fields + a locked-attribute condition row, and both survive save/reopen', async ({ page }) => {
  // The Goal step is a plain full-width page (dcb-mid-inner), not a side
  // drawer — unlike every node's own config form.
  await page.goto('/');
  await page.getByRole('button', { name: '+ Create Drip Campaign' }).click();
  await page.locator('input[type=text]').first().fill('Builder Spec: Journey Events Goal');
  await page.locator('select').first().selectOption('IndusInd Bank (IBL)');
  await page.getByText('Continue to Goal →').click();
  await page.waitForTimeout(200);

  const goalSelects = page.locator('select');
  await goalSelects.nth(0).selectOption('Journey Events');
  await page.waitForTimeout(200);

  // Journey/Batch scoping selects appear immediately, before an Event
  // Type is even picked — same layout order as the original event-based-
  // nudges wizard this was ported from.
  await expect(page.locator('label.f-label', { hasText: 'Journey' })).toBeVisible();
  await expect(page.locator('label.f-label', { hasText: 'Batch' })).toBeVisible();
  await goalSelects.filter({ hasText: 'Select' }).first().selectOption('Onboarding');

  // No Goal Conditions block yet — no Event Type picked, so no locked
  // attribute resolves (same "nothing to render" rule as Card Events).
  await expect(page.getByText('Goal Conditions')).toHaveCount(0);

  await goalSelects.nth(1).selectOption('Pageload');
  await page.waitForTimeout(200);

  // Now it appears, with the real "+ Add condition" link every other
  // Condition source uses.
  await expect(page.getByText('Goal Conditions')).toBeVisible();
  await page.getByText('+ Add condition').click();
  await page.waitForTimeout(200);

  // Attribute is locked (disabled, pre-filled), not a picker — "Page
  // Name" per EVENT_ATTR_BY_TYPE['Pageload'], the one real narrowing
  // attribute Pageload has.
  const condRow = page.locator('.cond-row').first();
  await expect(condRow.locator('input:disabled')).toHaveValue('Page Name');
  await condRow.locator('input[placeholder="Value"]').fill('EMI Offer Page');

  await page.getByText('Continue to Builder →').click();
  await page.waitForTimeout(300);
  await page.getByText('Continue to Guardrails').click();
  await page.waitForTimeout(300);
  await page.getByText('Continue to Review').click();
  await page.waitForTimeout(300);
  await page.getByText('Save as Draft').click();
  await page.waitForTimeout(400);

  // Reopen and confirm the scoping pick and the locked-attribute
  // condition both survived the round trip.
  await page.locator('tr', { hasText: 'Builder Spec: Journey Events Goal' }).click();
  await page.waitForTimeout(400);
  await page.getByText('Goal', { exact: true }).click();
  await page.waitForTimeout(300);
  await expect(page.locator('select').filter({ hasText: 'Onboarding' })).toHaveCount(1);
  const reopenedCondRow = page.locator('.cond-row').first();
  await expect(reopenedCondRow.locator('input:disabled')).toHaveValue('Page Name');
  await expect(reopenedCondRow.locator('input[placeholder="Value"]')).toHaveValue('EMI Offer Page');
});

test('Condition "Entry event attribute" source on a Journey Events entry resolves the locked attribute and builds a real Yes/No graph', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Journey Events Condition');
  await addEntryEvent(page, 'Journey Events', 'Button Click');

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt:has-text("Condition")').first().click();
  await page.waitForTimeout(200);
  const sourceSelect = page.locator('.sd-drawer.open select').first();
  await sourceSelect.selectOption('Entry event attribute');
  await page.waitForTimeout(200);

  // Conditions start empty, same as every other Condition source — add
  // one, same "+ Add condition" link every source reuses.
  await page.locator('.sd-drawer.open .add-link', { hasText: 'Add condition' }).click();
  await page.waitForTimeout(200);

  // Locked to "Button Name" — not editable, and not the generic
  // free-text fallback either (there's a real, specific attribute here).
  const condRow = page.locator('.sd-drawer.open .cond-row').first();
  await expect(condRow.locator('input:disabled')).toHaveValue('Button Name');
  await condRow.locator('input[placeholder="Value"]').fill('Apply Now');

  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card', { hasText: 'Button Name = Apply Now?' })).toHaveCount(1);
  await expect(page.locator('.dc-branch-label', { hasText: 'Yes' })).toBeVisible();
  await expect(page.locator('.dc-branch-label', { hasText: 'No' })).toBeVisible();
});

test('Branch "Entry event attribute" source on an Offer Events entry locks the attribute and builds real branches', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Offer Events Branch');
  await page.locator('.dc-add-entry-placeholder').click();
  await page.locator('.dc-type-opt:has-text("Entry · Event")').click();
  await page.waitForTimeout(200);
  const entrySelects = page.locator('.sd-drawer.open select');
  await entrySelects.nth(0).selectOption('Offer Events');
  await page.waitForTimeout(200);
  // Offer Events: [0] Event Category, [1] Offer Type, [2] Event Type.
  await entrySelects.nth(2).selectOption('Outcome Issuance');
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(300);

  await page.locator('.dc-add-btn').click();
  await page.locator('.dc-type-opt:has-text("Branch")').first().click();
  await page.waitForTimeout(200);
  await page.locator('.sd-drawer.open select').first().selectOption('Entry event attribute');
  await page.waitForTimeout(200);

  await expect(page.locator('.sd-drawer.open input:disabled')).toHaveValue('Outcome Status');
  const valueInputs = page.locator('.sd-drawer.open input[placeholder="Value"]');
  await valueInputs.nth(0).fill('Redeemed');
  await valueInputs.nth(1).fill('Expired');

  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await expect(page.locator('.dc-node-card', { hasText: 'Outcome Status' })).toHaveCount(1);
  await expect(page.locator('.dc-branch-label', { hasText: 'Redeemed' })).toBeVisible();
  await expect(page.locator('.dc-branch-label', { hasText: 'Expired' })).toBeVisible();
  await expect(page.locator('.dc-branch-label', { hasText: 'Anything else' })).toBeVisible();
});

test('Entry · Audience "Add another entity filter" combines two different entities (Account AND Card), and persists on save/reopen', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Multi-Entity Entry');
  await page.locator('.dc-add-entry-placeholder').click();
  await page.locator('.dc-type-opt:has-text("Entry · Audience")').click();
  await page.waitForTimeout(200);

  // No entity picker until a real condition exists — same precedent as
  // the single-entity form this extends.
  await page.locator('.sd-drawer.open').getByText('+ Add condition to narrow').click();
  await page.waitForTimeout(150);

  const sel = () => page.locator('.sd-drawer.open select');
  // 0=Runs, 1=Entity(primary), 2=Attribute(primary), 3=Operator(primary), 4=Value(primary)
  await sel().nth(1).selectOption('Account');
  await sel().nth(2).selectOption('Status');
  await sel().nth(4).selectOption('Dormant');
  await page.waitForTimeout(150);

  await expect(page.locator('.sd-drawer.open').getByText('+ Add another entity filter')).toBeVisible();
  await page.locator('.sd-drawer.open').getByText('+ Add another entity filter').click();
  await page.waitForTimeout(150);

  // A second, independently removable Entity + Conditions block appears —
  // AND'd with the first, not a replacement for it.
  await expect(page.locator('.sd-drawer.open').getByText('Every filter here is AND')).toBeVisible();
  await sel().nth(5).selectOption('Card');
  await sel().nth(6).selectOption('Status');
  await sel().nth(8).selectOption('Active');
  await page.waitForTimeout(150);

  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  await page.getByText('Continue to Guardrails').click();
  await page.waitForTimeout(300);
  await page.getByText('Continue to Review').click();
  await page.waitForTimeout(300);
  await page.getByText('Save as Draft').click();
  await page.waitForTimeout(400);

  // Reopen and confirm both entity blocks survived the save/reopen round
  // trip, each with its own entity and condition.
  await page.locator('tr', { hasText: 'Builder Spec: Multi-Entity Entry' }).click();
  await page.waitForTimeout(400);
  await page.locator('.dc-node-card').first().click();
  await page.waitForTimeout(300);
  await expect(sel().nth(1)).toHaveValue('Account');
  await expect(sel().nth(4)).toHaveValue('Dormant');
  await expect(sel().nth(5)).toHaveValue('Card');
  await expect(sel().nth(8)).toHaveValue('Active');
});

test('Parallel paths: a second path can be added from the same step, and each path can be named', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Parallel Paths');
  await addEntryEvent(page, 'Card Events', 'Card Activated');

  const entry = page.locator('.dc-node-card', { hasText: 'Card Activated' });
  const drawer = page.locator('.sd-drawer.open');

  // With no children yet, the ordinary "+" slot is the only way to add —
  // offering a second control for the same action would just be noise.
  await expect(entry.locator('.dc-parallel-badge')).toHaveCount(0);

  await page.locator('.dc-add-btn').first().click();
  await page.locator('.dc-type-opt:has-text("Wait for a fixed duration")').click();
  await page.waitForTimeout(150);
  await drawer.locator('input[type=number]').fill('30');
  await drawer.locator('.sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  // Now that it has one child, the parallel-path control appears.
  await expect(entry.locator('.dc-parallel-badge')).toHaveCount(1);
  await entry.hover();
  await entry.locator('.dc-parallel-badge').click();
  await page.waitForTimeout(250);
  await page.locator('.dc-type-opt:has-text("Wait for a fixed duration")').click();
  await page.waitForTimeout(150);
  await drawer.locator('input[type=number]').fill('90');
  await drawer.locator('.sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  // Two genuinely independent paths off the same entry — not a chain.
  await expect(page.locator('.dc-node-card', { hasText: 'Wait 30 days' })).toHaveCount(1);
  await expect(page.locator('.dc-node-card', { hasText: 'Wait 90 days' })).toHaveCount(1);

  // Each now offers a name, since there's more than one to tell apart.
  const prompts = page.locator('.dc-branch-label-text.placeholder');
  await expect(prompts).toHaveCount(2);
  await prompts.first().click();
  await page.waitForTimeout(150);
  const input = page.locator('.dc-branch-label-input');
  await input.fill('Month 1');
  await input.press('Enter');
  await page.waitForTimeout(300);

  await expect(page.locator('.dc-branch-label-text', { hasText: 'Month 1' })).toHaveCount(1);
  await expect(page.locator('.dc-branch-label-text.placeholder')).toHaveCount(1);
});

test('A single linear connector is never offered a name — only genuinely parallel paths are', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: No Name On Linear');
  await addEntryEvent(page, 'Journey Events', 'Pageload');
  const drawer = page.locator('.sd-drawer.open');

  await page.locator('.dc-add-btn').first().click();
  await page.locator('.dc-type-opt:has-text("Wait for a fixed duration")').click();
  await page.waitForTimeout(150);
  await drawer.locator('input[type=number]').fill('7');
  await drawer.locator('.sd-foot button.btn.primary').click();
  await page.waitForTimeout(400);

  // One child only — the connector is unambiguous, so no naming prompt
  // clutters it.
  await expect(page.locator('.dc-branch-label-text')).toHaveCount(0);
});

test('Goal Check is addable by hand when a Goal exists, and Condition no longer offers a "Goal" source', async ({ page }) => {
  await startNewCampaignWithGoal(page, 'Builder Spec: Manual Goal Check', 'Card Events', 'Card Activated');
  await addEntryEvent(page, 'Journey Events', 'Pageload');
  const drawer = page.locator('.sd-drawer.open');

  // Condition's source list dropped "Goal" — one question, one node type.
  await page.locator('.dc-add-btn').first().click();
  await page.locator('.dc-type-opt:has-text("Condition")').first().click();
  await page.waitForTimeout(200);
  const sourceOptions = await drawer.locator('select').first().locator('option').allTextContents();
  expect(sourceOptions).not.toContain('Goal');
  expect(sourceOptions).toContain('Previous step outcome');
  await drawer.locator('.sd-foot button.btn.secondary').click();
  await page.waitForTimeout(250);

  // Goal Check is offered in its place, and builds the same shape the
  // automatic one does: Yes wired to Goal Reached, No left open.
  await page.locator('.dc-add-btn').first().click();
  await page.waitForTimeout(150);
  const tile = page.locator('.dc-type-opt', { hasText: 'Goal Check' });
  await expect(tile).toHaveCount(1);
  await expect(tile).not.toHaveClass(/disabled/);
  await tile.click();
  await page.waitForTimeout(200);
  await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
  await page.waitForTimeout(450);

  await expect(page.locator('.dc-node-card:has-text("Goal Check")')).toHaveCount(1);
  await expect(page.locator('.dc-node-card:has-text("Goal Reached")')).toHaveCount(1);
  await expect(page.locator('.dc-branch-label', { hasText: 'Yes' })).toHaveCount(1);
  await expect(page.locator('.dc-branch-label', { hasText: 'No' })).toHaveCount(1);
});

test('Goal Check is offered but disabled when no campaign Goal is defined', async ({ page }) => {
  await startNewCampaign(page, 'Builder Spec: Goal Check No Goal');
  await addEntryEvent(page, 'Journey Events', 'Pageload');

  await page.locator('.dc-add-btn').first().click();
  await page.waitForTimeout(150);
  // Shown, not hidden — a missing tile reads as "this product can't do
  // that", a disabled one with a reason reads as "not yet, here's why".
  const tile = page.locator('.dc-type-opt', { hasText: 'Goal Check' });
  await expect(tile).toHaveCount(1);
  await expect(tile).toHaveClass(/disabled/);
});
