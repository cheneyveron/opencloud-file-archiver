import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL
if (!baseURL) {
  throw new Error('E2E_BASE_URL is required')
}

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 20_000
  },
  outputDir: process.env.E2E_RESULTS_DIR || 'test-results/e2e',
  reporter: [
    ['line'],
    [
      'html',
      {
        outputFolder: process.env.E2E_REPORT_DIR || 'playwright-report',
        open: 'never'
      }
    ]
  ],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'archiver-chromium',
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium'
      }
    }
  ]
})
