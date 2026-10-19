/**
 * Arranging the values by form field for the Ausfüllhilfe
 * (documentation/plans/steuer-ausfuellhilfe.md, stage 3): Anlage → owner →
 * fields in the order of the form, and the words for a value's state.
 */
import type { TaxFormValue, TaxValueStatus } from '../api/assistant'

export interface TaxFormGroup {
  /** Anlage and owner, unique within the worksheet. */
  id: string
  anlage: string
  owner: string
  values: TaxFormValue[]
}

/** Groups in the order the values come (the catalogue's order), one per Anlage and owner. */
export function groupFormValues(values: readonly TaxFormValue[]): TaxFormGroup[] {
  const groups = new Map<string, TaxFormGroup>()
  for (const v of values) {
    const id = `${v.anlage}|${v.owner}`
    const group = groups.get(id) ?? { id, anlage: v.anlage_name, owner: v.owner_label, values: [] }
    group.values.push(v)
    groups.set(id, group)
  }
  return [...groups.values()]
}

export const TAX_VALUE_STATUS_LABEL: Record<TaxValueStatus, string> = {
  read: 'ausgelesen, ungeprüft',
  confirmed: 'bestätigt',
  corrected: 'korrigiert',
  rejected: 'nicht belegt',
}

export function taxValueSeverity(status: TaxValueStatus): 'warn' | 'success' | 'info' | 'danger' {
  if (status === 'confirmed') return 'success'
  if (status === 'corrected') return 'info'
  if (status === 'rejected') return 'danger'
  return 'warn'
}

/** Euro as typed in the correction field → whole cents; null for anything that is not an amount. */
export function eurosToCents(euros: number | null | undefined): number | null {
  if (euros === null || euros === undefined || !Number.isFinite(euros) || euros < 0) return null
  return Math.round(euros * 100)
}
