import type { Meta, StoryObj } from '@storybook/vue3'
import ForecastPlanActual from '../components/finance/forecast/ForecastPlanActual.vue'
import { PLAN_ACTUAL } from './forecastRobustnessFixture'

/** Plan against reality (#1342). Everything invented. */

const meta: Meta<typeof ForecastPlanActual> = {
  title: 'Components/Finance/ForecastPlanActual',
  component: ForecastPlanActual,
  args: { data: PLAN_ACTUAL, scenarioName: 'Standardannahmen', canEdit: true, busy: false },
}

export default meta
type Story = StoryObj<typeof ForecastPlanActual>

export const Standard: Story = {}

export const NochKeinStand: Story = {
  name: 'Noch kein Stand',
  args: { data: { ...PLAN_ACTUAL, snapshots: [], actuals: null } },
}

export const NurLesen: Story = {
  name: 'Geteilt, nur lesen',
  args: { canEdit: false },
}
