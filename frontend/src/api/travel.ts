import { apiFetch } from './client'

/** Reise › Hotelpreise (travel/hotel-watch.ts). */

export type HotelWatchStatus = 'active' | 'paused' | 'ended'
/** 'area': the watch names a place, narrowed by stars and guest rating. */
export type HotelWatchKind = 'hotel' | 'area'

/** A stay the price calendar estimated (hotel with flexible dates). */
export interface StayEstimate {
  start: string
  end: string
  perNight: number
}

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
  /** Area watches: the hotel of the matching offer. */
  matching_hotel: string | null
  below_limit: boolean
  error: string | null
  /** The stay this check priced; null on checks from before flexible dates. */
  check_in: string | null
  check_out: string | null
  /** Hotel with flexible dates: the cheapest stays of the price calendar (estimates). */
  stays: StayEstimate[] | null
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
  /** Also price the party in double rooms (two adults each). */
  split_rooms: boolean
  kind: HotelWatchKind
  min_stars: number | null
  /** Google's guest rating, 1–5. */
  min_rating: number | null
  /** check_in/check_out are earliest arrival and latest departure; a stay lasts min_nights–max_nights. */
  flexible: boolean
  min_nights: number | null
  max_nights: number | null
  last_arrival: string
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
  /** Rooms the offer books; prices are for all of them together. */
  rooms: number
  /** Area watches: the hotel of the offer. */
  hotel: string | null
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
  split_rooms: boolean
  kind: HotelWatchKind
  min_stars: number | null
  min_rating: number | null
  flexible: boolean
  min_nights: number | null
  max_nights: number | null
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
