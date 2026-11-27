<script setup lang="ts">
/**
 * Create or edit a home system: what it is, where it is, which model, and
 * with whom it is shared. Without a choice a new system goes to the
 * household, like a new meter.
 */
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import DatePicker from 'primevue/datepicker'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import {
  HOME_CATEGORY_LABELS,
  createHomeSystem,
  listHomeShareGroups,
  updateHomeSystem,
  type HomeShareGroup,
  type HomeSystemCategory,
  type HomeSystemDetail,
} from '../../api/home'
import { parseLocalDate, toLocalIsoDate } from '../../utils/dateFormat'

const visible = defineModel<boolean>('visible', { required: true })
const props = defineProps<{ system?: HomeSystemDetail | null }>()
const emit = defineEmits<{ saved: [id: number] }>()

const editing = computed(() => !!props.system)

const name = ref(props.system?.name ?? '')
const category = ref<HomeSystemCategory>(props.system?.category ?? 'heating')
const location = ref(props.system?.location ?? '')
const manufacturer = ref(props.system?.manufacturer ?? '')
const model = ref(props.system?.model ?? '')
const installedOn = ref<Date | null>(props.system?.installedOn ? parseLocalDate(props.system.installedOn) : null)
const description = ref(props.system?.description ?? '')
/** 'default' = the household (or private without one). */
const groupChoice = ref<number | null | 'default'>(props.system ? props.system.groupId : 'default')

const shareGroups = ref<HomeShareGroup[]>([])
const householdId = ref<number | null>(null)
const saving = ref(false)
const error = ref('')

const categoryOptions = (Object.keys(HOME_CATEGORY_LABELS) as HomeSystemCategory[]).map((value) => ({
  label: HOME_CATEGORY_LABELS[value],
  value,
}))

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
  try {
    const res = await listHomeShareGroups()
    shareGroups.value = res.groups
    householdId.value = res.householdId
  } catch {
    // Without the list the default still works.
  }
})

async function save() {
  if (!name.value.trim() || saving.value) return
  saving.value = true
  error.value = ''
  const fields = {
    name: name.value.trim(),
    category: category.value,
    location: location.value.trim() || null,
    manufacturer: manufacturer.value.trim() || null,
    model: model.value.trim() || null,
    installedOn: installedOn.value ? toLocalIsoDate(installedOn.value) : null,
    description: description.value.trim() || null,
    ...(groupChoice.value === 'default' ? {} : { groupId: groupChoice.value }),
  }
  try {
    if (props.system) {
      await updateHomeSystem(props.system.id, fields)
      emit('saved', props.system.id)
    } else {
      const created = await createHomeSystem(fields)
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
    :header="editing ? 'Anlage bearbeiten' : 'Neue Anlage'"
  >
    <form class="hs-form" @submit.prevent="save">
      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <label for="hs-name">Name</label>
      <InputText id="hs-name" v-model="name" autofocus placeholder="z. B. Enthärtungsanlage" />

      <label for="hs-category">Bereich</label>
      <Select
        input-id="hs-category"
        v-model="category"
        :options="categoryOptions"
        option-label="label"
        option-value="value"
      />

      <label for="hs-location">Ort</label>
      <InputText id="hs-location" v-model="location" placeholder="z. B. Hauswirtschaftsraum" />

      <div class="hs-row">
        <div class="hs-col">
          <label for="hs-manufacturer">Hersteller</label>
          <InputText id="hs-manufacturer" v-model="manufacturer" />
        </div>
        <div class="hs-col">
          <label for="hs-model">Modell</label>
          <InputText id="hs-model" v-model="model" />
        </div>
      </div>

      <label for="hs-installed">Eingebaut am</label>
      <DatePicker
        input-id="hs-installed"
        v-model="installedOn"
        date-format="dd.mm.yy"
        show-button-bar
        :max-date="new Date()"
      />

      <label for="hs-description">Kurzbeschreibung</label>
      <Textarea id="hs-description" v-model="description" rows="3" auto-resize />

      <label for="hs-group">Geteilt mit</label>
      <Select
        input-id="hs-group"
        v-model="groupChoice"
        :options="groupOptions"
        option-label="label"
        option-value="value"
      />
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
.hs-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hs-form label {
  font-size: var(--text-md);
  color: var(--p-text-muted-color);
  margin-top: 6px;
}
.hs-row {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.hs-col {
  flex: 1 1 12rem;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
