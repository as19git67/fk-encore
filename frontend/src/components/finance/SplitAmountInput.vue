<script setup lang="ts">
/**
 * Amount field for the split dialog.
 *
 * Unlike PrimeVue's InputNumber this field never asks for a sign — the
 * split inherits the direction (expense/income) from the transaction —
 * and it accepts the separators of the UI locale while typing: in de-DE
 * the comma opens the fractional part and the dot, used for grouping,
 * is ignored. The raw keystrokes stay in the field until it loses focus,
 * so the caret never jumps; on blur the value is normalised to the
 * locale's two-digit form.
 */
import { ref, watch } from 'vue'
import InputText from 'primevue/inputtext'
import { formatAmountForInput, parseLocalizedAmount } from '../../utils/financeSplit'

const props = withDefaults(defineProps<{
  modelValue: number
  locale?: string
  currencyCode?: string
  ariaLabel?: string
}>(), {
  locale: 'de-DE',
  currencyCode: 'EUR',
  ariaLabel: 'Betrag',
})

const emit = defineEmits<{ (e: 'update:modelValue', value: number): void }>()

const text = ref(formatAmountForInput(props.modelValue, props.locale))
const focused = ref(false)

// Adopt outside changes (loading an existing split, "rest" button) but
// never fight the user while they are typing in the field.
watch(() => props.modelValue, (value) => {
  if (!focused.value) text.value = formatAmountForInput(value, props.locale)
})

function onInput(event: Event) {
  text.value = (event.target as HTMLInputElement).value
  emit('update:modelValue', parseLocalizedAmount(text.value, props.locale) ?? 0)
}

function onBlur() {
  focused.value = false
  text.value = formatAmountForInput(parseLocalizedAmount(text.value, props.locale) ?? 0, props.locale)
  emit('update:modelValue', parseLocalizedAmount(text.value, props.locale) ?? 0)
}
</script>

<template>
  <span class="split-amount-input">
    <InputText
      :model-value="text"
      inputmode="decimal"
      :aria-label="ariaLabel"
      fluid
      @input="onInput"
      @focus="focused = true"
      @blur="onBlur"
    />
    <span class="split-amount-currency">{{ props.currencyCode }}</span>
  </span>
</template>

<style scoped>
.split-amount-input {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}
.split-amount-input :deep(.p-inputtext) {
  min-width: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.split-amount-currency {
  flex: 0 0 auto;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
</style>
