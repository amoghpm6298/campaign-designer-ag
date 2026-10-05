// The two bugs that motivated this migration, as explicit, named
// regression tests — not just incidentally covered by other tests, so
// they can never silently come back without a test failing. Both are now
// impossible by construction (React Flow owns layout/label positioning),
// but a future dagre/React Flow upgrade or layout tweak could
// reintroduce either class of bug, so this is guarded permanently.
import { test, expect } from '@playwright/test';

const SEED_CAMPAIGN_COUNT = 6;

test.describe('Branch-label chip overlap (the original bug)', () => {
  for (let rowIndex = 0; rowIndex < SEED_CAMPAIGN_COUNT; rowIndex++) {
    test(`seed campaign row ${rowIndex}: no two branch-label chips overlap`, async ({ page }) => {
      await page.goto('/');
      const row = page.locator('table tbody tr').nth(rowIndex);
      const name = await row.locator('td').first().innerText();
      await row.click();
      await page.waitForTimeout(500);

      const boxes = await page.locator('.dc-branch-label').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const boxA = boxes[a];
          const boxB = boxes[b];
          const overlaps = boxA.x < boxB.x + boxB.width && boxB.x < boxA.x + boxA.width && boxA.y < boxB.y + boxB.height && boxB.y < boxA.y + boxA.height;
          expect(overlaps, `"${name}": chips at index ${a} and ${b} overlap`).toBe(false);
        }
      }
    });
  }
});

test.describe('Bare connector pill (the original "what is this?" bug)', () => {
  test('a bare (unlabeled) connector chip is invisible at rest and only reveals on hover', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '+ Create Drip Campaign' }).click();
    await page.locator('input[type=text]').first().fill('Bare Chip Regression');
    await page.locator('select').first().selectOption('IndusInd Bank (IBL)');
    await page.getByText('Skip to Builder →').click();
    await page.locator('.dc-add-entry-placeholder').click();
    await page.locator('.dc-type-opt:has-text("Entry · Event Trigger")').click();
    const entrySelects = page.locator('.sd-drawer.open select');
    await entrySelects.nth(0).selectOption('Journey Events');
    await entrySelects.nth(1).selectOption('Pageload');
    await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
    await page.waitForTimeout(300);

    // Add a Send so a real bare (unlabeled) connector exists (Send -> its
    // own auto goal-check Split).
    await page.locator('.dc-add-btn').click();
    await page.locator('.dc-type-opt', { hasText: /^Send/ }).click();
    await page.locator('.sd-drawer.open input[type=text]').first().fill('Regression Send');
    const sendSelects = page.locator('.sd-drawer.open select');
    await sendSelects.nth(0).selectOption('WHATSAPP');
    await page.waitForTimeout(150);
    const accountSelect = page.locator('.sd-drawer.open select', { hasText: 'Select account' });
    await accountSelect.selectOption('IBL-Karix-Onb');
    await page.waitForTimeout(150);
    const templateSelect = page.locator('.sd-drawer.open select', { hasText: 'Select template' });
    await templateSelect.selectOption({ index: 1 });
    await page.locator('.sd-drawer.open .sd-foot button.btn.primary').click();
    await page.waitForTimeout(400);

    const bareChip = page.locator('.dc-branch-label-bare').first();
    await expect(bareChip).toBeAttached();
    const restOpacity = await bareChip.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(restOpacity)).toBeLessThan(0.1);

    await bareChip.hover();
    await page.waitForTimeout(200);
    const hoverOpacity = await bareChip.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(hoverOpacity)).toBeGreaterThan(0.9);
  });
});
