<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import type {
  ForecastItem,
  ForecastItemInput,
  ForecastItemType,
  ForecastLinkableAccount,
  ForecastMilestone,
  ForecastPerson,
  ForecastTimeRef,
} from '../../../api/finance'
import {
  FREQUENCY_LABELS,
  HI_MODE_LABELS,
  ITEM_GROUPS,
  ITEM_TYPE_LABELS,
  PENSION_KIND_LABELS,
  PERSONAL_ITEM_TYPES,
  POT_LABELS,
  defaultItemData,
  formatEur,
} from './forecastModel'
import TimeRefPicker from './TimeRefPicker.vue'

/**
 * One dialog for all item types. The fields change with the type; the
 * type itself is fixed once an item exists, because the data of a salary
 * says nothing about a life insurance.
 */

const props = defineProps<{
  visible: boolean
  item: ForecastItem | null
  /** Preselected type for a new item. */
  presetType?: ForecastItemType | null
  persons: ForecastPerson[]
  milestones: ForecastMilestone[]
  accounts: ForecastLinkableAccount[]
  saving: boolean
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void
  (e: 'save', body: ForecastItemInput, id: number | null): void
  (e: 'delete', id: number): void
}>()

const type = ref<ForecastItemType>('salary')
const label = ref('')
const personId = ref<number | null>(null)
const linkedAccountId = ref<number | null>(null)
const data = ref<Record<string, unknown>>({})

watch(
  () => [props.visible, props.item, props.presetType] as const,
  ([visible]) => {
    if (!visible) return
    if (props.item) {
      type.value = props.item.type
      label.value = props.item.label
      personId.value = props.item.personId
      linkedAccountId.value = props.item.linkedAccountId
      data.value = { ...defaultItemData(props.item.type), ...props.item.data }
    } else {
      type.value = props.presetType ?? 'salary'
      label.value = ''
      personId.value = props.persons[0]?.id ?? null
      linkedAccountId.value = null
      data.value = defaultItemData(type.value)
    }
  },
  { immediate: true },
)

watch(type, (t, old) => {
  if (props.item || t === old) return
  data.value = defaultItemData(t)
  if (!label.value || label.value === ITEM_TYPE_LABELS[old]) label.value = ''
})

const isPersonal = computed(() => PERSONAL_ITEM_TYPES.has(type.value))

const typeOptions = ITEM_GROUPS.map((g) => ({
  label: g.label,
  items: g.types.map((t) => ({ value: t, label: ITEM_TYPE_LABELS[t] })),
}))

const personOptions = computed(() => {
  const out: Array<{ value: number | null; label: string }> = props.persons.map((p) => ({ value: p.id, label: p.label }))
  if (!isPersonal.value) out.unshift({ value: null, label: 'Haushalt (gemeinsam)' })
  return out
})

const accountOptions = computed(() => [
  { value: null, label: 'Kein Konto (Wert selbst eingeben)' },
  ...props.accounts.map((a) => ({ value: a.id, label: `${a.label} — ${formatEur(a.balance)}` })),
])

const enumOptions = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((k) => ({ value: k, label: labels[k] }))
const freqOptions = enumOptions(FREQUENCY_LABELS)
const potOptions = (['cash', 'depot', 'real_estate', 'other'] as const).map((k) => ({ value: k, label: POT_LABELS[k] }))
const hiBridgeOptions = enumOptions(HI_MODE_LABELS).filter((o) => o.value !== 'employed' && o.value !== 'kvdr')
const hiRetiredOptions = enumOptions(HI_MODE_LABELS).filter((o) => o.value !== 'employed' && o.value !== 'family')
const pensionKindOptions = enumOptions(PENSION_KIND_LABELS)

const n = (k: string) => (typeof data.value[k] === 'number' ? (data.value[k] as number) : null)
const s = (k: string) => (typeof data.value[k] === 'string' ? (data.value[k] as string) : null)
const ref_ = (k: string) => (data.value[k] as ForecastTimeRef | null | undefined) ?? null
function set(k: string, v: unknown) {
  data.value = { ...data.value, [k]: v }
}
/** Percent field: the UI shows 2,5 and the data holds 0.025. */
const pct = (k: string) => {
  const v = n(k)
  return v == null ? null : Math.round(v * 10000) / 100
}
function setPct(k: string, v: number | null) {
  set(k, v == null ? null : v / 100)
}

const title = computed(() => (props.item ? `${ITEM_TYPE_LABELS[props.item.type]} bearbeiten` : 'Neuer Eintrag'))

const validation = computed<string | null>(() => {
  if (!label.value.trim()) return 'Bitte eine Bezeichnung angeben.'
  if (isPersonal.value && personId.value == null) return 'Dieser Eintrag gehört zu einer Person.'
  if (type.value === 'pension' && !ref_('start')) return 'Wann beginnt die Rente?'
  if (type.value === 'life_insurance' && !ref_('maturity')) return 'Wann läuft die Versicherung ab?'
  return null
})

function save() {
  if (validation.value) return
  emit(
    'save',
    {
      type: type.value,
      label: label.value.trim(),
      personId: isPersonal.value ? personId.value : personId.value,
      data: data.value,
      linkedAccountId: type.value === 'asset' ? linkedAccountId.value : null,
    },
    props.item?.id ?? null,
  )
}
</script>

<template>
  <Dialog
    class="dialog-md"
    :visible="visible"
    modal
    :header="title"
    @update:visible="emit('update:visible', $event)"
  >
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="field">
      <label for="fc-item-type">Art</label>
      <Select
        input-id="fc-item-type"
        v-model="type"
        :options="typeOptions"
        option-group-label="label"
        option-group-children="items"
        option-label="label"
        option-value="value"
        :disabled="!!item"
      />
    </div>

    <div class="field">
      <label for="fc-item-label">Bezeichnung</label>
      <InputText id="fc-item-label" v-model="label" :placeholder="ITEM_TYPE_LABELS[type]" />
    </div>

    <div class="field">
      <label for="fc-item-person">{{ isPersonal ? 'Person' : 'Gehört zu' }}</label>
      <Select input-id="fc-item-person" v-model="personId" :options="personOptions" option-label="label" option-value="value" />
    </div>

    <!-- Salary -->
    <template v-if="type === 'salary'">
      <div class="grid2">
        <div class="field">
          <label for="fc-amount">Netto pro Monat</label>
          <InputNumber input-id="fc-amount" :model-value="n('amount')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('amount', $event)" />
        </div>
        <div class="field">
          <label for="fc-growth">Jährliche Steigerung</label>
          <InputNumber input-id="fc-growth" :model-value="pct('growthRate')" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="2" @update:model-value="setPct('growthRate', $event)" />
        </div>
      </div>
      <p class="hint">Endet beim Ausstieg der Person aus dem Beruf, wenn kein anderes Ende gesetzt ist.</p>
    </template>

    <!-- Other income / expense -->
    <template v-if="type === 'income' || type === 'expense'">
      <div class="grid2">
        <div class="field">
          <label for="fc-amount">Betrag</label>
          <InputNumber input-id="fc-amount" :model-value="n('amount')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('amount', $event)" />
        </div>
        <div class="field">
          <label for="fc-freq">Rhythmus</label>
          <Select input-id="fc-freq" :model-value="s('frequency') ?? 'monthly'" :options="freqOptions" option-label="label" option-value="value" @update:model-value="set('frequency', $event)" />
        </div>
        <div class="field">
          <label for="fc-growth">{{ type === 'expense' ? 'Jährliche Steigerung (leer = Inflation)' : 'Jährliche Steigerung' }}</label>
          <InputNumber input-id="fc-growth" :model-value="pct('growthRate')" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="2" @update:model-value="setPct('growthRate', $event)" />
        </div>
        <div v-if="type === 'income'" class="field">
          <label for="fc-tax">Steuer darauf</label>
          <InputNumber input-id="fc-tax" :model-value="pct('taxRate')" suffix=" %" :min-fraction-digits="0" :max-fraction-digits="2" @update:model-value="setPct('taxRate', $event)" />
        </div>
      </div>
    </template>

    <!-- Living expenses -->
    <template v-if="type === 'living_expense'">
      <div class="field">
        <label for="fc-amount">Pro Monat, in heutigem Geld</label>
        <InputNumber input-id="fc-amount" :model-value="n('amount')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('amount', $event)" />
      </div>
      <p class="hint">Folgt der Inflation und der Ausgabenkurve des Szenarios (aktiv / ruhiger / Pflege).</p>
    </template>

    <!-- Health insurance -->
    <template v-if="type === 'health_insurance'">
      <div class="field">
        <label for="fc-hi-employed">Arbeitnehmeranteil pro Monat (bis zum Ausstieg)</label>
        <InputNumber input-id="fc-hi-employed" :model-value="n('employedAmount')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('employedAmount', $event)" />
      </div>
      <div class="grid2">
        <div class="field">
          <label for="fc-hi-bridge">Zwischen Ausstieg und Rente</label>
          <Select input-id="fc-hi-bridge" :model-value="s('bridgeMode')" :options="hiBridgeOptions" option-label="label" option-value="value" @update:model-value="set('bridgeMode', $event)" />
        </div>
        <div v-if="s('bridgeMode') === 'private'" class="field">
          <label for="fc-hi-bridge-amount">Privater Beitrag pro Monat</label>
          <InputNumber input-id="fc-hi-bridge-amount" :model-value="n('bridgeAmount')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('bridgeAmount', $event)" />
        </div>
        <div class="field">
          <label for="fc-hi-retired">Ab der gesetzlichen Rente</label>
          <Select input-id="fc-hi-retired" :model-value="s('retiredMode')" :options="hiRetiredOptions" option-label="label" option-value="value" @update:model-value="set('retiredMode', $event)" />
        </div>
        <div v-if="s('retiredMode') === 'private'" class="field">
          <label for="fc-hi-retired-amount">Privater Beitrag pro Monat</label>
          <InputNumber input-id="fc-hi-retired-amount" :model-value="n('retiredAmount')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('retiredAmount', $event)" />
        </div>
        <div v-if="s('bridgeMode') === 'private' || s('retiredMode') === 'private'" class="field">
          <label for="fc-hi-growth">Steigerung des privaten Beitrags pro Jahr</label>
          <InputNumber input-id="fc-hi-growth" :model-value="pct('privateGrowthRate')" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="2" @update:model-value="setPct('privateGrowthRate', $event)" />
        </div>
      </div>
      <p class="hint">Freiwillig gesetzlich: Beitragssatz auf die eigenen Einnahmen, mindestens der Mindestbeitrag. KVdR: Beitragssatz nur auf die Renten. Beide Sätze stehen im Szenario.</p>
    </template>

    <!-- Asset -->
    <template v-if="type === 'asset'">
      <div class="grid2">
        <div class="field">
          <label for="fc-pot">Topf</label>
          <Select input-id="fc-pot" :model-value="s('pot')" :options="potOptions" option-label="label" option-value="value" @update:model-value="set('pot', $event)" />
        </div>
        <div class="field">
          <label for="fc-account">Konto im Finanzmodul</label>
          <Select input-id="fc-account" v-model="linkedAccountId" :options="accountOptions" option-label="label" option-value="value" />
        </div>
        <div v-if="linkedAccountId == null" class="field">
          <label for="fc-value">Aktueller Wert</label>
          <InputNumber input-id="fc-value" :model-value="n('currentValue')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('currentValue', $event)" />
        </div>
        <div class="field">
          <label for="fc-return">Rendite pro Jahr (leer = Szenario)</label>
          <InputNumber input-id="fc-return" :model-value="pct('returnRate')" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="2" @update:model-value="setPct('returnRate', $event)" />
        </div>
        <div class="field">
          <label for="fc-contrib">Sparrate pro Monat</label>
          <InputNumber input-id="fc-contrib" :model-value="n('monthlyContribution')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('monthlyContribution', $event)" />
        </div>
        <div v-if="(n('monthlyContribution') ?? 0) > 0" class="field">
          <label for="fc-contrib-end">Sparrate bis</label>
          <TimeRefPicker input-id="fc-contrib-end" :model-value="ref_('contributionEnd')" :milestones="milestones" :persons="persons" :person-id="personId" null-label="Bis zum Ende" @update:model-value="set('contributionEnd', $event)" />
        </div>
      </div>
      <p class="hint">Tagesgeld, Depot und Sonstiges gelten als verfügbar; Immobilien nicht. Ein verknüpftes Konto liefert seinen aktuellen Saldo als Startwert.</p>
    </template>

    <!-- Life insurance -->
    <template v-if="type === 'life_insurance'">
      <div class="grid2">
        <div class="field">
          <label for="fc-surrender">Aktueller Rückkaufswert</label>
          <InputNumber input-id="fc-surrender" :model-value="n('surrenderValue')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('surrenderValue', $event)" />
        </div>
        <div class="field">
          <label for="fc-premium">Beitrag pro Monat</label>
          <InputNumber input-id="fc-premium" :model-value="n('monthlyPremium')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('monthlyPremium', $event)" />
        </div>
        <div class="field">
          <label for="fc-premium-end">Beitrag bis</label>
          <TimeRefPicker input-id="fc-premium-end" :model-value="ref_('premiumEnd')" :milestones="milestones" :persons="persons" :person-id="personId" null-label="Bis zum Ablauf" @update:model-value="set('premiumEnd', $event)" />
        </div>
        <div class="field">
          <label for="fc-maturity">Ablauf</label>
          <TimeRefPicker input-id="fc-maturity" :model-value="ref_('maturity')" :milestones="milestones" :persons="persons" :person-id="personId" @update:model-value="set('maturity', $event)" />
        </div>
        <div class="field">
          <label for="fc-guaranteed">Garantierte Ablaufleistung</label>
          <InputNumber input-id="fc-guaranteed" :model-value="n('guaranteedPayout')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('guaranteedPayout', $event)" />
        </div>
        <div class="field">
          <label for="fc-projected">Prognostizierte Ablaufleistung</label>
          <InputNumber input-id="fc-projected" :model-value="n('projectedPayout')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('projectedPayout', $event)" />
        </div>
        <div class="field">
          <label for="fc-payout">Auszahlung</label>
          <Select input-id="fc-payout" :model-value="s('payoutMode')" :options="[{ value: 'lump_sum', label: 'Einmalzahlung' }, { value: 'annuity', label: 'Monatliche Rente' }]" option-label="label" option-value="value" @update:model-value="set('payoutMode', $event)" />
        </div>
        <div v-if="s('payoutMode') === 'annuity'" class="field">
          <label for="fc-annuity">Rente pro Monat</label>
          <InputNumber input-id="fc-annuity" :model-value="n('annuityAmount')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('annuityAmount', $event)" />
        </div>
        <div class="field">
          <label for="fc-tax">Steuer auf die Auszahlung</label>
          <InputNumber input-id="fc-tax" :model-value="pct('taxRate')" suffix=" %" :min-fraction-digits="0" :max-fraction-digits="2" @update:model-value="setPct('taxRate', $event)" />
        </div>
      </div>
      <p class="hint">Die Prognose rechnet mit der prognostizierten Ablaufleistung. Vorher wird nur gekündigt, wenn das Szenario es erlaubt — dann zum Rückkaufswert.</p>
    </template>

    <!-- Pension -->
    <template v-if="type === 'pension'">
      <div class="grid2">
        <div class="field">
          <label for="fc-kind">Art</label>
          <Select input-id="fc-kind" :model-value="s('kind')" :options="pensionKindOptions" option-label="label" option-value="value" @update:model-value="set('kind', $event)" />
        </div>
        <div class="field">
          <label for="fc-start">Beginn</label>
          <TimeRefPicker input-id="fc-start" :model-value="ref_('start')" :milestones="milestones" :persons="persons" :person-id="personId" @update:model-value="set('start', $event)" />
        </div>
        <div class="field">
          <label for="fc-monthly">{{ s('kind') === 'statutory' ? 'Prognostizierte Rente pro Monat (Renteninformation)' : 'Rente pro Monat' }}</label>
          <InputNumber input-id="fc-monthly" :model-value="n('monthlyAmount')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('monthlyAmount', $event)" />
        </div>
        <div class="field">
          <label for="fc-growth">Rentenanpassung pro Jahr</label>
          <InputNumber input-id="fc-growth" :model-value="pct('growthRate')" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="2" @update:model-value="setPct('growthRate', $event)" />
        </div>
        <template v-if="s('kind') === 'statutory'">
          <div class="field">
            <label for="fc-regular">Regelaltersgrenze</label>
            <InputNumber input-id="fc-regular" :model-value="n('regularAge')" suffix=" Jahre" :min="60" :max="70" @update:model-value="set('regularAge', $event)" />
          </div>
          <div class="field">
            <label for="fc-deduction">Abschlag pro Monat früher</label>
            <InputNumber input-id="fc-deduction" :model-value="pct('deductionPerMonth')" suffix=" %" :min-fraction-digits="1" :max-fraction-digits="2" @update:model-value="setPct('deductionPerMonth', $event)" />
          </div>
          <div class="field">
            <label for="fc-offset">Ausgleichszahlung für den Abschlag (§ 187a SGB VI)</label>
            <InputNumber input-id="fc-offset" :model-value="n('deductionOffsetCost')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('deductionOffsetCost', $event)" />
          </div>
        </template>
        <template v-else>
          <div class="field">
            <label for="fc-contrib">Eigener Beitrag pro Monat</label>
            <InputNumber input-id="fc-contrib" :model-value="n('monthlyContribution')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('monthlyContribution', $event)" />
          </div>
          <div v-if="(n('monthlyContribution') ?? 0) > 0" class="field">
            <label for="fc-contrib-end">Beitrag bis</label>
            <TimeRefPicker input-id="fc-contrib-end" :model-value="ref_('contributionEnd')" :milestones="milestones" :persons="persons" :person-id="personId" null-label="Bis zum Beginn" @update:model-value="set('contributionEnd', $event)" />
          </div>
          <div class="field">
            <label for="fc-lump">Kapitalwahlrecht (Einmalzahlung)</label>
            <InputNumber input-id="fc-lump" :model-value="n('lumpSumOption')" mode="currency" currency="EUR" locale="de-DE" @update:model-value="set('lumpSumOption', $event)" />
          </div>
          <div v-if="(n('lumpSumOption') ?? 0) > 0" class="field field--inline">
            <label for="fc-lump-mode">Einmalzahlung statt Rente</label>
            <Checkbox input-id="fc-lump-mode" :model-value="s('payoutMode') === 'lump_sum'" binary @update:model-value="set('payoutMode', $event ? 'lump_sum' : 'annuity')" />
          </div>
        </template>
        <div class="field">
          <label for="fc-tax">Steuer auf die Rente (pauschal)</label>
          <InputNumber input-id="fc-tax" :model-value="pct('taxRate')" suffix=" %" :min-fraction-digits="0" :max-fraction-digits="2" @update:model-value="setPct('taxRate', $event)" />
        </div>
      </div>
    </template>

    <!-- Common start / end -->
    <div v-if="type !== 'pension' && type !== 'life_insurance'" class="grid2">
      <div class="field">
        <label for="fc-from">Ab</label>
        <TimeRefPicker input-id="fc-from" :model-value="ref_('start')" :milestones="milestones" :persons="persons" :person-id="personId" null-label="Ab sofort" @update:model-value="set('start', $event)" />
      </div>
      <div class="field">
        <label for="fc-to">Bis</label>
        <TimeRefPicker input-id="fc-to" :model-value="ref_('end')" :milestones="milestones" :persons="persons" :person-id="personId" :null-label="type === 'salary' ? 'Ausstieg der Person' : 'Bis zum Ende'" @update:model-value="set('end', $event)" />
      </div>
    </div>

    <p v-if="validation" class="hint hint--error">{{ validation }}</p>

    <template #footer>
      <Button
        v-if="item"
        label="Löschen"
        icon="pi pi-trash"
        severity="danger"
        text
        class="footer-leading-btn"
        :disabled="saving"
        @click="emit('delete', item.id)"
      />
      <Button label="Abbrechen" severity="secondary" text :disabled="saving" @click="emit('update:visible', false)" />
      <Button label="Speichern" icon="pi pi-check" :loading="saving" :disabled="!!validation" @click="save" />
    </template>
  </Dialog>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
  min-width: 0;
}
.field--inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.field label {
  font-size: var(--text-base);
  color: var(--p-text-muted-color);
}
.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  column-gap: var(--space-4);
}
.hint {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--p-text-muted-color);
}
.hint--error {
  color: var(--p-red-500);
}
.footer-leading-btn {
  margin-right: auto;
}
</style>
