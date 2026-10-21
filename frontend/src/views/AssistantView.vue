<script setup lang="ts">
/**
 * The assistant (documentation/plans/ki-assistent.md, stage 3, #1528).
 *
 * One chat over everything the user may see. A question is posted to the
 * server, which runs the model and the tools as this user; the answer streams
 * in over a WebSocket that only watches the turn, and the rows the tools found
 * render beside it with the module's own rows and a link to the list page.
 *
 * The open conversation lives in `?c=<id>`, so a reload or a link shows it.
 * `?context=document:12,…` (from a selection or "Antwort entwerfen", #1534)
 * starts a new conversation with that working set, `?prompt=` fills the
 * question field.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Drawer from 'primevue/drawer'
import { useConfirm } from 'primevue/useconfirm'
import PageLayout from '../components/layout/PageLayout.vue'
import { navigatedFromHistory } from '../utils/scrollMemory'
import ErrorBanner from '../components/layout/ErrorBanner.vue'
import AssistantComposer from '../components/assistant/AssistantComposer.vue'
import AssistantMessage from '../components/assistant/AssistantMessage.vue'
import ConversationList from '../components/assistant/ConversationList.vue'
import ContextMeter from '../components/assistant/ContextMeter.vue'
import {
  ask,
  createConversation,
  deleteConversation,
  followTurn,
  getConversation,
  listConversations,
  newTurnId,
  setConversationContext,
  type ContextItem,
  type ConversationMessage,
  type ConversationSummary,
} from '../api/assistant'
import { parseContextQuery } from '../utils/assistantContext'
import { ApiError } from '../api/client'
import { useAuthStore } from '../stores/auth'
import { useAtLeast } from '../composables/useBreakpoint'
import { applyEvent, emptyTurn, suggestedQuestions, type LiveTurn } from '../utils/assistantTurn'
import { latestUsage } from '../utils/contextUsage'

/** How long the server usually needs to name a new conversation. */
const TITLE_RELOAD_MS = 8000

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const confirm = useConfirm()
const wide = useAtLeast('lg')

const conversations = ref<ConversationSummary[]>([])
const messages = ref<ConversationMessage[]>([])
/** The working set of the open conversation. */
const context = ref<ContextItem[]>([])
const live = ref<LiveTurn | null>(null)
/** The conversation the running turn belongs to. */
const liveFor = ref<number | null>(null)
const draft = ref('')
const busy = ref(false)
const loaded = ref(false)
const loadError = ref<string | null>(null)
const sendError = ref<string | null>(null)
const drawerOpen = ref(false)

const messagesEl = ref<HTMLElement | null>(null)
const composer = ref<InstanceType<typeof AssistantComposer> | null>(null)

const activeId = computed<number | null>(() => {
  const id = Number(route.query.c)
  return Number.isInteger(id) && id > 0 ? id : null
})

const suggestions = computed(() => suggestedQuestions((p) => auth.hasPermission(p)))
/** How full the window got in the newest answer of the open conversation. */
const usage = computed(() => latestUsage(messages.value))

function scrollToEnd() {
  void nextTick(() => {
    const el = messagesEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

async function loadConversations() {
  try {
    conversations.value = (await listConversations()).conversations
    loadError.value = null
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Unterhaltungen konnten nicht geladen werden'
  }
}

/** Set while a new conversation is being opened by its first question. */
let openedBySend: number | null = null

async function loadConversation(id: number | null) {
  if (id === null) {
    messages.value = []
    context.value = []
    return
  }
  if (id === openedBySend) return
  try {
    const detail = await getConversation(id)
    messages.value = detail.messages
    context.value = detail.context ?? []
    loadError.value = null
    // Coming back from a row opened out of an answer, `PageLayout` puts the
    // reader on that row (or the offset they left); anything else starts at
    // the newest message.
    if (!navigatedFromHistory()) scrollToEnd()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Die Unterhaltung konnte nicht geladen werden'
    messages.value = []
  }
}

watch(activeId, (id) => void loadConversation(id))

/** A selection handed over in the URL becomes a new conversation's working set. */
async function startFromQuery(): Promise<void> {
  const refs = parseContextQuery(route.query.context)
  const prompt = typeof route.query.prompt === 'string' ? route.query.prompt : ''
  if (!refs.length && !prompt && route.query.context === undefined) return
  const { context: _c, prompt: _p, ...rest } = route.query
  if (prompt) draft.value = prompt
  if (!refs.length) {
    await router.replace({ query: rest })
    return
  }
  try {
    const created = await createConversation(undefined, refs)
    await router.replace({ query: { ...rest, c: String(created.id) } })
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Die Unterhaltung konnte nicht angelegt werden'
    await router.replace({ query: rest })
  }
}

async function removeFromContext(item: ContextItem) {
  const id = activeId.value
  if (id === null) return
  const next = context.value.filter((c) => !(c.type === item.type && c.id === item.id))
  try {
    context.value = (await setConversationContext(id, next.map((c) => ({ type: c.type, id: c.id })))).context
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Der Kontext konnte nicht geändert werden'
  }
}

const CONTEXT_ICONS: Record<ContextItem['type'], string> = {
  document: 'pi pi-file',
  photo: 'pi pi-image',
  transaction: 'pi pi-euro',
}

onMounted(async () => {
  await startFromQuery()
  await Promise.all([loadConversations(), loadConversation(activeId.value)])
  loaded.value = true
  void nextTick(() => composer.value?.focus())
})

function openConversation(id: number | null) {
  drawerOpen.value = false
  sendError.value = null
  const { c: _c, ...rest } = route.query
  void router.push({ query: id === null ? rest : { ...rest, c: String(id) } })
  void nextTick(() => composer.value?.focus())
}

function sendErrorText(e: unknown): string {
  const code = e instanceof ApiError ? e.code : undefined
  if (code === 'unavailable') return 'Das Modell ist gerade beschäftigt oder wird neu geladen. Bitte gleich noch einmal versuchen.'
  if (code === 'resource_exhausted') return 'Zu viele Fragen in kurzer Zeit. Bitte einen Moment warten.'
  if (code === 'failed_precondition') return 'Diese Unterhaltung ist zu lang geworden. Bitte eine neue beginnen.'
  return e instanceof Error ? e.message : 'Die Frage konnte nicht beantwortet werden.'
}

async function send(question: string) {
  if (busy.value) return
  busy.value = true
  sendError.value = null
  let conversationId = activeId.value
  try {
    if (conversationId === null) {
      const created = await createConversation()
      conversations.value = [created, ...conversations.value]
      conversationId = created.id
      openedBySend = created.id
      messages.value = []
      await router.replace({ query: { ...route.query, c: String(created.id) } })
    }

    messages.value = [...messages.value, {
      id: -Date.now(), role: 'user', content: question, blocks: [], created_at: new Date().toISOString(),
    }]
    live.value = emptyTurn()
    liveFor.value = conversationId
    scrollToEnd()

    // Watch first, then ask: the stream replays what it missed, and if it
    // cannot connect the POST still brings the whole answer.
    const turnId = newTurnId()
    const stream = followTurn(turnId, (event) => {
      if (!live.value || activeId.value !== conversationId) return
      live.value = applyEvent(live.value, event)
      scrollToEnd()
    })
    await stream.ready
    try {
      const res = await ask(conversationId, question, turnId)
      // Someone may have opened another conversation meanwhile; the answer is
      // stored with its own and shows when that one is opened again.
      if (activeId.value === conversationId) {
        messages.value = [...messages.value, {
          id: res.message_id,
          role: 'assistant',
          content: res.answer,
          blocks: res.blocks,
          context_usage: res.context_usage ?? null,
          created_at: new Date().toISOString(),
        }]
      }
    } finally {
      stream.close()
    }
    void loadConversations()
    // The server names a new conversation after its first answer, in the
    // background; look again once that has had time to finish.
    if (openedBySend === conversationId) setTimeout(() => void loadConversations(), TITLE_RELOAD_MS)
  } catch (e) {
    sendError.value = sendErrorText(e)
    // The question stays in the field, so asking again is one key away.
    if (!draft.value) draft.value = question
    messages.value = messages.value.filter((m) => m.id >= 0)
  } finally {
    live.value = null
    liveFor.value = null
    busy.value = false
    openedBySend = null
    scrollToEnd()
    void nextTick(() => composer.value?.focus())
  }
}

function remove(conversation: ConversationSummary) {
  confirm.require({
    message: `Die Unterhaltung „${conversation.title || 'Neue Unterhaltung'}“ mit allen Fragen und Antworten löschen?`,
    header: 'Unterhaltung löschen',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Abbrechen',
    acceptLabel: 'Löschen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteConversation(conversation.id)
        conversations.value = conversations.value.filter((c) => c.id !== conversation.id)
        if (activeId.value === conversation.id) openConversation(null)
      } catch (e) {
        loadError.value = e instanceof Error ? e.message : 'Die Unterhaltung konnte nicht gelöscht werden'
      }
    },
  })
}
</script>

<template>
  <PageLayout
    title="Assistent"
    scroll="self"
    width="wide"
    :ready="loaded"
    :scroller="messagesEl"
  >
    <template #actions>
      <Button
        v-if="!wide"
        icon="pi pi-list"
        label="Unterhaltungen"
        severity="secondary"
        text
        @click="drawerOpen = true"
      />
      <Button
        v-if="activeId !== null"
        icon="pi pi-plus"
        label="Neue Unterhaltung"
        severity="secondary"
        text
        @click="openConversation(null)"
      />
    </template>

    <template #notice>
      <ErrorBanner v-if="loadError" :message="loadError" closable @retry="loadConversations" @close="loadError = null" />
    </template>

    <div class="assistant">
      <aside v-if="wide" class="side">
        <ConversationList
          :conversations="conversations"
          :active-id="activeId"
          @select="openConversation"
          @start="openConversation(null)"
          @remove="remove"
        />
      </aside>

      <section class="chat" aria-label="Unterhaltung">
        <div ref="messagesEl" class="messages" aria-live="polite">
          <div v-if="!messages.length && !live" class="intro">
            <i class="pi pi-comments intro-icon" aria-hidden="true" />
            <p class="intro-text">
              Frag in deinen eigenen Worten. Der Assistent sieht nach, was du in der App sehen darfst,
              und zeigt die gefundenen Einträge zum Öffnen.
            </p>
            <ul v-if="suggestions.length" class="suggestions" aria-label="Vorschläge">
              <li v-for="s in suggestions" :key="s">
                <Button :label="s" severity="secondary" outlined size="small" :disabled="busy" @click="send(s)" />
              </li>
            </ul>
          </div>

          <AssistantMessage
            v-for="m in messages"
            :key="m.id"
            :role="m.role"
            :content="m.content"
            :blocks="m.blocks"
            :message-id="m.id > 0 ? m.id : undefined"
          />
          <AssistantMessage
            v-if="live && liveFor === activeId"
            role="assistant"
            :content="live.text"
            :steps="live.steps"
            :blocks="live.blocks"
            :error="live.error"
            pending
          />
        </div>

        <p v-if="sendError" class="send-error" role="alert">
          <i class="pi pi-exclamation-circle" aria-hidden="true" />
          {{ sendError }}
        </p>
        <div v-if="context.length" class="context" aria-label="Arbeitskontext">
          <span class="context-label">Kontext</span>
          <ul class="context-items">
            <li
              v-for="c in context"
              :key="`${c.type}:${c.id}`"
              class="context-item"
              :class="{ 'context-item--hidden': !c.visible }"
            >
              <i :class="CONTEXT_ICONS[c.type]" aria-hidden="true" />
              <span class="context-text">{{ c.label }}</span>
              <Button
                icon="pi pi-times"
                text
                rounded
                size="small"
                :aria-label="`${c.label} aus dem Kontext entfernen`"
                :disabled="busy"
                @click="removeFromContext(c)"
              />
            </li>
          </ul>
        </div>
        <AssistantComposer ref="composer" v-model="draft" :busy="busy" @send="send" />
        <ContextMeter v-if="usage && activeId !== null" :usage="usage" />
      </section>
    </div>

    <Drawer v-model:visible="drawerOpen" header="Unterhaltungen" position="left" class="conversations-drawer">
      <ConversationList
        :conversations="conversations"
        :active-id="activeId"
        @select="openConversation"
        @start="openConversation(null)"
        @remove="remove"
      />
    </Drawer>
  </PageLayout>
</template>

<style scoped>
/* Page frame and title: PageLayout (issue #1272). The page itself does not
   scroll; the messages do, and the question field stays at the bottom. */
/* Fills the page content and never outgrows it: the messages scroll, not
   the page, so the app's menu stays put while an answer streams in. */
.assistant {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: var(--space-4);
  flex: 1 1 auto;
  min-height: 0;
}

@media (min-width: 1024px) {
  .assistant {
    grid-template-columns: 16rem minmax(0, 1fr);
  }
}

.side {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-right: 1px solid var(--p-content-border-color);
  padding-right: var(--space-2);
}

.chat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* At either end a swipe stops here instead of moving the whole page —
     on a phone that dragged the app's menu along with the chat. */
  overscroll-behavior: contain;
  /* The containing block of the visually hidden headings inside: without
     it they are placed against <main>, outside this scroller, and every
     message made the whole document taller — the page scrolled and took
     the app's menu with it. */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  /* Room for the focus rings of the rows and links inside the scroller. */
  padding: var(--focus-ring-reach);
}

.intro {
  margin: auto 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  text-align: center;
  color: var(--p-text-muted-color);
}

.intro-icon {
  font-size: var(--text-4xl);
}

.intro-text {
  margin: 0;
  max-width: 32rem;
}

.suggestions {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

.suggestions :deep(.p-button) {
  white-space: normal;
  text-align: left;
}

.context {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
  font-size: var(--text-sm);
}

.context-label {
  color: var(--p-text-muted-color);
}

.context-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  min-width: 0;
}

.context-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  padding-left: var(--space-2);
  border: 1px solid var(--p-content-border-color);
  border-radius: 1rem;
  background: var(--p-content-hover-background);
}

.context-item--hidden {
  color: var(--p-text-muted-color);
}

.context-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 16rem;
}

.send-error {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--p-red-600);
}
</style>
