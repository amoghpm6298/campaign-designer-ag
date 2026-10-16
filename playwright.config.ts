import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5183/drip-campaigns/',
    // Reuse the system-installed Chrome, same convention used throughout
    // this project's own verification scripts — avoids downloading a
    // separate browser binary.
    channel: 'chrome',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  // Two servers: the mock app, and the standalone Campaign Designer on its
  // own port with its own config. They are separate applications.
  webServer: [
    {
      command: 'npx vite --port 5183',
      url: 'http://localhost:5183/drip-campaigns/',
      reuseExistingServer: true,
      timeout: 30000,
    },
    {
      command: 'npx vite --config vite.designer.config.ts --port 5174',
      url: 'http://localhost:5174/designer.html',
      reuseExistingServer: true,
      timeout: 30000,
    },
  ],
});
