import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTxFiltersStore } from './txFilters'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('finance/txFilters — tax relevance', () => {
  it('keeps the form value until it is applied', () => {
    const store = useTxFiltersStore()
    store.formTaxRelevant = true
    expect(store.appliedTaxRelevant).toBeNull()
    expect(store.hasActiveFilters).toBe(false)

    store.apply()
    expect(store.appliedTaxRelevant).toBe(true)
    expect(store.hasActiveFilters).toBe(true)
  })

  it('treats "not tax-relevant" as an active filter, unlike no filter at all', () => {
    const store = useTxFiltersStore()
    store.formTaxRelevant = false
    store.apply()
    expect(store.hasActiveFilters).toBe(true)

    store.formTaxRelevant = null
    store.apply()
    expect(store.hasActiveFilters).toBe(false)
  })

  it('resets form and applied value on clear', () => {
    const store = useTxFiltersStore()
    store.formTaxRelevant = true
    store.apply()
    store.clear()
    expect(store.formTaxRelevant).toBeNull()
    expect(store.appliedTaxRelevant).toBeNull()
    expect(store.hasActiveFilters).toBe(false)
  })
})
