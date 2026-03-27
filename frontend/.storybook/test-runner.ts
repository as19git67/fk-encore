import type { TestRunnerConfig } from '@storybook/test-runner'
import { waitForPageReady } from '@storybook/test-runner'
import path from 'path'
import fs from 'fs'

const config: TestRunnerConfig = {
  async postVisit(page, context) {
    await waitForPageReady(page)

    // Small delay to let async data / images settle
    await page.waitForTimeout(300)

    const screenshotDir = path.join(process.cwd(), 'screenshots')
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true })
    }

    // context.id is e.g. "views-photosview--mit-fotos"
    await page.screenshot({
      path: path.join(screenshotDir, `${context.id}.png`),
      fullPage: true,
    })
  },
}

export default config
