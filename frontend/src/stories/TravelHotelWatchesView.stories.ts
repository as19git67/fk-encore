import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import TravelHotelWatchesView from '../views/TravelHotelWatchesView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import type { HotelCheck, HotelSearchStatus, HotelWatch, HotelWatchDetail } from '../api/travel'

/** Reise › Hotelpreise: two watches, the first one chosen with its rates and history. */

const STATUS: HotelSearchStatus = {
  configured: true,
  searches_this_month: 37,
  monthly_budget: 250,
  check_time: '06:00',
  today: '2026-11-07',
  max_end_date: '2028-11-07',
}

const check = (id: number, at: string, matching: number, over: Partial<HotelCheck> = {}): HotelCheck => ({
  id,
  checked_at: at,
  searches: 1,
  offer_count: 6,
  lowest_per_night: matching - 30,
  lowest_free_per_night: matching,
  lowest_free_breakfast_per_night: matching + 20,
  matching_per_night: matching,
  matching_source: 'Portal A',
  below_limit: matching < 200,
  error: null,
  ...over,
})

const CHECKS: HotelCheck[] = [
  check(5, '2026-11-07T06:00:00Z', 185),
  check(4, '2026-11-07T00:00:00Z', 0, { error: 'SerpApi nicht erreichbar: timeout', offer_count: 0, matching_per_night: null, lowest_per_night: null, lowest_free_per_night: null, lowest_free_breakfast_per_night: null, matching_source: null }),
  check(3, '2026-11-06T18:00:00Z', 205),
  check(2, '2026-11-06T12:00:00Z', 230, { matching_source: 'Portal B' }),
  check(1, '2026-11-06T06:00:00Z', 230, { searches: 2 }),
]

const CITY: HotelWatch = {
  id: 1,
  query: 'Hotel Beispiel Musterstadt',
  hotel_name: 'Hotel Beispiel Musterstadt',
  check_in: '2027-05-12',
  check_out: '2027-05-14',
  nights: 2,
  adults: 3,
  children_ages: [],
  currency: 'EUR',
  limit_per_night: 200,
  free_cancellation_only: true,
  breakfast_required: false,
  end_date: '2027-05-11',
  paused: false,
  notify_push: true,
  notify_email: true,
  notified_per_night: 185,
  status: 'active',
  last_checked_at: '2026-11-07T06:00:00Z',
  last_error: null,
  latest: CHECKS[0]!,
  best_matching_per_night: 185,
  created_at: '2026-11-06T05:50:00Z',
}

const SEA: HotelWatch = {
  ...CITY,
  id: 2,
  query: 'Strandhotel Beispielbucht',
  hotel_name: null,
  check_in: '2027-07-10',
  check_out: '2027-07-17',
  nights: 7,
  adults: 2,
  children_ages: [8, 12],
  limit_per_night: null,
  breakfast_required: true,
  end_date: '2027-06-30',
  paused: true,
  status: 'paused',
  last_checked_at: null,
  latest: null,
  best_matching_per_night: null,
}

const DETAIL: HotelWatchDetail = {
  watch: CITY,
  checks: CHECKS,
  offers: [
    { source: 'Portal A', room: 'Familienzimmer', per_night: 155, total: 310, free_cancellation: false, cancel_until: null, breakfast: false, guests: 3, link: 'https://portal-a.example/hotel' },
    { source: 'Portal A', room: 'Familienzimmer', per_night: 185, total: 370, free_cancellation: true, cancel_until: '10. Mai', breakfast: false, guests: 3, link: 'https://portal-a.example/hotel' },
    { source: 'Portal B', room: '(ohne Zimmerangabe)', per_night: 190, total: 380, free_cancellation: null, cancel_until: null, breakfast: false, guests: null, link: 'https://portal-b.example/angebot' },
    { source: 'Portal A', room: 'Familienzimmer, Frühstück', per_night: 205, total: 410, free_cancellation: true, cancel_until: '10. Mai', breakfast: true, guests: 3, link: 'https://portal-a.example/hotel' },
  ],
}

const handlers = (watches: HotelWatch[], status: HotelSearchStatus = STATUS) => [
  http.get('/api/travel/hotel-watches', () => HttpResponse.json({ watches })),
  http.get('/api/travel/hotel-watches/:id', () => HttpResponse.json(DETAIL)),
  http.get('/api/travel/hotel-search-status', () => HttpResponse.json(status)),
  ...defaultHandlers,
]

const meta: Meta<typeof TravelHotelWatchesView> = {
  title: 'Views/TravelHotelWatchesView',
  component: TravelHotelWatchesView,
  decorators: [routeFromParameters('/reise/hotelpreise?watch=1')],
  parameters: { msw: { handlers: handlers([CITY, SEA]) } },
}

export default meta
type Story = StoryObj<typeof TravelHotelWatchesView>

export const MitVerlauf: Story = { name: 'Wächter mit Preisen und Verlauf' }

export const Telefon: Story = {
  name: 'Auf dem Telefon',
  parameters: { testViewport: { width: 390, height: 844 } },
}

export const OhneSchluessel: Story = {
  name: 'Kein Wächter, kein Schlüssel',
  parameters: {
    route: '/reise/hotelpreise',
    msw: { handlers: handlers([], { ...STATUS, configured: false, searches_this_month: 0 }) },
  },
}
