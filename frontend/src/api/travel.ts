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
  /** Also price the party in double rooms (two adults each). */
  split_rooms: boolean
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

/** Reise › Flugpreise (travel/flight-watch.ts). Key, budget and today come from getHotelSearchStatus. */

export type FlightTripType = 'round' | 'oneway'
export type AirlinesMode = 'include' | 'exclude'

export interface FlightCheck {
  id: number
  checked_at: string
  searches: number
  outbound_date: string
  return_date: string | null
  flight_count: number
  lowest_price: number | null
  lowest_airlines: string | null
  lowest_stops: number | null
  /** Google's assessment: 'low', 'typical', 'high'. */
  price_level: string | null
  typical_low: number | null
  typical_high: number | null
  below_limit: boolean
  error: string | null
}

export interface FlightBestKnown {
  price: number
  outbound_date: string
  return_date: string | null
  airlines: string | null
  stops: number | null
  checked_at: string
  link: string
}

export interface FlightWatch {
  id: number
  origin: string
  destination: string
  trip_type: FlightTripType
  flexible: boolean
  outbound_date: string | null
  return_date: string | null
  date_from: string | null
  date_until: string | null
  min_nights: number | null
  max_nights: number | null
  adults: number
  children: number
  infants_on_lap: number
  travel_class: number
  max_stops: number | null
  airlines: string | null
  airlines_mode: AirlinesMode | null
  outbound_times: string | null
  return_times: string | null
  currency: string
  limit_total: number | null
  end_date: string
  paused: boolean
  notify_push: boolean
  notify_email: boolean
  notified_price: number | null
  status: HotelWatchStatus
  last_checked_at: string | null
  last_error: string | null
  /** Date combinations still ahead (1 for fixed dates). */
  combinations: number
  latest: FlightCheck | null
  /** The cheapest of the latest checks of the combinations still ahead. */
  best: FlightBestKnown | null
  /** Google Flights search for the fixed dates (or the best combination). */
  link: string | null
  created_at: string
}

export interface FlightOfferEntry {
  price: number
  airlines: string
  flight_numbers: string
  departs_at: string | null
  arrives_at: string | null
  duration_min: number | null
  stops: number
  layovers: string
  best: boolean
}

export interface FlightBookingEntry {
  book_with: string
  price: number | null
  option_title: string | null
  extensions: string
}

export interface FlightCombinationEntry {
  outbound_date: string
  return_date: string | null
  price: number | null
  price_level: string | null
  checked_at: string | null
  link: string
}

export interface FlightWatchDetail {
  watch: FlightWatch
  checks: FlightCheck[]
  offers: FlightOfferEntry[]
  bookings: {
    checked_at: string
    outbound_date: string
    return_date: string | null
    options: FlightBookingEntry[]
  } | null
  history: { outbound_date: string; return_date: string | null; points: { day: string; price: number }[] } | null
  combinations: FlightCombinationEntry[]
}

export interface FlightWatchInput {
  origin: string
  destination: string
  trip_type: FlightTripType
  flexible: boolean
  outbound_date: string | null
  return_date: string | null
  date_from: string | null
  date_until: string | null
  min_nights: number | null
  max_nights: number | null
  adults: number
  children: number
  infants_on_lap: number
  travel_class: number
  max_stops: number | null
  airlines: string | null
  airlines_mode: AirlinesMode | null
  outbound_times: string | null
  return_times: string | null
  currency: string
  limit_total: number | null
  end_date: string
  paused: boolean
  notify_push: boolean
  notify_email: boolean
}

export function listFlightWatches() {
  return apiFetch<{ watches: FlightWatch[] }>('/travel/flight-watches')
}

export function getFlightWatch(id: number) {
  return apiFetch<FlightWatchDetail>(`/travel/flight-watches/${id}`)
}

export function createFlightWatch(input: FlightWatchInput) {
  return apiFetch<{ watch: FlightWatch }>('/travel/flight-watches', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateFlightWatch(id: number, input: FlightWatchInput) {
  return apiFetch<{ watch: FlightWatch }>(`/travel/flight-watches/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deleteFlightWatch(id: number) {
  return apiFetch<{ deleted: boolean }>(`/travel/flight-watches/${id}`, { method: 'DELETE' })
}

export function checkFlightWatch(id: number) {
  return apiFetch<{ check: FlightCheck }>(`/travel/flight-watches/${id}/check`, { method: 'POST' })
}
