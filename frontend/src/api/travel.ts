import { apiFetch } from './client'

/** Reise › Hotelpreise (travel/hotel-watch.ts). */

export type HotelWatchStatus = 'active' | 'paused' | 'ended'

export interface HotelCheck {
  id: number
  checked_at: string
  searches: number
  offer_count: number
  lowest_per_night: number | null
  lowest_free_per_night: number | null
  lowest_free_breakfast_per_night: number | null
  matching_per_night: number | null
  matching_source: string | null
  below_limit: boolean
  error: string | null
}

export interface HotelWatch {
  id: number
  query: string
  hotel_name: string | null
  check_in: string
  check_out: string
  nights: number
  adults: number
  children_ages: number[]
  currency: string
  limit_per_night: number | null
  free_cancellation_only: boolean
  breakfast_required: boolean
  end_date: string
  paused: boolean
  notify_push: boolean
  notify_email: boolean
  /** The price last reported; null when nothing below the limit is pending. */
  notified_per_night: number | null
  status: HotelWatchStatus
  last_checked_at: string | null
  last_error: string | null
  latest: HotelCheck | null
  best_matching_per_night: number | null
  created_at: string
}

export interface HotelOfferEntry {
  source: string
  room: string
  per_night: number
  total: number | null
  /** Null: Google names no cancellation terms for this provider. */
  free_cancellation: boolean | null
  cancel_until: string | null
  breakfast: boolean
  guests: number | null
  link: string | null
}

export interface HotelWatchDetail {
  watch: HotelWatch
  checks: HotelCheck[]
  offers: HotelOfferEntry[]
}

export interface HotelWatchInput {
  query: string
  check_in: string
  check_out: string
  adults: number
  children_ages: number[]
  currency: string
  limit_per_night: number | null
  free_cancellation_only: boolean
  breakfast_required: boolean
  end_date: string
  paused: boolean
  notify_push: boolean
  notify_email: boolean
}

export interface HotelSearchStatus {
  configured: boolean
  searches_this_month: number
  monthly_budget: number
  check_time: string
  today: string
  max_end_date: string
}

export function listHotelWatches() {
  return apiFetch<{ watches: HotelWatch[] }>('/travel/hotel-watches')
}

export function getHotelWatch(id: number) {
  return apiFetch<HotelWatchDetail>(`/travel/hotel-watches/${id}`)
}

export function createHotelWatch(input: HotelWatchInput) {
  return apiFetch<{ watch: HotelWatch }>('/travel/hotel-watches', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateHotelWatch(id: number, input: HotelWatchInput) {
  return apiFetch<{ watch: HotelWatch }>(`/travel/hotel-watches/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deleteHotelWatch(id: number) {
  return apiFetch<{ deleted: boolean }>(`/travel/hotel-watches/${id}`, { method: 'DELETE' })
}

export function checkHotelWatch(id: number) {
  return apiFetch<{ check: HotelCheck }>(`/travel/hotel-watches/${id}/check`, { method: 'POST' })
}

export function getHotelSearchStatus() {
  return apiFetch<HotelSearchStatus>('/travel/hotel-search-status')
}
