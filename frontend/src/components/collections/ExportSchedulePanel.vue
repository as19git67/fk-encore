<script setup lang="ts">
/**
 * "Regelmäßig exportieren" in the export dialog (#1548, stage 9).
 *
 * A schedule takes the export as set up above — the chosen profile, or the
 * options as they are now — and runs it weekly, monthly or yearly, for the
 * whole collection or only for what is dated in the elapsed period (a rule
 * collection "all card bookings" becomes last month's statement). The file is
 * kept for a week like any export, can be filed as a document and mailed.
 * Recipients are confirmed once, when the schedule is made: from then on they
 * get mail without anyone pressing a button.
 */
import { computed, ref, watch } from 'vue'
import { useConfirm } from 'primevue/useconfirm'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import SelectButton from 'primevue/selectbutton'
import {
  createCollectionSchedule,
  deleteCollectionSchedule,
  listCollectionSchedules,
  runCollectionScheduleNow,
  setCollectionScheduleEnabled,
  type CollectionSchedule,
  type ExportOptions,
  type ScheduleCadence,
} from '../../api/collections'
import { useAuthStore } from '../../stores/auth'

const props = defineProps<{
  collectionId: number
  /** The dialog's profile, when one is chosen and unchanged. */
  profileId: number | null
  profileName: string | null
  /** The dialog's options, used when no profile is chosen. */
  options: ExportOptions
  mailConfigured: boolean
  /** The user's address: what the schedule's mails go out from. */
  senderEmail?: string | null
  /** The app's address: used when the only recipient is the user. */
  systemSender?: string
}>()
const emit = defineEmits<{ (e: 'ran'): void }>()

const auth = useAuthStore()
const confirm = useConfirm()
const schedules = ref<CollectionSchedule[]>([])
const error = ref('')
const info = ref('')
const adding = ref(false)
const saving = ref(false)
const busy = ref<number | null>(null)

const cadence = ref<ScheduleCadence>('monthly')
const weekday = ref(1)
const day = ref(1)
const month = ref(1)
const scope = ref<'all' | 'period'>('period')
const saveAsDocument = ref(false)
const recipients = ref('')
const singleFiles = ref(false)
const message = ref('')

const CADENCES = [
  { label: 'Wöchentlich', value: 'weekly' },
  { label: 'Monatlich', value: 'monthly' },
  { label: 'Jährlich', value: 'yearly' },
]
const SCOPES = [
  { label: 'Nur der abgelaufene Zeitraum', value: 'period' },
  { label: 'Die ganze Mappe', value: 'all' },
]
const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'].map((label, i) => ({
  label,
  value: i + 1,
}))
const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
].map((label, i) => ({ label, value: i + 1 }))

const canFile = computed(() => auth.hasPermission('documents.upload'))
const recipientList = computed(() => recipients.value.split(/[\s,;]+/).map((r) => r.trim()).filter(Boolean))
/** Same rule as the server (collections/sending.ts, mailSender). */
const formSenderToSelf = computed(() => {
  const own = props.senderEmail?.toLowerCase()
  return !!own && recipientList.value.length > 0 && recipientList.value.every((r) => r.toLowerCase() === own)
})
const formSender = computed(() => (formSenderToSelf.value ? props.systemSender : props.senderEmail) ?? '')
const periodLabel = computed(() =>
  cadence.value === 'weekly' ? 'die sieben Tage davor' : cadence.value === 'monthly' ? 'den Vormonat' : 'das Vorjahr',
)

async function load() {
  try {
    schedules.value = (await listCollectionSchedules(props.collectionId)).items
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Zeitpläne konnten nicht geladen werden.'
  }
}

watch(() => props.collectionId, () => void load(), { immediate: true })

function when(s: Pick<CollectionSchedule, 'cadence' | 'weekday' | 'day' | 'month'>): string {
  if (s.cadence === 'weekly') return `jeden ${WEEKDAYS[(s.weekday ?? 1) - 1]!.label}`
  if (s.cadence === 'monthly') return `monatlich am ${s.day}.`
  return `jährlich am ${s.day}. ${MONTHS[(s.month ?? 1) - 1]!.label}`
}

function what(s: CollectionSchedule): string {
  const parts = [s.scope === 'period' ? 'abgelaufener Zeitraum' : 'ganze Mappe']
  parts.push(s.profile_name ? `Profil „${s.profile_name}“` : 'gespeicherte Einstellungen')
  if (s.save_as_document) parts.push('als Dokument ablegen')
  if (s.recipients.length) parts.push(`an ${s.recipients.join(', ')}${s.sender ? ` von ${s.sender}` : ''}`)
  return parts.join(' · ')
}

function dateTime(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const created = await createCollectionSchedule(props.collectionId, {
      cadence: cadence.value,
      weekday: cadence.value === 'weekly' ? weekday.value : null,
      day: cadence.value === 'weekly' ? null : day.value,
      month: cadence.value === 'yearly' ? month.value : null,
      scope: scope.value,
      ...(props.profileId ? { profile_id: props.profileId } : { options: props.options }),
      save_as_document: saveAsDocument.value,
      recipients: recipientList.value,
      single_files: singleFiles.value,
      message: message.value.trim() || null,
    })
    schedules.value = [...schedules.value, created]
    adding.value = false
    recipients.value = ''
    message.value = ''
    info.value = `Zeitplan angelegt, nächster Lauf ${dateTime(created.next_run_at)}.`
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Zeitplan konnte nicht angelegt werden.'
  } finally {
    saving.value = false
  }
}

/** Recipients get mail without anyone pressing a button: confirm them once. */
function askSave() {
  if (recipientList.value.length === 0) {
    void save()
    return
  }
  confirm.require({
    header: 'Empfänger bestätigen',
    message: `${recipientList.value.join(', ')} bekommt ab jetzt ${when({ cadence: cadence.value, weekday: weekday.value, day: day.value, month: month.value })} eine E-Mail mit diesem Export${formSender.value ? `, Absender ${formSender.value}` : ''}.`,
    icon: 'pi pi-envelope',
    acceptLabel: 'Zeitplan anlegen',
    rejectLabel: 'Abbrechen',
    accept: () => void save(),
  })
}

function replace(updated: CollectionSchedule) {
  schedules.value = schedules.value.map((s) => (s.id === updated.id ? updated : s))
}

async function toggle(s: CollectionSchedule) {
  busy.value = s.id
  try {
    replace(await setCollectionScheduleEnabled(s.id, !s.enabled))
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Ändern fehlgeschlagen.'
  } finally {
    busy.value = null
  }
}

async function runNow(s: CollectionSchedule) {
  busy.value = s.id
  error.value = ''
  try {
    const res = await runCollectionScheduleNow(s.id)
    replace(res.schedule)
    info.value = res.schedule.last_status === 'done' ? 'Ausgeführt; die Datei steht im Verlauf.' : ''
    if (res.schedule.last_status === 'failed') error.value = res.schedule.last_error ?? 'Lauf fehlgeschlagen.'
    emit('ran')
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Lauf fehlgeschlagen.'
  } finally {
    busy.value = null
  }
}

function askDelete(s: CollectionSchedule) {
  confirm.require({
    header: 'Zeitplan löschen?',
    message: `Der Zeitplan „${when(s)}“ läuft dann nicht mehr. Bisherige Exporte bleiben, bis sie ablaufen.`,
    icon: 'pi pi-exclamation-triangle',
    acceptLabel: 'Löschen',
    rejectLabel: 'Abbrechen',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteCollectionSchedule(s.id)
        schedules.value = schedules.value.filter((x) => x.id !== s.id)
      } catch (err: unknown) {
        error.value = err instanceof Error ? err.message : 'Löschen fehlgeschlagen.'
      }
    },
  })
}
</script>

<template>
  <section class="sch" aria-label="Regelmäßig exportieren" data-testid="export-schedules">
    <div class="sch-head">
      <h3 class="sch-title"><i class="pi pi-calendar-clock" aria-hidden="true" /> Zeitpläne</h3>
      <Button
        v-if="!adding"
        icon="pi pi-plus"
        label="Zeitplan"
        size="small"
        text
        data-testid="schedule-add"
        @click="adding = true"
      />
    </div>
    <Message v-if="error" severity="error" :closable="true" @close="error = ''">{{ error }}</Message>
    <Message v-if="info" severity="success" :closable="true" @close="info = ''">{{ info }}</Message>

    <ul v-if="schedules.length" class="sch-list">
      <li v-for="s in schedules" :key="s.id" class="sch-row" :class="{ 'sch-row--off': !s.enabled }">
        <div class="sch-body">
          <span class="sch-when">{{ when(s) }}<template v-if="!s.enabled"> · pausiert</template></span>
          <span class="sch-meta">{{ what(s) }}</span>
          <span class="sch-meta">
            Nächster Lauf {{ dateTime(s.next_run_at) }}
            <template v-if="s.last_run_at"> · zuletzt {{ dateTime(s.last_run_at) }}</template>
            <template v-if="s.owner_name"> · als {{ s.owner_name }}</template>
          </span>
          <span v-if="s.last_status === 'failed' && s.last_error" class="sch-error">{{ s.last_error }}</span>
          <span v-else-if="s.last_status === 'skipped' && s.last_error" class="sch-meta">{{ s.last_error }}</span>
        </div>
        <div v-if="s.can_edit" class="sch-actions">
          <Button
            icon="pi pi-play"
            text
            rounded
            :loading="busy === s.id"
            aria-label="Jetzt ausführen"
            v-tooltip.bottom="'Jetzt ausführen'"
            @click="runNow(s)"
          />
          <Button
            :icon="s.enabled ? 'pi pi-pause' : 'pi pi-replay'"
            text
            rounded
            severity="secondary"
            :disabled="busy === s.id"
            :aria-label="s.enabled ? 'Pausieren' : 'Fortsetzen'"
            v-tooltip.bottom="s.enabled ? 'Pausieren' : 'Fortsetzen'"
            @click="toggle(s)"
          />
          <Button
            icon="pi pi-trash"
            text
            rounded
            severity="danger"
            aria-label="Zeitplan löschen"
            v-tooltip.bottom="'Zeitplan löschen'"
            @click="askDelete(s)"
          />
        </div>
      </li>
    </ul>
    <p v-else-if="!adding" class="sch-hint">Noch kein Zeitplan. Ein Zeitplan nimmt den Export, wie er unter „Exportieren“ eingestellt ist.</p>

    <div v-if="adding" class="sch-form" data-testid="schedule-form">
      <SelectButton v-model="cadence" :options="CADENCES" option-label="label" option-value="value" :allow-empty="false" aria-label="Rhythmus" />
      <div class="sch-line">
        <template v-if="cadence === 'weekly'">
          <label class="sch-label" for="sch-weekday">am</label>
          <Select v-model="weekday" input-id="sch-weekday" :options="WEEKDAYS" option-label="label" option-value="value" />
        </template>
        <template v-else>
          <label class="sch-label" for="sch-day">am Tag</label>
          <InputNumber v-model="day" input-id="sch-day" :min="1" :max="28" show-buttons class="sch-day" />
          <template v-if="cadence === 'yearly'">
            <label class="sch-label" for="sch-month">im</label>
            <Select v-model="month" input-id="sch-month" :options="MONTHS" option-label="label" option-value="value" />
          </template>
        </template>
      </div>
      <SelectButton v-model="scope" :options="SCOPES" option-label="label" option-value="value" :allow-empty="false" aria-label="Umfang" />
      <p class="sch-hint">
        <template v-if="scope === 'period'">Jeder Lauf nimmt nur, was in {{ periodLabel }} fällt; Zähler mit ihren Ablesungen aus diesem Zeitraum. Einträge ohne Datum bleiben draußen.</template>
        <template v-else>Jeder Lauf nimmt die ganze Mappe, wie sie dann ist.</template>
        Exportiert wird {{ profileName ? `mit dem Profil „${profileName}“ in seiner jeweils aktuellen Fassung` : 'mit den Einstellungen unter „Exportieren“, wie sie jetzt sind' }}.
      </p>
      <label v-if="canFile" class="sch-check">
        <Checkbox v-model="saveAsDocument" binary />
        <span>Als Dokument ablegen (nur PDF)</span>
      </label>
      <template v-if="mailConfigured">
        <label class="sch-label" for="sch-to">Per E-Mail an (optional, mehrere mit Komma)</label>
        <InputText id="sch-to" v-model="recipients" placeholder="name@beispiel.de" class="sch-field" />
        <template v-if="recipientList.length">
          <p v-if="formSender" class="sch-from">
            Von: <strong>{{ formSender }}</strong>
            <template v-if="formSenderToSelf"> — geht er nur an dich, schickt ihn die App</template>
          </p>
          <label class="sch-label" for="sch-msg">Nachricht (optional)</label>
          <InputText id="sch-msg" v-model="message" class="sch-field" />
          <label class="sch-check">
            <Checkbox v-model="singleFiles" binary />
            <span>Bei bis zu zehn Einträgen einzeln statt als ZIP</span>
          </label>
        </template>
      </template>
      <p v-else class="sch-hint">E-Mail-Versand ist auf diesem Server nicht eingerichtet; die Datei bleibt eine Woche im Verlauf.</p>
      <div class="sch-line">
        <Button label="Abbrechen" size="small" text severity="secondary" @click="adding = false" />
        <Button label="Zeitplan anlegen" icon="pi pi-check" size="small" :loading="saving" data-testid="schedule-save" @click="askSave" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.sch-from {
  margin: 0;
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.sch {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.sch-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.sch-title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sch-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.sch-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sch-row--off .sch-when {
  color: var(--p-text-muted-color);
}
.sch-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.sch-when {
  font-weight: 600;
}
.sch-meta,
.sch-hint,
.sch-label {
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.sch-hint {
  margin: 0;
}
.sch-error {
  font-size: var(--text-sm);
  color: var(--p-red-500);
}
.sch-actions {
  display: flex;
  flex: 0 0 auto;
}
.sch-form {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}
.sch-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.sch-day {
  width: 8rem;
}
.sch-field {
  width: 100%;
}
.sch-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
</style>
