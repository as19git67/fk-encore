<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import Message from 'primevue/message'
import {
  createForecastShare,
  deleteForecastShare,
  getForecastShareCandidates,
  getForecastSharing,
  updateForecastShare,
  type ForecastShare,
  type ForecastShareCandidates,
  type ForecastSharingState,
} from '../../../api/finance'

/**
 * Sharing the forecast within the household: with a person or with one of
 * the owner's groups, to edit or to view. Whoever it is shared with works
 * on the same forecast; nothing is copied.
 */

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'changed'): void
}>()

const LEVELS = [
  { value: 'edit', label: 'Bearbeiten' },
  { value: 'view', label: 'Nur ansehen' },
]

const state = ref<ForecastSharingState | null>(null)
const candidates = ref<ForecastShareCandidates>({ users: [], groups: [] })
const target = ref<string | null>(null)
const level = ref<'edit' | 'view'>('edit')
const busy = ref(false)
const error = ref<string | null>(null)

const shareTargetName = (s: ForecastShare) => (s.userId != null ? s.userName : `Gruppe „${s.groupName}“`)

/** Targets not shared with yet, as "u:<id>" / "g:<id>". */
const targetOptions = computed(() => {
  const taken = new Set((state.value?.shares ?? []).map((s) => (s.userId != null ? `u:${s.userId}` : `g:${s.groupId}`)))
  return [
    ...candidates.value.users.map((u) => ({ value: `u:${u.id}`, label: `Person: ${u.name}` })),
    ...candidates.value.groups.map((g) => ({ value: `g:${g.id}`, label: `Gruppe: ${g.name}` })),
  ].filter((o) => !taken.has(o.value))
})

async function load() {
  error.value = null
  try {
    const [s, c] = await Promise.all([getForecastSharing(), getForecastShareCandidates()])
    state.value = s
    candidates.value = c
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      target.value = null
      level.value = 'edit'
      void load()
    }
  },
  { immediate: true },
)

async function run(fn: () => Promise<unknown>) {
  busy.value = true
  error.value = null
  try {
    await fn()
    await load()
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

const add = () =>
  target.value &&
  run(async () => {
    const [kind, id] = target.value!.split(':')
    await createForecastShare(kind === 'u' ? { userId: Number(id), level: level.value } : { groupId: Number(id), level: level.value })
    target.value = null
  })
const setLevel = (s: ForecastShare, v: 'edit' | 'view') => run(() => updateForecastShare(s.id, v))
const remove = (s: ForecastShare) => run(() => deleteForecastShare(s.id))
</script>

<template>
  <Dialog :visible="visible" modal class="dialog-md" header="Prognose teilen" @update:visible="emit('update:visible', $event)">
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <template v-if="state && state.role !== 'owner'">
      <p>
        Diese Prognose gehört {{ state.ownerName ?? 'jemand anderem' }}. Du kannst sie
        {{ state.role === 'edit' ? 'bearbeiten' : 'nur ansehen' }}. Freigaben verwaltet {{ state.ownerName ?? 'die Eigentümerin oder der Eigentümer' }}.
      </p>
    </template>

    <template v-else-if="state">
      <p class="muted share__hint">
        Wer die Prognose geteilt bekommt, arbeitet mit dir an derselben Prognose – nichts wird doppelt gepflegt.
        Sichtbar werden dabei auch die Salden verknüpfter Konten (nicht deren Umsätze) sowie Titel und gelesene Werte zugeordneter
        Standmitteilungen; die Dokumente selbst bleiben privat.
      </p>

      <h3 class="share__title">Geteilt mit</h3>
      <p v-if="state.shares.length === 0" class="muted">Noch mit niemandem.</p>
      <ul v-else class="share__list">
        <li v-for="s in state.shares" :key="s.id" class="share__row">
          <span class="share__name">{{ shareTargetName(s) }}</span>
          <Select
            :model-value="s.level"
            :options="LEVELS"
            option-label="label"
            option-value="value"
            size="small"
            :disabled="busy"
            :aria-label="`Recht für ${shareTargetName(s)}`"
            @update:model-value="setLevel(s, $event)"
          />
          <Button
            icon="pi pi-times"
            text
            rounded
            size="small"
            severity="secondary"
            :disabled="busy"
            :aria-label="`Freigabe für ${shareTargetName(s)} beenden`"
            @click="remove(s)"
          />
        </li>
      </ul>

      <h3 class="share__title">Neu freigeben</h3>
      <div class="share__add">
        <Select
          v-model="target"
          :options="targetOptions"
          option-label="label"
          option-value="value"
          placeholder="Person oder Gruppe"
          size="small"
          aria-label="Person oder Gruppe"
          class="share__target"
        />
        <Select v-model="level" :options="LEVELS" option-label="label" option-value="value" size="small" aria-label="Recht" />
        <Button label="Freigeben" icon="pi pi-share-alt" size="small" :disabled="!target || busy" @click="add" />
      </div>
      <p v-if="targetOptions.length === 0" class="muted share__hint">
        Keine weiteren Personen mit Zugriff auf Finanzen und keine weiteren eigenen Gruppen.
      </p>
    </template>

    <template #footer>
      <Button label="Schließen" severity="secondary" text @click="emit('update:visible', false)" />
    </template>
  </Dialog>
</template>

<style scoped>
.share__hint {
  font-size: var(--text-sm);
  margin: 0 0 var(--space-3);
}
.share__title {
  font-size: var(--text-base);
  margin: var(--space-3) 0 var(--space-2);
}
.share__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.share__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  border-bottom: 1px solid var(--p-content-border-color);
}
.share__name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.share__add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.share__target {
  flex: 1;
  min-width: 12rem;
}
.muted {
  color: var(--p-text-muted-color);
}
</style>
