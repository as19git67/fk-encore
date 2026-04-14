<script setup lang="ts">
import Button from 'primevue/button'

defineProps<{
  modelValue: string
  loading: boolean
  /** null = no search executed yet; number = count of results to display */
  resultCount: number | null
  hasParsedChips: boolean
  locationChip: string | null
  dateChip: string | null
  semanticChip: string | null
  placeholder?: string
}>()

defineEmits<{
  (e: 'update:modelValue', val: string): void
  (e: 'search'): void
  (e: 'clear'): void
}>()
</script>

<template>
  <div class="ns">
    <div class="ns__bar">
      <div class="ns__input-wrapper">
        <i class="pi pi-search ns__icon" />
        <input
          :value="modelValue"
          type="text" class="ns__input"
          :placeholder="placeholder || 'z.B. „Kirchen in München von 2004 bis 2017“'"
          @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
          @keyup.enter="$emit('search')"
          @keyup.escape="$emit('clear')"
        />
        <button v-if="modelValue" class="ns__clear" @click="$emit('clear')">
          <i class="pi pi-times" />
        </button>
      </div>
      <Button icon="pi pi-search" label="Suchen"
        :loading="loading"
        :disabled="!modelValue.trim()"
        @click="$emit('search')"
      />
      <span v-if="resultCount !== null && !loading" class="ns__count">
        {{ resultCount }} Treffer
      </span>
      <div class="ns__extras">
        <slot />
      </div>
    </div>
    <div v-if="hasParsedChips && !loading" class="ns__chips">
      <span class="ns__chips-label">Verstanden als:</span>
      <span v-if="semanticChip" class="ns__chip ns__chip--semantic">
        <i class="pi pi-image" /> {{ semanticChip }}
      </span>
      <span v-if="locationChip" class="ns__chip ns__chip--location">
        <i class="pi pi-map-marker" /> {{ locationChip }}
      </span>
      <span v-if="dateChip" class="ns__chip ns__chip--date">
        <i class="pi pi-calendar" /> {{ dateChip }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.ns { display: flex; flex-direction: column; gap: 0.25rem; }

.ns__bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0 0;
  flex-wrap: wrap;
}

.ns__input-wrapper {
  position: relative;
  flex: 1;
  min-width: 200px;
  max-width: 600px;
}

.ns__icon {
  position: absolute;
  left: 0.75rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--p-text-muted-color);
  pointer-events: none;
  font-size: 0.9rem;
}

.ns__input {
  width: 100%;
  padding: 0.5rem 2.25rem;
  border: 1px solid var(--p-content-border-color);
  border-radius: 6px;
  background: var(--p-content-background);
  color: var(--p-text-color);
  font-size: 0.95rem;
  outline: none;
  box-sizing: border-box;
}

.ns__input:focus {
  border-color: var(--p-primary-color);
  box-shadow: 0 0 0 2px var(--primary-200, rgba(99, 102, 241, 0.2));
}

.ns__clear {
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  color: var(--p-text-muted-color);
  padding: 0.2rem;
  display: flex;
  border-radius: 4px;
}
.ns__clear:hover { color: var(--p-text-color); background: var(--p-content-hover-background); }

.ns__count {
  font-size: 0.875rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.ns__extras { margin-left: auto; }

.ns__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0 0;
  font-size: 0.8125rem;
}

.ns__chips-label {
  color: var(--p-text-muted-color);
  margin-right: 0.25rem;
}

.ns__chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  background: var(--p-content-hover-background);
  border: 1px solid var(--p-content-border-color);
  color: var(--p-text-color);
  line-height: 1.2;
  white-space: nowrap;
}

.ns__chip i { font-size: 0.75rem; opacity: 0.85; }
.ns__chip--location { border-color: var(--p-primary-color); }
.ns__chip--date     { border-color: var(--p-primary-color); }
.ns__chip--semantic { font-style: italic; }
</style>
