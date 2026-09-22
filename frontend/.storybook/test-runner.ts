import type { TestRunnerConfig } from '@storybook/test-runner'
import { getStoryContext, waitForPageReady } from '@storybook/test-runner'
import type { Page } from 'playwright'
import path from 'path'
import fs from 'fs'
import { findOverflowingElements } from '../src/utils/overflowCheck'
import { findClippedFocusRings } from '../src/utils/focusRingCheck'

/** The narrowest phone the app is expected to fit (issue #1272, stage 1). */
const PHONE_VIEWPORT = { width: 360, height: 740 }

/**
 * Wait until the preview's story store exists, then read the context.
 *
 * The runner's own `getStoryContext` calls `storyStore.loadStory()` straight
 * away, while the story run first waits for Storybook to come up. Between
 * those two moments `preview.storyStore` is a proxy that throws
 * `StoryStoreAccessedBeforeInitializationError` — which is not a story
 * failing, it is this hook arriving early. It showed up on a different
 * handful of stories every run, so it read like flakiness rather than a
 * race. `storyStoreValue` is the field that proxy checks.
 */
async function storyContextWhenReady(page: Page, context: Parameters<typeof getStoryContext>[1]) {
  await page.waitForFunction(
    () =>
      Boolean(
        (globalThis as unknown as { __STORYBOOK_PREVIEW__?: { storyStoreValue?: unknown } })
          .__STORYBOOK_PREVIEW__?.storyStoreValue,
      ),
    undefined,
    { timeout: 30_000 },
  )
  return getStoryContext(page, context)
}

/**
 * `preVisit` and `postVisit` both want the story's parameters, which do not
 * change in between — so the wait plus the round-trip is paid once per story
 * and the second hook reads the answer.
 */
type StoryContext = Awaited<ReturnType<typeof getStoryContext>>
const contextCache = new Map<string, StoryContext>()

async function storyContextOnce(page: Page, context: Parameters<typeof getStoryContext>[1]) {
  const cached = contextCache.get(context.id)
  if (cached) return cached
  const storyContext = await storyContextWhenReady(page, context)
  contextCache.set(context.id, storyContext)
  return storyContext
}

/**
 * Look for focus rings the page cuts off, and say which.
 *
 * Twice, a beat apart, and only what both readings agree on. A page still
 * settling reports a row that has not grown into its container yet — measured
 * under load, that produced a finding the same page contradicted a moment
 * later. A ring that is genuinely clipped stays clipped.
 */
async function assertNoClippedFocusRings(page: Page, storyId: string, viewport: string) {
  const first = await page.evaluate(findClippedFocusRings)
  if (first.length === 0) return
  await page.waitForTimeout(500)
  const second = await page.evaluate(findClippedFocusRings)
  const seen = new Set(second.map((c) => `${c.path}|${c.sides.join(',')}`))
  const clipped = first.filter((c) => seen.has(`${c.path}|${c.sides.join(',')}`))
  if (clipped.length === 0) return
  const list = clipped
    .slice(0, 8)
    .map((c) => `  ${c.path} — ${c.sides.join('/')} cut off by ${c.container}`)
    .join('\n')
  throw new Error(
    `${storyId}: ${clipped.length} focus ring(s) would be clipped at ${viewport}:\n${list}\n` +
      'The container makes room: padding of var(--focus-ring-reach), ' +
      'the same amount back as a negative margin.',
  )
}

const config: TestRunnerConfig = {
  async preVisit(page, context) {
    // Allow a story to pin the browser viewport via a `testViewport`
    // parameter (e.g. to force portrait vs. landscape for orientation-driven
    // layouts like the fullscreen split view). Falls back to a stable
    // landscape default so all other screenshots stay consistent.
    const storyContext = await storyContextOnce(page, context)
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

    const storyContext = await storyContextOnce(page, context)
    // A story may opt out of either check — `parameters: { overflowCheck:
    // false }` while its view is not yet on PageLayout (issue #1272, stage
    // 2), `{ focusRingCheck: false }` likewise; each exemption must say why.
    const wantsFocusRings = storyContext.parameters?.focusRingCheck !== false
    const wantsOverflow = storyContext.parameters?.overflowCheck !== false

    // ── No focus ring clipped away (issue #1281) ──────────────────────────
    // The ring is drawn outside its element and reaches 4px past it, so a
    // container that clips cuts it off — invisible until someone navigates
    // by keyboard. The container makes room; where the clipping is the point
    // (a rounded map cropping its tiles) the element draws its ring inside
    // itself instead, and says so with a negative `outline-offset`.
    if (wantsFocusRings) {
      await assertNoClippedFocusRings(page, context.id, 'the story viewport')
    }

    if (!wantsFocusRings && !wantsOverflow) return

    await page.setViewportSize(PHONE_VIEWPORT)
    await page.waitForTimeout(300)

    // ── No horizontal page overflow at phone width ────────────────────────
    // The page never scrolls sideways; wide content lives in a ScrollX
    // wrapper (or any element with its own overflow-x). Anything else that
    // sticks out of a 360px viewport is a layout bug.
    if (wantsOverflow) {
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
    }

    // The rings again, now that the narrow layout is the one on screen. Half
    // the app's clipping containers only exist here — the hamburger, the
    // icons-only submenu strip, the selection bar pinned to the bottom — and
    // the hamburger's cut-off ring is the report this check was written for.
    if (wantsFocusRings) {
      await assertNoClippedFocusRings(page, context.id, `${PHONE_VIEWPORT.width}px`)
    }
  },
}

export default config
