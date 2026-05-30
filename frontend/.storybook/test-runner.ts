import type { TestRunnerConfig } from '@storybook/test-runner'
import { getStoryContext, waitForPageReady } from '@storybook/test-runner'
import path from 'path'
import fs from 'fs'

const config: TestRunnerConfig = {
  async preVisit(page, context) {
    // Allow a story to pin the browser viewport via a `testViewport`
    // parameter (e.g. to force portrait vs. landscape for orientation-driven
    // layouts like the fullscreen split view). Falls back to a stable
    // landscape default so all other screenshots stay consistent.
    const storyContext = await getStoryContext(page, context)
    const testViewport = (storyContext.parameters?.testViewport ?? {}) as {
      width?: number
      height?: number
    }
    await page.setViewportSize({
      width: testViewport.width ?? 1280,
      height: testViewport.height ?? 800,
    })
  },
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
