import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as api from '../../api/finance'

export const useSyncScheduleStore = defineStore('finance.syncSchedule', () => {
  const slotsById = ref<Map<number, api.SyncSlot[]>>(new Map())
  const loading = ref(false)

  async function load(bankcontactId: number) {
    loading.value = true
    try {
      const resp = await api.getSchedule(bankcontactId)
      slotsById.value = new Map(slotsById.value).set(bankcontactId, resp.slots)
      return resp.slots
    } finally {
      loading.value = false
    }
  }

  async function save(bankcontactId: number, slots: api.SyncSlot[]) {
    const resp = await api.putSchedule(bankcontactId, slots)
    slotsById.value = new Map(slotsById.value).set(bankcontactId, resp.slots)
    return resp.slots
  }

  function get(bankcontactId: number): api.SyncSlot[] {
    return slotsById.value.get(bankcontactId) ?? []
  }

  return { slotsById, loading, load, save, get }
})
