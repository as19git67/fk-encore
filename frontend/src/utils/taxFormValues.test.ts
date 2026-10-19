import { describe, expect, it } from 'vitest'
import type { TaxFormValue } from '../api/assistant'
import { eurosToCents, groupFormValues, TAX_VALUE_STATUS_LABEL, taxValueSeverity } from './taxFormValues'

const value = (key: string, anlage: string, owner: string): TaxFormValue => ({
  key,
  anlage,
  anlage_name: `Anlage ${anlage}`,
  label: key,
  owner,
  owner_label: owner === 'self' ? 'Person A (Sie)' : 'Person B (Ehegatte)',
  line: 1,
  kennzahl: '100',
  place: 'Zeile 1 · Kz 100',
  checked: true,
  source: 'Beispiel',
  form_note: null,
  prefilled: false,
  cents: 100,
  contributions: [],
  notes: [],
  open: 0,
  previous_cents: null,
})

describe('groupFormValues', () => {
  it('groups by Anlage and owner in the order of the form', () => {
    const groups = groupFormValues([
      value('n.a', 'n', 'self'),
      value('n.b', 'n', 'self'),
      value('n.a', 'n', 'spouse'),
      value('v.a', 'vorsorge', 'self'),
    ])
    expect(groups.map((g) => [g.anlage, g.owner, g.values.map((v) => v.key)])).toEqual([
      ['Anlage n', 'Person A (Sie)', ['n.a', 'n.b']],
      ['Anlage n', 'Person B (Ehegatte)', ['n.a']],
      ['Anlage vorsorge', 'Person A (Sie)', ['v.a']],
    ])
  })
})

describe('value states', () => {
  it('names every state and marks the unchecked one', () => {
    expect(TAX_VALUE_STATUS_LABEL.read).toBe('ausgelesen, ungeprüft')
    expect(taxValueSeverity('read')).toBe('warn')
    expect(taxValueSeverity('confirmed')).toBe('success')
    expect(taxValueSeverity('rejected')).toBe('danger')
  })
})

describe('eurosToCents', () => {
  it('turns typed euros into whole cents and refuses what is no amount', () => {
    expect(eurosToCents(1234.56)).toBe(123456)
    expect(eurosToCents(0.1 + 0.2)).toBe(30)
    expect(eurosToCents(0)).toBe(0)
    expect(eurosToCents(null)).toBeNull()
    expect(eurosToCents(-1)).toBeNull()
    expect(eurosToCents(Number.NaN)).toBeNull()
  })
})
