import type { Meta, StoryObj } from '@storybook/vue3'
import ForecastSurvivor from '../components/finance/forecast/ForecastSurvivor.vue'
import { SURVIVOR } from './forecastRobustnessFixture'

/** The survivor check of the retirement forecast (#1341). Everything invented. */

const meta: Meta<typeof ForecastSurvivor> = {
  title: 'Components/Finance/ForecastSurvivor',
  component: ForecastSurvivor,
  args: {
    check: SURVIVOR,
    person: { id: 1, label: 'Alex', birthDate: '1970-04-01', sortOrder: 0 },
    real: true,
    inflationRate: 0.02,
    startYear: 2026,
    endYear: 2068,
  },
}

export default meta
type Story = StoryObj<typeof ForecastSurvivor>

export const Standard: Story = {}

export const ImmerGenug: Story = {
  name: 'Reicht in jedem Jahr',
  args: { check: { ...SURVIVOR, rows: SURVIVOR.rows.map((r) => ({ ...r, ok: true, failYear: null, finalWealth: 15000 * (r.age - 50) })), worstAge: 57 } },
}
