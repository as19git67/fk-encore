import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { toLocalIsoDate, parseLocalDate } from '../../utils/dateFormat'

/**
 * Persists the filter form and applied-filter state for the transaction
 * list view so that opening the batch-tag dialog (or any other modal /
 * navigation) does not reset the user's search criteria.
 */
export const useTxFiltersStore = defineStore('finance.txFilters', () => {
  // Form state (what is currently in the filter inputs)
  const formQuery = ref('')
  const formTags = ref<string[]>([])
  const formFromIso = ref<string | null>(null)
  const formToIso = ref<string | null>(null)
  /** null = no tax filter, true = tax-relevant only, false = the rest. */
  const formTaxRelevant = ref<boolean | null>(null)

  // Applied state (what was last submitted via "Suchen")
  const appliedQuery = ref('')
  const appliedTags = ref<string[]>([])
  const appliedFromIso = ref<string | null>(null)
  const appliedToIso = ref<string | null>(null)
  const appliedTaxRelevant = ref<boolean | null>(null)

  const hasActiveFilters = computed(
    () =>
      appliedQuery.value.trim().length > 0 ||
      appliedTags.value.length > 0 ||
      appliedFromIso.value !== null ||
      appliedToIso.value !== null ||
      appliedTaxRelevant.value !== null,
  )

  // Convenience: Date objects derived from ISO date strings
  const formFrom = computed<Date | null>({
    get: () => (formFromIso.value ? parseLocalDate(formFromIso.value) : null),
    set: (d) => { formFromIso.value = d ? toLocalIsoDate(d) : null },
  })
  const formTo = computed<Date | null>({
    get: () => (formToIso.value ? parseLocalDate(formToIso.value) : null),
    set: (d) => { formToIso.value = d ? toLocalIsoDate(d) : null },
  })
  const appliedFrom = computed<Date | null>(() =>
    appliedFromIso.value ? parseLocalDate(appliedFromIso.value) : null,
  )
  const appliedTo = computed<Date | null>(() =>
    appliedToIso.value ? parseLocalDate(appliedToIso.value) : null,
  )

  function apply() {
    appliedQuery.value = formQuery.value
    appliedTags.value = [...formTags.value]
    appliedFromIso.value = formFromIso.value
    appliedToIso.value = formToIso.value
    appliedTaxRelevant.value = formTaxRelevant.value
  }

  function clear() {
    formQuery.value = ''
    formTags.value = []
    formFromIso.value = null
    formToIso.value = null
    formTaxRelevant.value = null
    appliedQuery.value = ''
    appliedTags.value = []
    appliedFromIso.value = null
    appliedToIso.value = null
    appliedTaxRelevant.value = null
  }

  return {
    formQuery,
    formTags,
    formFrom,
    formTo,
    formTaxRelevant,
    appliedQuery,
    appliedTags,
    appliedFrom,
    appliedTo,
    appliedTaxRelevant,
    hasActiveFilters,
    apply,
    clear,
  }
})
