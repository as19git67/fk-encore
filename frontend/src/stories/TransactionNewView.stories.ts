import type { Meta, StoryObj } from '@storybook/vue3'
import TransactionNewView from '../views/finance/TransactionNewView.vue'
import { defaultHandlers } from './handlers'
import { http, HttpResponse } from 'msw'
import { MOCK_ACCOUNTS, MOCK_FINANCE_TAGS } from './finance-mock-data'
import { routeFromParameters } from './storyRoute'

/**
 * Entering a cash booking by hand (issue #1281). The form leans on what was
 * paid to recently, so the story with suggestions and the one without are
 * two different pages.
 */

const ROUTE = '/finanzen/umsaetze/neu'

const newHandlers = [
  http.get('/api/finance/accounts', () => HttpResponse.json({ items: MOCK_ACCOUNTS })),
  http.get('/api/finance/tags', () => HttpResponse.json({ items: MOCK_FINANCE_TAGS })),
  http.get('/api/finance/transactions/recent-cash-recipients', () =>
    HttpResponse.json({
      items: [
        { counterparty: 'Musterbäckerei', count: 12 },
        { counterparty: 'Beispielmarkt', count: 7 },
        { counterparty: 'Kiosk am Beispielplatz', count: 3 },
      ],
    }),
  ),
  ...defaultHandlers,
]

const meta: Meta<typeof TransactionNewView> = {
  title: 'Views/TransactionNewView',
  component: TransactionNewView,
  decorators: [routeFromParameters(ROUTE)],
  parameters: { msw: { handlers: newHandlers } },
}

export default meta
type Story = StoryObj<typeof TransactionNewView>

export const LeeresFormular: Story = { name: 'Leeres Formular' }

export const OhneVorschlaege: Story = {
  name: 'Ohne Empfänger-Vorschläge',
  parameters: {
    msw: {
      handlers: [
        http.get('/api/finance/transactions/recent-cash-recipients', () =>
          HttpResponse.json({ items: [] }),
        ),
        ...newHandlers,
      ],
    },
  },
}

/**
 * Tags that have been picked: each one its own chip, with the button that
 * takes it back off. They used to render as bare text — two tags read as one
 * long phrase, and the only way back was the backspace key.
 */
export const MitTags: Story = {
  name: 'Mit gesetzten Tags',
  play: async () => {
    const field = await waitFor(() => document.querySelector<HTMLElement>('.tag-ac'))
    const input = await waitFor(() => field.querySelector<HTMLInputElement>('input'))

    for (const tag of ['Lebensmittel', 'Strom']) {
      input.focus()
      input.value = tag.slice(0, 5)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const option = await waitFor(() =>
        Array.from(document.querySelectorAll<HTMLElement>('.p-autocomplete-option')).find(
          (el) => el.textContent?.trim() === tag,
        ),
      )
      option.click()
      await waitFor(() =>
        Array.from(field.querySelectorAll<HTMLElement>('.p-autocomplete-chip')).find(
          (el) => el.textContent?.includes(tag),
        ),
      )
    }

    const chips = Array.from(field.querySelectorAll<HTMLElement>('.p-autocomplete-chip'))
    const [firstChip, secondChip] = chips
    if (chips.length !== 2 || !firstChip || !secondChip) {
      throw new Error(`${chips.length} chips for two tags`)
    }

    for (const chip of chips) {
      const style = getComputedStyle(chip)
      // A chip has a surface of its own — bare text has neither fill nor outline.
      const filled = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent'
      const outlined = Number.parseFloat(style.borderTopWidth) > 0
      if (!filled && !outlined) {
        throw new Error(`the tag "${chip.textContent?.trim()}" renders as bare text`)
      }
      if (!chip.querySelector('svg, .p-chip-remove-icon, [data-pc-section="removeicon"]')) {
        throw new Error(`the tag "${chip.textContent?.trim()}" cannot be taken off again`)
      }
    }

    // And they stand apart, so two tags never read as one phrase.
    const first = firstChip.getBoundingClientRect()
    const second = secondChip.getBoundingClientRect()
    const apart = second.top >= first.bottom ? second.top - first.bottom : second.left - first.right
    if (apart <= 0) {
      throw new Error('the two tags touch')
    }
  },
}

export const Telefon: Story = {
  name: 'Telefonbreite',
  parameters: { testViewport: { width: 360, height: 740 } },
}

async function waitFor<T>(read: () => T | null | undefined, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the tag field')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
