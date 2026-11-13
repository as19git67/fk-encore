import type { Meta, StoryObj } from '@storybook/vue3'
import { http, HttpResponse } from 'msw'
import TravelFlightWatchesView from '../views/TravelFlightWatchesView.vue'
import { defaultHandlers } from './handlers'
import { routeFromParameters } from './storyRoute'
import type { FlightCheck, FlightWatch, FlightWatchDetail, HotelSearchStatus } from '../api/travel'

/** Reise › Flugpreise: a flexible and a fixed watch; airports and airlines are made up. */

const STATUS: HotelSearchStatus = {
  configured: true,
  searches_this_month: 52,
  monthly_budget: 250,
  check_time: '06:00',
  today: '2026-11-12',
  max_end_date: '2028-11-12',
}

const check = (id: number, at: string, outbound: string, ret: string, price: number, over: Partial<FlightCheck> = {}): FlightCheck => ({
  id,
  checked_at: at,
  searches: 1,
  outbound_date: outbound,
  return_date: ret,
  flight_count: 14,
  lowest_price: price,
  lowest_airlines: 'Beispiel Air',
  lowest_stops: 0,
  price_level: price < 420 ? 'low' : 'typical',
  typical_low: 420,
  typical_high: 610,
  below_limit: price < 400,
  error: null,
  ...over,
})

const CHECKS: FlightCheck[] = [
  check(4, '2026-11-12T05:15:00Z', '2027-05-02', '2027-05-06', 389, { searches: 3 }),
  check(3, '2026-11-11T05:15:00Z', '2027-05-02', '2027-05-05', 455, { lowest_airlines: 'Muster Wings', lowest_stops: 1 }),
  check(2, '2026-11-10T05:15:00Z', '2027-05-01', '2027-05-05', 0, {
    error: 'SerpApi nicht erreichbar: timeout',
    flight_count: 0,
    lowest_price: null,
    lowest_airlines: null,
    price_level: null,
  }),
  check(1, '2026-11-09T05:15:00Z', '2027-05-01', '2027-05-04', 470),
]

const FLEX: FlightWatch = {
  id: 1,
  origin: 'AAA,DDD',
  destination: 'BBB',
  trip_type: 'round',
  flexible: true,
  outbound_date: null,
  return_date: null,
  date_from: '2027-05-01',
  date_until: '2027-05-06',
  min_nights: 3,
  max_nights: 4,
  adults: 2,
  children: 1,
  infants_on_lap: 0,
  travel_class: 1,
  max_stops: 1,
  airlines: null,
  airlines_mode: null,
  outbound_times: '6,14',
  return_times: null,
  currency: 'EUR',
  limit_total: 400,
  end_date: '2027-05-02',
  paused: false,
  notify_push: true,
  notify_email: true,
  notified_price: 389,
  status: 'active',
  last_checked_at: '2026-11-12T05:15:00Z',
  last_error: null,
  combinations: 5,
  latest: CHECKS[0]!,
  best: {
    price: 389,
    outbound_date: '2027-05-02',
    return_date: '2027-05-06',
    airlines: 'Beispiel Air',
    stops: 0,
    checked_at: '2026-11-12T05:15:00Z',
    link: 'https://www.google.com/travel/flights?q=Flights',
  },
  link: 'https://www.google.com/travel/flights?q=Flights',
  created_at: '2026-11-09T05:00:00Z',
}

const FIXED: FlightWatch = {
  ...FLEX,
  id: 2,
  origin: 'AAA',
  destination: 'EEE',
  trip_type: 'oneway',
  flexible: false,
  outbound_date: '2027-08-14',
  date_from: null,
  date_until: null,
  min_nights: null,
  max_nights: null,
  adults: 1,
  children: 0,
  travel_class: 3,
  max_stops: 0,
  airlines: 'XX',
  airlines_mode: 'exclude',
  outbound_times: null,
  limit_total: null,
  end_date: '2027-08-13',
  notified_price: null,
  paused: true,
  status: 'paused',
  combinations: 1,
  last_checked_at: null,
  latest: null,
  best: null,
}

const DETAIL: FlightWatchDetail = {
  watch: FLEX,
  checks: CHECKS,
  offers: [
    { price: 389, airlines: 'Beispiel Air', flight_numbers: 'BX 101', departs_at: '2027-05-02 07:05', arrives_at: '2027-05-02 09:50', duration_min: 165, stops: 0, layovers: '', best: true },
    { price: 412, airlines: 'Muster Wings', flight_numbers: 'MW 7, MW 21', departs_at: '2027-05-02 11:40', arrives_at: '2027-05-02 16:10', duration_min: 270, stops: 1, layovers: 'CCC', best: false },
    { price: 455, airlines: 'Beispiel Air', flight_numbers: 'BX 103', departs_at: '2027-05-02 13:20', arrives_at: '2027-05-02 16:05', duration_min: 165, stops: 0, layovers: '', best: false },
  ],
  bookings: {
    checked_at: '2026-11-12T05:15:00Z',
    outbound_date: '2027-05-02',
    return_date: '2027-05-06',
    options: [
      { book_with: 'Portal A', price: 381, option_title: null, extensions: '' },
      { book_with: 'Beispiel Air', price: 389, option_title: 'Basic', extensions: 'Keine Erstattung, Handgepäck' },
    ],
  },
  history: {
    outbound_date: '2027-05-02',
    return_date: '2027-05-06',
    points: [470, 462, 455, 458, 440, 431, 425, 410, 402, 395, 389].map((price, i) => ({
      day: `2026-11-${String(i + 2).padStart(2, '0')}`,
      price,
    })),
  },
  combinations: [
    { outbound_date: '2027-05-01', return_date: '2027-05-04', price: 470, price_level: 'typical', checked_at: '2026-11-09T05:15:00Z', link: '#' },
    { outbound_date: '2027-05-01', return_date: '2027-05-05', price: null, price_level: null, checked_at: null, link: '#' },
    { outbound_date: '2027-05-02', return_date: '2027-05-05', price: 455, price_level: 'typical', checked_at: '2026-11-11T05:15:00Z', link: '#' },
    { outbound_date: '2027-05-02', return_date: '2027-05-06', price: 389, price_level: 'low', checked_at: '2026-11-12T05:15:00Z', link: '#' },
    { outbound_date: '2027-05-03', return_date: '2027-05-06', price: null, price_level: null, checked_at: null, link: '#' },
  ],
}

const handlers = (watches: FlightWatch[], status: HotelSearchStatus = STATUS) => [
  http.get('/api/travel/flight-watches', () => HttpResponse.json({ watches })),
  http.get('/api/travel/flight-watches/:id', () => HttpResponse.json(DETAIL)),
  http.get('/api/travel/hotel-search-status', () => HttpResponse.json(status)),
  ...defaultHandlers,
]

const meta: Meta<typeof TravelFlightWatchesView> = {
  title: 'Views/TravelFlightWatchesView',
  component: TravelFlightWatchesView,
  decorators: [routeFromParameters('/reise/flugpreise?watch=1')],
  parameters: { msw: { handlers: handlers([FLEX, FIXED]) } },
}

export default meta
type Story = StoryObj<typeof TravelFlightWatchesView>

export const Flexibel: Story = { name: 'Flexibler Wächter mit Verlauf' }

export const Telefon: Story = {
  name: 'Auf dem Telefon',
  parameters: { testViewport: { width: 390, height: 844 } },
}

export const OhneSchluessel: Story = {
  name: 'Kein Wächter, kein Schlüssel',
  parameters: {
    route: '/reise/flugpreise',
    msw: { handlers: handlers([], { ...STATUS, configured: false, searches_this_month: 0 }) },
  },
}
