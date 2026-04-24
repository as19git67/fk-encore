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
import { useAccountsStore } from '../../stores/finance/accounts'
import {
  probeTanMethods,
  type Bankcontact,
  type TanMethodOption,
} from '../../api/finance'
import TanDialog from '../../components/finance/TanDialog.vue'

const route = useRoute()
const router = useRouter()
const store = useBankcontactsStore()
const accountsStore = useAccountsStore()

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
const syncInfo = ref<string | null>(null)
const errorMsg = ref<string | null>(null)
const bc = ref<Bankcontact | null>(null)

const myAccounts = computed(() => {
  if (!bc.value) return []
  return accountsStore.items
    .filter((a) => a.bankcontact_id === bc.value!.id)
    .sort((a, b) => a.label.localeCompare(b.label))
})

// Dropdown entries are built from the cached list on the bankcontact
// (persisted by the last successful probe) merged with any fresh
// probe result from this session. Labels avoid the technical FinTS
// id in the visible part — the user picks by bank-supplied name.
const tanMethodSelectOptions = computed(() => {
  const seen = new Set<string>()
  const opts: Array<{ id: string; label: string; isDecoupled: boolean }> = []
  const pushOption = (m: TanMethodOption) => {
    const key = String(m.id)
    if (seen.has(key)) return
    seen.add(key)
    const suffix = m.isDecoupled ? ' — Push-Freigabe' : ''
    opts.push({ id: key, label: `${m.name}${suffix}`, isDecoupled: m.isDecoupled })
  }
  // Fresh probe (this session) takes precedence over the cache.
  for (const m of tanMethodOptions.value) pushOption(m)
  for (const m of bc.value?.available_tan_methods ?? []) pushOption(m)

  // If the stored id isn't in either list, still keep it selected —
  // rare (e.g. right after an admin edited the raw tan_method
  // column). Label stays short and non-technical.
  const existing = form.value.tan_method.trim()
  if (existing && !seen.has(existing)) {
    opts.push({
      id: existing,
      label: `Zuletzt gewählt — bitte „Abrufen" klicken`,
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
    // Seed the fresh-probe ref from the cache so the picker is
    // populated immediately on page load.
    tanMethodOptions.value = existing.available_tan_methods ?? []
  }
  // Populate the accounts store so the "Konten" section can filter
  // by bankcontact_id without each view re-fetching.
  if (accountsStore.items.length === 0) await accountsStore.refresh()
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
      // Refresh the store so a later navigation away and back shows
      // the populated picker from the cache (the backend already
      // persisted resp.methods on finance_bankcontact).
      await store.refresh()
      const refreshed = store.items.find((b) => b.id === bc.value!.id)
      if (refreshed) bc.value = refreshed
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
  syncInfo.value = null
  try {
    const resp = await store.syncNow(bc.value.id)
    if (resp.state === 'error') {
      errorMsg.value = `${resp.errorCode}: ${resp.errorMessage}`
    } else if (resp.state === 'idle') {
      const parts: string[] = []
      if (resp.accounts_seen !== undefined) {
        parts.push(`${resp.accounts_seen} Konten erkannt`)
      }
      if (resp.transactions_inserted !== undefined) {
        parts.push(`${resp.transactions_inserted} neue Transaktionen`)
      }
      if (resp.balances_written !== undefined) {
        parts.push(`${resp.balances_written} Salden`)
      }
      syncInfo.value = parts.length
        ? `Sync erfolgreich — ${parts.join(', ')}${resp.partial ? ' (teilweise; einige Konten brauchten TAN)' : ''}.`
        : 'Sync erfolgreich.'
      // Refresh the accounts store so freshly auto-created accounts
      // appear in the "Konten"-section below without a page reload.
      await accountsStore.refresh()
    }
    const refreshed = store.items.find((b) => b.id === bc.value!.id)
    if (refreshed) bc.value = refreshed
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    syncing.value = false
  }
}

async function deleteOneAccount(id: number, label: string) {
  const ok = confirm(
    `Konto "${label}" wirklich löschen? Alle Transaktionen, Tags ` +
      `und die Saldo-Historie für dieses Konto werden entfernt.`,
  )
  if (!ok) return
  try {
    const resp = await accountsStore.remove(id)
    syncInfo.value = `Konto gelöscht — ${resp.transactions_deleted} Transaktionen entfernt.`
    errorMsg.value = null
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  }
}

async function del() {
  if (!bc.value) return
  const attached = myAccounts.value.length
  let cascade = false
  if (attached > 0) {
    const ok = confirm(
      `Bankkontakt "${bc.value.name}" hat ${attached} verknüpfte Konten. ` +
        `Mit Löschen werden *alle* Konten und ihre Transaktionen unwiderruflich entfernt.\n\n` +
        `Fortfahren?`,
    )
    if (!ok) return
    cascade = true
  } else {
    if (!confirm(`Bankkontakt "${bc.value.name}" wirklich löschen?`)) return
  }
  try {
    await store.remove(bc.value.id, { cascade })
    await accountsStore.refresh()
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
      <Message
        v-if="syncInfo"
        severity="success"
        :closable="true"
        @close="syncInfo = null"
      >
        {{ syncInfo }}
      </Message>
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

    <section v-if="!isNew && bc" class="card">
      <h2>Konten</h2>
      <p v-if="myAccounts.length === 0" class="hint">
        Noch keine Konten verknüpft. Nach dem ersten erfolgreichen Sync
        werden die von der Bank zurückgelieferten Konten automatisch hier
        angezeigt.
      </p>
      <ul v-else class="account-list">
        <li v-for="a in myAccounts" :key="a.id" class="account-item">
          <div class="account-main">
            <strong>{{ a.label || a.account_number }}</strong>
            <Tag class="type-tag" :value="a.type_label" severity="info" />
            <Tag
              v-if="!a.active"
              class="type-tag"
              value="inaktiv"
              severity="secondary"
            />
          </div>
          <div class="account-meta">
            <span v-if="a.iban">{{ a.iban }}</span>
            <span v-else>Kontonr. {{ a.account_number }}</span>
            <span class="currency">{{ a.currency_symbol || a.currency_code }}</span>
          </div>
          <div class="account-actions">
            <Button
              label="Öffnen"
              icon="pi pi-arrow-right"
              severity="secondary"
              text
              @click="router.push({ name: 'finance-account-detail', params: { id: a.id } })"
            />
            <Button
              icon="pi pi-trash"
              severity="danger"
              text
              aria-label="Konto löschen"
              @click="deleteOneAccount(a.id, a.label || a.account_number)"
            />
          </div>
        </li>
      </ul>
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
.account-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.account-item {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 0.1rem 0.75rem;
  align-items: center;
  padding: 0.5rem 0.75rem;
  border-radius: 0.25rem;
  background: var(--p-surface-50, var(--p-content-background));
}
.account-actions {
  grid-row: 1 / span 2;
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.account-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.account-main strong {
  font-weight: 600;
}
.account-meta {
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
  display: flex;
  gap: 0.75rem;
}
.account-meta .currency {
  font-variant: tabular-nums;
}
.type-tag {
  font-size: 0.75rem;
}
.danger-zone {
  border-color: var(--p-red-500);
}
</style>
