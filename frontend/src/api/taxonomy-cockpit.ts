import { apiFetch } from './client'

export interface TaxonomySnapshot {
  snapshot_date: string
  total_documents: number
  classified_documents: number
  sonstiges_count: number
  sonstiges_pct: number
  avg_confidence: number | null
  low_confidence_count: number
  teacher_requested_count: number
  open_suggestions_count: number
  category_count: number
}

export interface Recommendation {
  severity: 'info' | 'warning' | 'critical'
  action: string
  reason: string
}

export interface CockpitResponse {
  snapshots: TaxonomySnapshot[]
  recommendations: Recommendation[]
}

export async function getTaxonomyCockpit(): Promise<CockpitResponse> {
  return apiFetch('/admin/taxonomy-cockpit')
}

export async function triggerSnapshot(): Promise<TaxonomySnapshot> {
  return apiFetch('/admin/taxonomy-cockpit/snapshot', { method: 'POST' })
}
