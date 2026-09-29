import type { Meta, StoryObj } from '@storybook/vue3'
import ForecastTargetAge from '../components/finance/forecast/ForecastTargetAge.vue'
import { REVERSE_GAP, REVERSE_OK } from './forecastRobustnessFixture'

/** "What does it take to leave at X?" (#1340). Everything invented. */

const meta: Meta<typeof ForecastTargetAge> = {
  title: 'Components/Finance/ForecastTargetAge',
  component: ForecastTargetAge,
  args: { reverse: REVERSE_GAP, person: { id: 1, label: 'Alex', birthDate: '1970-04-01', sortOrder: 0 }, currentReturnRate: 0.04 },
}

export default meta
type Story = StoryObj<typeof ForecastTargetAge>

export const NichtErreichbar: Story = { name: 'Noch nicht erreichbar' }

export const Erreichbar: Story = { name: 'Erreichbar mit Puffer', args: { reverse: REVERSE_OK } }

export const NichtsReicht: Story = {
  name: 'Kein Hebel reicht',
  args: { reverse: { ...REVERSE_GAP, levers: REVERSE_GAP.levers.map((l) => ({ ...l, value: null, monthlyAmount: null })) } },
}
