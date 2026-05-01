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
  type UnknownBankAccount,
} from '../../api/finance'
import TanDialog from '../../components/finance/TanDialog.vue'

const route = useRoute()
const router = useRouter()
const store = useBankcontactsStore()
const accountsStore = useAccountsStore()

const isNew = computed(() => route.name === 'finance-bankcontact-new')

const isDirty = computed(() => {
  if (isNew.value) return true
  if (!bc.value) return false
  return (
    form.value.name.trim() !== bc.value.name ||
    form.value.blz.trim() !== bc.value.blz ||
    form.value.login.trim() !== bc.value.login ||
    form.value.server_url.trim() !== bc.value.server_url ||
    (form.value.tan_method.trim() || null) !== (bc.value.tan_method ?? null)
  )
})

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
const syncing = ref(false)
const probingMethods = ref(false)
const tanMethodOptions = ref<TanMethodOption[]>([])
const tanProbeInfo = ref<string | null>(null)
const syncInfo = ref<string | null>(null)
const errorMsg = ref<string | null>(null)
const bc = ref<Bankcontact | null>(null)
/** Bank-side accounts the most recent sync reported that aren't
 *  linked to any finance_account yet. User resolves row by row
 *  (Import / Link / Ignore). */
const pendingUnknown = ref<UnknownBankAccount[]>([])

const myAccounts = computed(() => {
  if (!bc.value) return []
  const bcId = bc.value.id
  return accountsStore.items
    .filter((a) => a.bankcontact_id === bcId)
    .sort((a, b) => a.label.localeCompare(b.label))
})

/** Manual (not-yet-linked) accounts that the user could pick to link
 *  an unknown bank-side account to. Needed for the per-row
 *  "Mit existierendem Konto verknüpfen"-dropdown in the pending
 *  block. */
const manualAccounts = computed(() =>
  accountsStore.items
    .filter((a) => a.bankcontact_id === null)
    .sort((a, b) => a.label.localeCompare(b.label)),
)

const accountKindLabels: Record<string, string> = {
  giro: 'Giro',
  tagesgeld: 'Tagesgeld',
  festgeld: 'Festgeld',
  kredit: 'Kredit',
  depot: 'Depot',
  bausparen: 'Bausparen',
  kreditkarte: 'Kreditkarte',
  sonstige: 'Sonstige',
}

function kindLabel(kind: string): string {
  return accountKindLabels[kind] ?? kind
}

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
      if (pin.value) {
        await store.setCredentials(created.id, pin.value)
        pin.value = ''
      }
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
      if (pin.value) {
        await store.setCredentials(bc.value.id, pin.value)
        pin.value = ''
        bc.value = { ...bc.value, credentials_set: true }
      }
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
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
      if (resp.accounts_matched !== undefined) {
        parts.push(`${resp.accounts_matched} Konten aktualisiert`)
      }
      if (resp.transactions_inserted !== undefined) {
        parts.push(`${resp.transactions_inserted} neue Transaktionen`)
      }
      if (resp.balances_written !== undefined) {
        parts.push(`${resp.balances_written} Salden`)
      }
      if (resp.accounts_unknown && resp.accounts_unknown > 0) {
        parts.push(`${resp.accounts_unknown} noch nicht zugeordnete Konten`)
      }
      syncInfo.value = parts.length
        ? `Sync erfolgreich — ${parts.join(', ')}${resp.partial ? ' (teilweise; einige Konten brauchten TAN)' : ''}.`
        : 'Sync erfolgreich.'
      pendingUnknown.value = resp.unknown_accounts ?? []
      // Refresh accounts store so the "Konten"-section below
      // reflects what the sync just wrote.
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

async function importUnknown(entry: UnknownBankAccount) {
  if (!bc.value) return
  errorMsg.value = null
  try {
    await accountsStore.create({
      bankcontact_id: bc.value.id,
      fints_account_number: entry.accountNumber,
      type_kind: entry.accountKind,
      currency_code: entry.currency,
      iban: entry.iban ?? undefined,
      account_number: entry.accountNumber,
      label: entry.label,
    })
    pendingUnknown.value = pendingUnknown.value.filter(
      (u) => u.accountNumber !== entry.accountNumber,
    )
    syncInfo.value = `Konto "${entry.label}" als neues Konto importiert.`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  }
}

async function linkUnknown(entry: UnknownBankAccount, accountId: number) {
  if (!bc.value) return
  errorMsg.value = null
  try {
    await accountsStore.link(accountId, {
      bankcontact_id: bc.value.id,
      fints_account_number: entry.accountNumber,
    })
    pendingUnknown.value = pendingUnknown.value.filter(
      (u) => u.accountNumber !== entry.accountNumber,
    )
    syncInfo.value = `Bank-Konto "${entry.label}" mit bestehendem Konto verknüpft.`
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  }
}

function ignoreUnknown(entry: UnknownBankAccount) {
  pendingUnknown.value = pendingUnknown.value.filter(
    (u) => u.accountNumber !== entry.accountNumber,
  )
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
  const msg = attached > 0
    ? `Bankkontakt "${bc.value.name}" löschen? ${attached} verknüpfte Konten ` +
        `fallen auf manuell zurück (Transaktionen bleiben erhalten).`
    : `Bankkontakt "${bc.value.name}" wirklich löschen?`
  if (!confirm(msg)) return
  try {
    await store.remove(bc.value.id)
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
        <label>
          Passwort / PIN
          <Tag
            v-if="!isNew && bc"
            class="cred-tag"
            :severity="bc.credentials_set ? 'success' : 'warn'"
            :value="bc.credentials_set ? 'gesetzt' : 'nicht gesetzt'"
          />
        </label>
        <Password v-model="pin" :feedback="false" toggle-mask :placeholder="(!isNew && bc?.credentials_set) ? '(unverändert lassen)' : 'PIN eingeben'" />
      </div>
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
            panel-class="tan-method-panel"
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
        <Button label="Speichern" :loading="saving" :disabled="!isDirty && !pin" @click="save" />
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

    <section v-if="!isNew && bc && pendingUnknown.length > 0" class="card">
      <h2>Noch nicht zugeordnete Bank-Konten</h2>
      <p class="hint">
        Die Bank hat diese Konten gemeldet, die noch nicht mit einem
        fk-encore-Konto verknüpft sind. Pro Konto entscheiden:
      </p>
      <ul class="pending-list">
        <li
          v-for="entry in pendingUnknown"
          :key="entry.accountNumber"
          class="pending-item"
        >
          <div class="pending-main">
            <strong>{{ entry.label || entry.accountNumber }}</strong>
            <Tag
              class="type-tag"
              :value="kindLabel(entry.accountKind)"
              severity="info"
            />
          </div>
          <div class="pending-meta">
            <span v-if="entry.iban">{{ entry.iban }}</span>
            <span v-else>Kontonr. {{ entry.accountNumber }}</span>
            <span class="currency">{{ entry.currency }}</span>
          </div>
          <div class="pending-actions">
            <Button
              label="Als neues Konto importieren"
              icon="pi pi-plus"
              severity="primary"
              @click="importUnknown(entry)"
            />
            <Select
              v-if="manualAccounts.length > 0"
              :options="manualAccounts"
              option-label="label"
              option-value="id"
              placeholder="Mit bestehendem verknüpfen"
              class="link-select"
              @change="(ev: any) => linkUnknown(entry, Number(ev.value))"
            />
            <Button
              label="Ignorieren"
              severity="secondary"
              text
              @click="ignoreUnknown(entry)"
            />
          </div>
        </li>
      </ul>
    </section>

    <section v-if="!isNew && bc" class="card">
      <h2>Konten</h2>
      <p v-if="myAccounts.length === 0" class="hint">
        Noch keine Konten verknüpft. Nach dem ersten erfolgreichen Sync
        erscheinen die von der Bank gemeldeten Konten oben als "Noch
        nicht zugeordnet" — du kannst sie dort importieren oder mit
        einem bestehenden manuellen Konto verknüpfen.
      </p>
      <ul v-else class="account-list">
        <li v-for="a in myAccounts" :key="a.id" class="account-item">
          <div class="account-body">
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
          </div>
          <div class="account-actions">
            <Button
              class="account-open"
              label="Öffnen"
              icon="pi pi-external-link"
              severity="secondary"
              text
              aria-label="Konto öffnen"
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
@media (max-width: 640px) {
  .page {
    padding: 0.75rem;
    gap: 0.75rem;
  }
  .card {
    padding: 0.75rem;
  }
  .pending-item,
  .account-item {
    padding: 0.5rem;
    gap: 0.25rem;
  }
  /* Collapse "Öffnen" to an icon-only button — the icon already
     conveys the action. The aria-label keeps it accessible. */
  .account-open :deep(.p-button-label) {
    display: none;
  }
  .account-open :deep(.p-button-icon) {
    margin: 0;
  }
  /* Wrap the big pending-actions row onto its own line and let the
     primary button grow instead of overflowing. */
  .pending-actions {
    gap: 0.35rem;
  }
  .pending-actions > * {
    flex: 1 1 auto;
    min-width: 0;
  }
  .link-select {
    min-width: 0;
  }
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
  /* Without min-width: 0 a flex item refuses to shrink below its
   * content width — which lets a long Select-label push the
   * "Abrufen"-button off the right edge on narrow viewports. */
  min-width: 0;
}
/* Truncate the displayed selection in the trigger; the full text
 * is still visible inside the dropdown panel. */
.tan-method-select :deep(.p-select-label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.cred-tag {
  font-size: 0.75rem;
  margin-left: 0.4rem;
  vertical-align: middle;
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
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.25rem;
  background: var(--p-content-hover-background);
  border-bottom: 1px solid var(--p-content-border-color);
}
.account-item:last-child {
  border-bottom: none;
}
.account-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.account-actions {
  flex-shrink: 0;
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.account-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.account-main strong {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.account-meta {
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.account-meta .currency {
  font-variant: tabular-nums;
}
.type-tag {
  font-size: 0.75rem;
}
.pending-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.pending-item {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.75rem;
  border: 1px dashed var(--p-content-border-color);
  border-radius: 0.25rem;
  background: var(--p-content-hover-background);
}
.pending-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.pending-meta {
  color: var(--p-text-muted-color);
  font-size: 0.875rem;
  display: flex;
  gap: 0.75rem;
}
.pending-meta .currency {
  font-variant: tabular-nums;
}
.pending-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.link-select {
  min-width: 18rem;
}
.danger-zone {
  border-color: var(--p-red-500);
}
</style>
