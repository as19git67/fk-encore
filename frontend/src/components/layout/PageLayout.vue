<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useSlots, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { STACK_TARGET_ID, formatDocumentTitle } from './pageLayout'
import type { AnchorResolution } from './pageLayout'
import {
  anchorSaveMark,
  anchorSavedSince,
  clearListAnchor,
  focusListAnchor,
  leavingAnchor,
  saveListAnchor,
  takeListAnchor,
} from '../../utils/listAnchor'
import type { ListAnchor } from '../../utils/listAnchor'
import { navigatedFromHistory, readScrollOffset } from '../../utils/scrollMemory'

/**
 * The one page skeleton every view fills (issue #1272, stage 1).
 *
 * A view no longer builds its own header, toolbar or sticky layer; it names
 * a title and fills slots. The toolbar, notices and (while active) the
 * selection bar are lifted into the app's single sticky stack
 * (`#module-subheaders` in App.vue), so there is exactly one sticky layer
 * and content scrolls underneath it. Outside the app shell — Storybook, a
 * unit test — that target does not exist and the same markup renders inline.
 *
 *   <PageLayout title="Dokumente" width="full">
 *     <template #actions>  … buttons beside the title             </template>
 *     <template #toolbar>  … search / filter / sort (sticky)       </template>
 *     <template #notice>   … Message banners (sticky, under toolbar)</template>
 *     <template #default>  … the content                           </template>
 *     <template #selection>… the selection bar, only while active  </template>
 *   </PageLayout>
 *
 * The document is the page's only scroller (issue #1674): iOS scrolls to the
 * top on a tap on the status bar only when the document itself scrolls, so
 * no view wraps its main content in a scroller of its own. Virtual grids
 * measure against `window` (`usePageVirtualizer`), a column beside the list
 * stays in view with the global `.page-aside` class.
 *
 * `scroll="page"` (default): the content scrolls with the document.
 * `scroll="fill"`: the page takes exactly one viewport below the sticky
 * stack and the content stretches to fill it — for a map, which has no
 * length to scroll through and pans by itself, and for the big photo grids
 * (gallery, a person's photos, the shared album), which scroll inside their
 * own box: with tens of thousands of photos a document that tall crashed
 * Safari (see `usePageVirtualizer`).
 *
 * `sticky-header`: the title row with `#actions` (the back button of a
 * detail page and its actions) goes into the sticky stack as well, above the
 * toolbar, so the way out never scrolls off the screen.
 */

export type PageScroll = 'page' | 'fill'
export type PageWidth = 'normal' | 'wide' | 'full'

const props = withDefaults(
  defineProps<{
    /** Page title: rendered as the page's only <h1> and written to document.title. */
    title: string
    /** One line under the title, muted. */
    hint?: string
    scroll?: PageScroll
    width?: PageWidth
    /**
     * Whether the view's data has arrived. Exposed as `data-page-ready` so a
     * test runner can wait for it, and the moment the page is put back where
     * the user left it — a list cannot scroll to 3000px while it is still two
     * rows tall.
     */
    ready?: boolean
    /**
     * Put the user back on the row they opened (stage 4). Called once the
     * page is `ready`, with the anchor this list saved or `null` when there
     * is none. See `AnchorResolution` for what to return; leave it out and
     * the row is looked up by its `data-anchor` attribute.
     */
    resolveAnchor?: (anchor: ListAnchor | null) => AnchorResolution | Promise<AnchorResolution>
    /**
     * Key the anchor and the scroll offset are stored under. Defaults to the
     * route's name, which is what a list wants: the same list under a
     * different filter is still the same list.
     */
    anchorKey?: string
    /** Read an older build's anchor key once, so an open tab keeps working. */
    legacyAnchorKey?: 'documents'
    /** Lift the title row and `#actions` into the sticky stack (detail pages). */
    stickyHeader?: boolean
  }>(),
  {
    hint: undefined,
    scroll: 'page',
    width: 'normal',
    ready: true,
    resolveAnchor: undefined,
    anchorKey: undefined,
    legacyAnchorKey: undefined,
    stickyHeader: false,
  },
)

const slots = useSlots()
const route = useRoute()
const router = useRouter()

const contentEl = ref<HTMLElement | null>(null)

/**
 * Teleport only when the app shell provides the stack. Decided once on
 * mount: the shell renders before any route view, so a missing target
 * means "no shell" (Storybook, tests), not "not yet".
 */
const hasStackTarget = ref(false)
onMounted(() => {
  hasStackTarget.value = typeof document !== 'undefined' && !!document.getElementById(STACK_TARGET_ID)
})

const stackTarget = `#${STACK_TARGET_ID}`
const hasStackContent = computed(() => props.stickyHeader || !!(slots.toolbar || slots.notice || slots.selection))

watch(
  () => [props.title, route?.path] as const,
  ([title, path]) => {
    if (typeof document === 'undefined') return
    document.title = formatDocumentTitle(title, path)
  },
  { immediate: true },
)

// ── Scroll and focus restore (issue #1272, stage 4) ──────────────────────────
// The router saves the document's offset when a navigation leaves a page.

const restoreKey = computed(() => props.anchorKey ?? String(route?.name ?? route?.path ?? ''))

let restored = false

/**
 * Put the user back: on the row they opened if it is still there, otherwise
 * on the offset they left behind — and only then if they came back by going
 * back. Opening the same page from a menu starts at the top.
 */
async function restorePosition() {
  if (restored) return
  restored = true
  // Coming back is what earns a restore. Entering the list from the menu is a
  // fresh start, and the anchor the last visit left behind would otherwise
  // drag the reader onto a row they had forgotten about — so it is dropped
  // rather than used, exactly as `listAnchor` describes.
  if (!navigatedFromHistory()) {
    clearListAnchor(restoreKey.value, props.legacyAnchorKey)
    return
  }
  const anchor = takeListAnchor(restoreKey.value, props.legacyAnchorKey)
  await nextTick()
  if (props.resolveAnchor) {
    const resolved = await props.resolveAnchor(anchor)
    if (resolved === true) return
    if (resolved instanceof HTMLElement) {
      resolved.scrollIntoView({ block: 'center', behavior: 'instant' })
      resolved.focus?.({ preventScroll: true })
      return
    }
  } else if (anchor && focusListAnchor(contentEl.value ?? document, anchor)) {
    return
  }
  const top = readScrollOffset(route?.fullPath ?? restoreKey.value)
  if (top === null) return
  requestAnimationFrame(() => window.scrollTo({ top, behavior: 'instant' }))
}

onMounted(() => {
  if (props.ready) void restorePosition()
})
watch(
  () => props.ready,
  (ready) => {
    if (ready) void restorePosition()
  },
)

// ── Remember the row on the way out ─────────────────────────────────────────
// A list names the row it opens with `saveListAnchor`. Not every way out
// passes through that code: the split view's "Öffnen" sits in the pane, a row
// can hold a link, the user can leave through the menu. So when the page is
// left for another one and the view did not save an anchor during this visit,
// the row the user was on is saved here — see `leavingAnchor` for which.

const visitMark = anchorSaveMark()
let lastTouched: string | null = null

function noteTouched(event: Event) {
  const row = (event.target as Element | null)?.closest?.<HTMLElement>('[data-anchor]')
  if (row && contentEl.value?.contains(row)) lastTouched = row.dataset.anchor ?? null
}

function rememberLeavingRow() {
  const root = contentEl.value
  if (!root || anchorSavedSince(restoreKey.value, visitMark)) return
  const anchor = leavingAnchor(root, lastTouched)
  if (anchor) saveListAnchor(restoreKey.value, anchor)
}

let removeLeaveGuard: (() => void) | undefined
onMounted(() => {
  contentEl.value?.addEventListener('focusin', noteTouched)
  contentEl.value?.addEventListener('pointerdown', noteTouched)
  removeLeaveGuard = router?.beforeEach((to, from) => {
    // A filter or sort change rewrites the query of the same page: still here.
    if (to.path !== from.path) rememberLeavingRow()
  })
})
onBeforeUnmount(() => {
  removeLeaveGuard?.()
  contentEl.value?.removeEventListener('focusin', noteTouched)
  contentEl.value?.removeEventListener('pointerdown', noteTouched)
})

defineExpose({ contentEl })
</script>

<template>
  <div
    class="page"
    :class="[`page--scroll-${scroll}`, `page--width-${width}`]"
    :data-page-ready="ready ? 'true' : 'false'"
  >
    <!-- Sticky part: title row (sticky-header), toolbar, notices, selection
         bar. In the shell this lands in the app's stack; elsewhere it
         renders right here. -->
    <Teleport v-if="hasStackContent" :to="stackTarget" :disabled="!hasStackTarget">
      <div class="page-stack" :class="[`page--width-${width}`, { 'page-stack--inline': !hasStackTarget }]">
        <header v-if="stickyHeader" class="page-header page-header--sticky" data-testid="page-header">
          <div class="page-heading">
            <h1 class="page-title">{{ title }}</h1>
          </div>
          <div v-if="slots.actions" class="page-actions">
            <slot name="actions" />
          </div>
        </header>
        <div v-if="slots.toolbar" class="page-toolbar" data-testid="page-toolbar">
          <slot name="toolbar" />
        </div>
        <div v-if="slots.selection" class="page-selection" data-testid="page-selection">
          <slot name="selection" />
        </div>
        <div v-if="slots.notice" class="page-notice" data-testid="page-notice">
          <slot name="notice" />
        </div>
      </div>
    </Teleport>

    <!-- With a sticky header the hint stays on the page: it explains the
         page once, it does not need to follow the reader down. -->
    <p v-if="stickyHeader && hint" class="page-hint page-hint--lead">{{ hint }}</p>
    <header v-if="!stickyHeader" class="page-header">
      <div class="page-heading">
        <h1 class="page-title">{{ title }}</h1>
        <p v-if="hint" class="page-hint">{{ hint }}</p>
      </div>
      <div v-if="slots.actions" class="page-actions">
        <slot name="actions" />
      </div>
    </header>

    <div ref="contentEl" class="page-content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  /* The space between the title row and the content. A view whose content
     begins with a bar of its own that pins itself under the app's stack
     (the document viewer's head) closes it by setting `--page-gap`, so
     nothing of the content shows through above that bar while it scrolls
     past. */
  gap: var(--page-gap, var(--space-3));
  width: 100%;
  min-width: 0;
  padding: var(--space-3) var(--page-gutter) var(--space-5);
  margin-inline: auto;
}
.page--width-normal { max-width: var(--page-max-normal); }
.page--width-wide { max-width: var(--page-max-wide); }
.page--width-full { max-width: none; }

/* One viewport below the sticky stack, filled by the content (a map). */
.page--scroll-fill {
  height: calc(100dvh - var(--app-stack-height));
  padding-bottom: 0;
}
.page--scroll-fill .page-content {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  flex-shrink: 0;
  min-width: 0;
}
.page-heading {
  min-width: 0;
}
.page-title {
  margin: 0;
  font-size: var(--text-3xl);
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.page-hint {
  margin: var(--space-1) 0 0;
  color: var(--p-text-muted-color);
  font-size: var(--text-md);
}
/* In the sticky stack the title row is one line of the stack, not the
   head of the page: smaller, so the stack keeps the viewport for content. */
.page-header--sticky .page-title {
  font-size: var(--text-xl);
}
.page-hint--lead {
  margin: 0;
}
/* Actions wrap below the title on a narrow screen instead of pushing past
   the viewport edge; each button then wraps within the row. */
.page-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-left: auto;
}

.page-content {
  min-width: 0;
}

/* ── The sticky part ─────────────────────────────────────────────────────── */
.page-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  margin-inline: auto;
}
/* Without the app shell the block sits above the header, looking the same. */
.page-stack--inline {
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--p-content-border-color);
}
/* …unless every slot is currently v-if'd away: then no strip at all. */
.page-stack--inline:not(:has(.page-toolbar:not(:empty), .page-selection:not(:empty), .page-notice:not(:empty))) {
  display: none;
}
.page-toolbar,
.page-selection,
.page-notice {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
/* A slot whose content is currently v-if'd away (no selection, no error)
   leaves only a comment node behind; :empty ignores comments, so the
   wrapper takes no space and adds no gap. */
.page-toolbar:empty,
.page-selection:empty,
.page-notice:empty {
  display: none;
}

@media (max-width: 639px) {
  .page-title {
    font-size: var(--text-2xl);
  }
  /* On a phone the actions stay beside the title rather than wrapping under
     it, so the sticky row costs one line; the title gives way. */
  .page-header--sticky {
    flex-wrap: nowrap;
  }
  .page-header--sticky .page-title {
    font-size: var(--text-lg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>
