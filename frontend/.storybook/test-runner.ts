import type { TestRunnerConfig } from '@storybook/test-runner'
import { getStoryContext, waitForPageReady } from '@storybook/test-runner'
import path from 'path'
import fs from 'fs'
import { findOverflowingElements } from '../src/utils/overflowCheck'
import { findClippedFocusRings } from '../src/utils/focusRingCheck'

/** The narrowest phone the app is expected to fit (issue #1272, stage 1). */
const PHONE_VIEWPORT = { width: 360, height: 740 }

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

    // ── No horizontal page overflow at phone width ────────────────────────
    // The page never scrolls sideways; wide content lives in a ScrollX
    // wrapper (or any element with its own overflow-x). Anything else that
    // sticks out of a 360px viewport is a layout bug. A story may opt out
    // with `parameters: { overflowCheck: false }` while its view is not yet
    // on PageLayout (issue #1272, stage 2); the exemption must say why.
    const storyContext = await getStoryContext(page, context)

    // ── No focus ring clipped away (issue #1281) ──────────────────────────
    // The ring is drawn outside its element and reaches 4px past it, so a
    // container that clips cuts it off — invisible until someone navigates
    // by keyboard. The container makes room; where the clipping is the point
    // (a rounded map cropping its tiles) the element draws its ring inside
    // itself instead, and says so with a negative `outline-offset`.
    // A story may opt out with `parameters: { focusRingCheck: false }`; the
    // exemption has to say why.
    if (storyContext.parameters?.focusRingCheck !== false) {
      const clipped = await page.evaluate(findClippedFocusRings)
      if (clipped.length > 0) {
        const list = clipped
          .slice(0, 8)
          .map((c) => `  ${c.path} — ${c.sides.join('/')} cut off by ${c.container}`)
          .join('\n')
        throw new Error(
          `${context.id}: ${clipped.length} focus ring(s) would be clipped:\n${list}\n` +
            'The container makes room: padding of var(--focus-ring-reach), ' +
            'the same amount back as a negative margin.',
        )
      }
    }

    if (storyContext.parameters?.overflowCheck === false) return

    await page.setViewportSize(PHONE_VIEWPORT)
    await page.waitForTimeout(300)
    const offenders = await page.evaluate(findOverflowingElements)
    if (offenders.length > 0) {
      const list = offenders
        .slice(0, 8)
        .map((o) => `  ${o.path} (right edge at ${o.right}px)`)
        .join('\n')
      throw new Error(
        `${context.id}: ${offenders.length} element(s) overflow a ${PHONE_VIEWPORT.width}px viewport ` +
          `without a horizontal scroller of their own:\n${list}`,
      )
    }
  },
}

export default config
