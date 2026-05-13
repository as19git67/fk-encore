import type { Meta, StoryObj } from '@storybook/vue3'
import { onMounted } from 'vue'
import ServiceStatusBar from '../components/ServiceStatusBar.vue'
import { useServiceHealthStore } from '../stores/serviceHealth'
import {
  MOCK_SERVICES_OK, MOCK_SERVICES_DEGRADED,
  MOCK_SERVER_PRESSURE_OK,
} from './mock-data'
import type { ExternalServiceHealth, ServerPressureStatus } from '../api/photos'

const meta: Meta<typeof ServiceStatusBar> = {
  title: 'Components/ServiceStatusBar',
  component: ServiceStatusBar,
}

export default meta
type Story = StoryObj<typeof ServiceStatusBar>

function withStoreState(services: ExternalServiceHealth[], pressure: ServerPressureStatus) {
  return (story: any) => ({
    components: { Story: story() },
    setup() {
      const store = useServiceHealthStore()
      onMounted(() => {
        store.services = services
        store.serverPressure = pressure
      })
      return () => null
    },
    template: '<Story />',
  })
}

export const AlleDiensteOk: Story = {
  name: 'Alle Dienste erreichbar (nicht sichtbar)',
  decorators: [withStoreState(MOCK_SERVICES_OK, MOCK_SERVER_PRESSURE_OK)],
}

export const DiensteAusgefallen: Story = {
  name: 'Dienste nicht erreichbar',
  decorators: [withStoreState(MOCK_SERVICES_DEGRADED, MOCK_SERVER_PRESSURE_OK)],
}
