<script setup lang="ts">
/**
 * Create or edit a spare part: what it is, where it is stored, how many are
 * left (empty = not counted) and where to buy it. Without a choice a new
 * part goes to the household, like a new system. Sharing a part that
 * exists is its owner's choice (`canManage`).
 */
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import {
  createHomePart,
  listHomeShareGroups,
  updateHomePart,
  type HomePartDetail,
  type HomeShareGroup,
} from '../../api/home'

const visible = defineModel<boolean>('visible', { required: true })
const props = defineProps<{ part?: HomePartDetail | null; initialName?: string }>()
const emit = defineEmits<{ saved: [id: number] }>()

const editing = computed(() => !!props.part)
/** Sharing is offered for a new part and to the owner of an existing one. */
const canShare = computed(() => !props.part || props.part.canManage)

const name = ref(props.part?.name ?? props.initialName ?? '')
const manufacturer = ref(props.part?.manufacturer ?? '')
const partNumber = ref(props.part?.partNumber ?? '')
const ean = ref(props.part?.ean ?? '')
const specification = ref(props.part?.specification ?? '')
const storageLocation = ref(props.part?.storageLocation ?? '')
const stock = ref<number | null>(props.part?.stock ?? null)
const supplierUrl = ref(props.part?.supplierUrl ?? '')
const notes = ref(props.part?.notes ?? '')
/** 'default' = the household (or private without one). */
const groupChoice = ref<number | null | 'default'>(props.part ? props.part.groupId : 'default')

const shareGroups = ref<HomeShareGroup[]>([])
const householdId = ref<number | null>(null)
const saving = ref(false)
const error = ref('')

const groupOptions = computed(() => {
  const options: Array<{ label: string; value: number | null | 'default' }> = []
  if (!editing.value) {
    const household = shareGroups.value.find((g) => g.id === householdId.value)
    options.push({
      label: household ? `Haushalt „${household.name}“` : 'Standard (privat, kein Haushalt)',
      value: 'default',
    })
  }
  options.push({ label: 'Privat (nur ich)', value: null })
  for (const g of shareGroups.value) {
    if (!editing.value && g.id === householdId.value) continue
    options.push({ label: g.household ? `${g.name} (Haushalt)` : g.name, value: g.id })
  }
  return options
})

onMounted(async () => {
  if (!canShare.value) return
  try {
    const res = await listHomeShareGroups()
    shareGroups.value = res.groups
    householdId.value = res.householdId
  } catch {
    // Without the list the default still works.
  }
})

function sharingChanged(): boolean {
  if (!canShare.value || groupChoice.value === 'default') return false
  return !props.part || groupChoice.value !== props.part.groupId
}

async function save() {
  if (!name.value.trim() || saving.value) return
  saving.value = true
  error.value = ''
  const fields = {
    name: name.value.trim(),
    manufacturer: manufacturer.value.trim() || null,
    partNumber: partNumber.value.trim() || null,
    ean: ean.value.trim() || null,
    specification: specification.value.trim() || null,
    storageLocation: storageLocation.value.trim() || null,
    stock: stock.value,
    supplierUrl: supplierUrl.value.trim() || null,
    notes: notes.value.trim() || null,
    // Only a changed choice is sent; sharing is the owner's decision.
    ...(sharingChanged() ? { groupId: groupChoice.value as number | null } : {}),
  }
  try {
    if (props.part) {
      await updateHomePart(props.part.id, fields)
      emit('saved', props.part.id)
    } else {
      const created = await createHomePart(fields)
      emit('saved', created.id)
    }
  } catch (err: any) {
    error.value = err?.message ?? 'Speichern fehlgeschlagen.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    class="dialog-md"
    modal
    :header="editing ? 'Ersatzteil bearbeiten' : 'Neues Ersatzteil'"
  >
    <form class="hp-form" @submit.prevent="save">
      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <label for="hpd-name">Bezeichnung</label>
      <InputText id="hpd-name" v-model="name" autofocus placeholder="z. B. Dichtung 3/4 Zoll" />

      <div class="hp-row">
        <div class="hp-col">
          <label for="hpd-manufacturer">Hersteller</label>
          <InputText id="hpd-manufacturer" v-model="manufacturer" />
        </div>
        <div class="hp-col">
          <label for="hpd-number">Teilenummer</label>
          <InputText id="hpd-number" v-model="partNumber" />
        </div>
      </div>

      <label for="hpd-spec">Maße und Eigenschaften</label>
      <InputText id="hpd-spec" v-model="specification" placeholder="z. B. EPDM, 24 × 17 × 2 mm" />

      <div class="hp-row">
        <div class="hp-col hp-col--wide">
          <label for="hpd-storage">Lagerort</label>
          <InputText id="hpd-storage" v-model="storageLocation" placeholder="z. B. Teileschrank, Schublade 2" />
        </div>
        <div class="hp-col">
          <label for="hpd-stock">Bestand</label>
          <InputNumber
            input-id="hpd-stock"
            v-model="stock"
            :min="0"
            :max="100000"
            show-buttons
            placeholder="nicht gezählt"
          />
        </div>
      </div>

      <div class="hp-row">
        <div class="hp-col hp-col--wide">
          <label for="hpd-url">Bezugsquelle (Link)</label>
          <InputText id="hpd-url" v-model="supplierUrl" type="url" inputmode="url" placeholder="https://…" />
        </div>
        <div class="hp-col">
          <label for="hpd-ean">EAN</label>
          <InputText id="hpd-ean" v-model="ean" inputmode="numeric" />
        </div>
      </div>

      <label for="hpd-notes">Notizen</label>
      <Textarea id="hpd-notes" v-model="notes" rows="3" auto-resize />

      <template v-if="canShare">
        <label for="hpd-group">Geteilt mit</label>
        <Select
          input-id="hpd-group"
          v-model="groupChoice"
          :options="groupOptions"
          option-label="label"
          option-value="value"
        />
      </template>
    </form>
    <template #footer>
      <Button label="Abbrechen" text severity="secondary" @click="visible = false" />
      <Button
        :label="editing ? 'Speichern' : 'Anlegen'"
        icon="pi pi-check"
        :disabled="!name.trim()"
        :loading="saving"
        @click="save"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.hp-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hp-form label {
  font-size: var(--text-md);
  color: var(--p-text-muted-color);
  margin-top: 6px;
}
.hp-row {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.hp-col {
  flex: 1 1 10rem;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.hp-col--wide {
  flex: 2 1 14rem;
}
.hp-col :deep(input) {
  min-width: 0;
  width: 100%;
}
</style>
