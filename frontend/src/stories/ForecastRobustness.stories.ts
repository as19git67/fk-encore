import type { Meta, StoryObj } from '@storybook/vue3'
import ForecastRobustness from '../components/finance/forecast/ForecastRobustness.vue'
import { LEVERS, SENSITIVITY } from './forecastRobustnessFixture'

/** Sensitivity table and levers of the retirement forecast (#1339). Everything invented. */

const meta: Meta<typeof ForecastRobustness> = {
  title: 'Components/Finance/ForecastRobustness',
  component: ForecastRobustness,
  args: { sensitivity: SENSITIVITY, levers: LEVERS, person: { id: 1, label: 'Alex', birthDate: '1970-04-01', sortOrder: 0 } },
}

export default meta
type Story = StoryObj<typeof ForecastRobustness>

export const Standard: Story = {}

export const KeinAlterReicht: Story = {
  name: 'Kein Alter reicht',
  args: {
    sensitivity: { ...SENSITIVITY, cells: SENSITIVITY.cells.map((c) => ({ ...c, age: null })) },
    levers: { ...LEVERS, baseAge: null, levers: LEVERS.levers.map((l) => ({ ...l, age: null, deltaYears: null })), biggest: null },
  },
}
