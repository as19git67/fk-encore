<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Button from 'primevue/button'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import { useBankcontactsStore } from '../../stores/finance/bankcontacts'
import {
  probeTanMethods,
  type Bankcontact,
  type TanMethodOption,
} from '../../api/finance'
import TanDialog from '../../components/finance/TanDialog.vue'

const route = useRoute()
const router = useRouter()
const store = useBankcontactsStore()

const isNew = computed(() => route.name === 'finance-bankcontact-new')

const form = ref<{
  name: string
  blz: string
  login: string
  server_url: string
  tan_method: string
}>({
  name: '',
  blz: '',
  login: '',
  server_url: '',
  tan_method: '',
})

const pin = ref('')
const saving = ref(false)
const savingPin = ref(false)
const syncing = ref(false)
const probingMethods = ref(false)
const tanMethodOptions = ref<TanMethodOption[]>([])
const tanProbeInfo = ref<string | null>(null)
const errorMsg = ref<string | null>(null)
const bc = ref<Bankcontact | null>(null)

// Dropdown entries combine the probed list with whatever is currently
// stored on the bankcontact — so an admin who already knows the ID
// keeps seeing it selected even before re-probing.
const tanMethodSelectOptions = computed(() => {
  const opts: Array<{ id: string; label: string; isDecoupled: boolean }> = []
  for (const m of tanMethodOptions.value) {
    opts.push({
      id: String(m.id),
      label: `${m.id} — ${m.name}${m.isDecoupled ? ' (decoupled)' : ''}`,
      isDecoupled: m.isDecoupled,
    })
  }
  // If the stored id isn't in the probed list (or we haven't probed
  // yet), surface it as a read-only option so it stays selected.
  const existing = form.value.tan_method.trim()
  if (existing && !opts.some((o) => o.id === existing)) {
    opts.push({
      id: existing,
      label: `${existing} — (aktuell gespeichert, nicht abgerufen)`,
      isDecoupled: false,
    })
  }
  return opts
})

onMounted(async () => {
  if (store.items.length === 0) await store.refresh()
  if (isNew.value) return
  const id = Number(route.params.id)
  const existing = store.items.find((b) => b.id === id)
  if (existing) {
    bc.value = existing
    form.value.name = existing.name
    form.value.blz = existing.blz
    form.value.login = existing.login
    form.value.server_url = existing.server_url
    form.value.tan_method = existing.tan_method ?? ''
  }
})

async function save() {
  saving.value = true
  errorMsg.value = null
  try {
    if (isNew.value) {
      const created = await store.create({
        name: form.value.name.trim(),
        blz: form.value.blz.trim(),
        login: form.value.login.trim(),
        server_url: form.value.server_url.trim(),
        tan_method: form.value.tan_method.trim() || undefined,
      })
      void router.push({ name: 'finance-bankcontact-detail', params: { id: created.id } })
    } else if (bc.value) {
      const updated = await store.update(bc.value.id, {
        name: form.value.name.trim(),
        blz: form.value.blz.trim(),
        login: form.value.login.trim(),
        server_url: form.value.server_url.trim(),
        tan_method: form.value.tan_method.trim() || null,
      })
      bc.value = updated
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

async function setCreds() {
  if (!bc.value) return
  savingPin.value = true
  errorMsg.value = null
  try {
    await store.setCredentials(bc.value.id, pin.value)
    pin.value = ''
    bc.value = { ...bc.value, credentials_set: true }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    savingPin.value = false
  }
}

async function probeMethods() {
  if (!bc.value) return
  probingMethods.value = true
  errorMsg.value = null
  tanProbeInfo.value = null
  try {
    const resp = await probeTanMethods(bc.value.id)
    if (resp.state === 'ok') {
      tanMethodOptions.value = resp.methods
      if (resp.methods.length === 0) {
        tanProbeInfo.value = 'Bank lieferte keine TAN-Verfahren.'
      } else {
        tanProbeInfo.value = `${resp.methods.length} Verfahren gefunden.`
      }
    } else if (resp.state === 'tan-required') {
      errorMsg.value = `${resp.errorCode}: ${resp.errorMessage}`
    } else {
      errorMsg.value = `${resp.errorCode}: ${resp.errorMessage}`
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    probingMethods.value = false
  }
}

async function triggerSync() {
  if (!bc.value) return
  syncing.value = true
  errorMsg.value = null
  try {
    const resp = await store.syncNow(bc.value.id)
    if (resp.state === 'error') {
      errorMsg.value = `${resp.errorCode}: ${resp.errorMessage}`
    }
    const refreshed = store.items.find((b) => b.id === bc.value!.id)
    if (refreshed) bc.value = refreshed
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    syncing.value = false
  }
}

async function del() {
  if (!bc.value) return
  if (!confirm(`Bankkontakt "${bc.value.name}" wirklich löschen?`)) return
  try {
    await store.remove(bc.value.id)
    void router.push({ name: 'finance-bankcontacts' })
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>{{ isNew ? 'Bankkontakt anlegen' : bc?.name ?? 'Bankkontakt' }}</h1>
      <Button
        label="Zurück"
        icon="pi pi-arrow-left"
        severity="secondary"
        text
        @click="router.push({ name: 'finance-bankcontacts' })"
      />
    </header>

    <Message v-if="errorMsg" severity="error" :closable="true" @close="errorMsg = null">
      {{ errorMsg }}
    </Message>

    <section class="card">
      <h2>Stammdaten</h2>
      <div class="field"><label>Name</label><InputText v-model="form.name" /></div>
      <div class="field"><label>BLZ</label><InputText v-model="form.blz" /></div>
      <div class="field"><label>Login</label><InputText v-model="form.login" /></div>
      <div class="field"><label>Server-URL</label><InputText v-model="form.server_url" /></div>
      <div class="field">
        <label>TAN-Verfahren</label>
        <div v-if="!isNew && bc?.credentials_set" class="tan-method-row">
          <Select
            v-model="form.tan_method"
            :options="tanMethodSelectOptions"
            option-label="label"
            option-value="id"
            placeholder="Zuerst 'Abrufen' klicken"
            :disabled="tanMethodSelectOptions.length === 0"
            class="tan-method-select"
          />
          <Button
            label="Abrufen"
            icon="pi pi-refresh"
            severity="secondary"
            :loading="probingMethods"
            @click="probeMethods"
          />
        </div>
        <InputText
          v-else
          v-model="form.tan_method"
          placeholder="z. B. 942 — nach Credential-Set abrufbar"
        />
        <small v-if="tanProbeInfo" class="probe-info">{{ tanProbeInfo }}</small>
        <small v-else-if="!isNew && !bc?.credentials_set" class="probe-info">
          Passwort setzen, um die Verfahren bei der Bank abzufragen.
        </small>
      </div>
      <div class="actions">
        <Button label="Speichern" :loading="saving" @click="save" />
      </div>
    </section>

    <section v-if="!isNew && bc" class="card">
      <h2>Credentials</h2>
      <p class="hint">
        <template v-if="bc.credentials_set">
          <Tag severity="success" value="Verschlüsselt gespeichert" />
        </template>
        <template v-else>
          <Tag severity="warn" value="Kein Passwort gesetzt" />
        </template>
      </p>
      <div class="field">
        <label>Neues Passwort / PIN</label>
        <Password v-model="pin" :feedback="false" toggle-mask />
      </div>
      <div class="actions">
        <Button
          label="Setzen"
          :loading="savingPin"
          :disabled="!pin"
          @click="setCreds"
        />
      </div>
    </section>

    <section v-if="!isNew && bc" class="card">
      <h2>Sync</h2>
      <p class="hint">
        Letzter Sync: {{ bc.last_sync_at ? new Date(bc.last_sync_at).toLocaleString('de-DE') : '—' }}
        <Tag
          v-if="bc.last_sync_status"
          class="status-tag"
          :severity="bc.last_sync_status === 'ok' ? 'success' : bc.last_sync_status === 'tan-required' ? 'warn' : 'danger'"
          :value="bc.last_sync_status"
        />
      </p>
      <div class="actions">
        <Button
          label="Sync jetzt"
          icon="pi pi-refresh"
          :loading="syncing"
          @click="triggerSync"
        />
        <Button
          label="Sync-Zeiten bearbeiten"
          severity="secondary"
          text
          @click="router.push({ name: 'finance-bankcontact-schedule', params: { id: bc.id } })"
        />
      </div>
    </section>

    <section v-if="!isNew && bc" class="card danger-zone">
      <h2>Gefahrenzone</h2>
      <Button label="Bankkontakt löschen" icon="pi pi-trash" severity="danger" @click="del" />
    </section>

    <TanDialog />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  max-width: 48rem;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.page-header h1 {
  margin: 0;
}
.card {
  border: 1px solid var(--p-content-border-color);
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.card h2 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.hint {
  margin: 0;
}
.status-tag {
  margin-left: 0.5rem;
}
.tan-method-row {
  display: flex;
  gap: 0.5rem;
  align-items: stretch;
}
.tan-method-select {
  flex: 1;
}
.probe-info {
  color: var(--p-text-muted-color);
}
.danger-zone {
  border-color: var(--p-red-500);
}
</style>
