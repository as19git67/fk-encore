import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Persists the filter form and applied-filter state for the transaction
 * list view so that navigating to BatchTagView and back does not reset
 * the user's search criteria.
 */
export const useTxFiltersStore = defineStore('finance.txFilters', () => {
  // Form state (what is currently in the filter inputs)
  const formQuery = ref('')
  const formTags = ref<string[]>([])
  const formFromIso = ref<string | null>(null)
  const formToIso = ref<string | null>(null)

  // Applied state (what was last submitted via "Suchen")
  const appliedQuery = ref('')
  const appliedTags = ref<string[]>([])
  const appliedFromIso = ref<string | null>(null)
  const appliedToIso = ref<string | null>(null)

  const hasActiveFilters = computed(
    () =>
      appliedQuery.value.trim().length > 0 ||
      appliedTags.value.length > 0 ||
      appliedFromIso.value !== null ||
      appliedToIso.value !== null,
  )

  // Convenience: Date objects derived from ISO strings
  const formFrom = computed<Date | null>({
    get: () => (formFromIso.value ? new Date(formFromIso.value) : null),
    set: (d) => { formFromIso.value = d ? d.toISOString() : null },
  })
  const formTo = computed<Date | null>({
    get: () => (formToIso.value ? new Date(formToIso.value) : null),
    set: (d) => { formToIso.value = d ? d.toISOString() : null },
  })
  const appliedFrom = computed<Date | null>(() =>
    appliedFromIso.value ? new Date(appliedFromIso.value) : null,
  )
  const appliedTo = computed<Date | null>(() =>
    appliedToIso.value ? new Date(appliedToIso.value) : null,
  )

  function apply() {
    appliedQuery.value = formQuery.value
    appliedTags.value = [...formTags.value]
    appliedFromIso.value = formFromIso.value
    appliedToIso.value = formToIso.value
  }

  function clear() {
    formQuery.value = ''
    formTags.value = []
    formFromIso.value = null
    formToIso.value = null
    appliedQuery.value = ''
    appliedTags.value = []
    appliedFromIso.value = null
    appliedToIso.value = null
  }

  return {
    formQuery,
    formTags,
    formFrom,
    formTo,
    appliedQuery,
    appliedTags,
    appliedFrom,
    appliedTo,
    hasActiveFilters,
    apply,
    clear,
  }
})
