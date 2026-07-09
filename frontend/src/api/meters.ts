import { apiFetch } from './client'

export type MeterType = 'electricity' | 'water' | 'gas' | 'operating_hours'

export interface MeterListItem {
  id: number
  name: string
  type: MeterType
  unit: string
  location: string | null
  notes: string | null
  decimals: number
  groupId: number | null
  ownerUserId: number
  activeDeviceSerial: string | null
  lastReadingValue: number | null
  lastReadingAt: string | null
  absoluteTotal: number
}

export interface MeterDevice {
  id: number
  serialNumber: string | null
  installedAt: string
  removedAt: string | null
  startValue: number
  endValue: number | null
  notes: string | null
  active: boolean
}

export interface MeterDetail extends MeterListItem {
  createdAt: string
  updatedAt: string
  photoPath: string | null
  devices: MeterDevice[]
}

export interface InitialDeviceInput {
  serialNumber?: string
  installedAt: string
  startValue?: number
}

export interface CreateMeterRequest {
  name: string
  type: MeterType
  unit: string
  location?: string
  notes?: string
  decimals?: number
  groupId?: number | null
  device: InitialDeviceInput
}

export interface UpdateMeterRequest {
  name: string
  type: MeterType
  unit: string
  location?: string
  notes?: string
  decimals?: number
  groupId?: number | null
}

export interface ReplaceDeviceRequest {
  swapAt: string
  finalValue: number
  newSerialNumber?: string
  newStartValue?: number
}

export function listMeters() {
  return apiFetch<{ meters: MeterListItem[] }>('/meters')
}

export function getMeter(id: number) {
  return apiFetch<MeterDetail>(`/meters/${id}`)
}

export function createMeter(req: CreateMeterRequest) {
  return apiFetch<{ id: number }>('/meters', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export function updateMeter(id: number, req: UpdateMeterRequest) {
  return apiFetch<MeterDetail>(`/meters/${id}`, {
    method: 'PUT',
    body: JSON.stringify(req),
  })
}

export function deleteMeter(id: number) {
  return apiFetch<{ deleted: boolean }>(`/meters/${id}`, {
    method: 'DELETE',
  })
}

export function replaceMeterDevice(id: number, req: ReplaceDeviceRequest) {
  return apiFetch<{ newDeviceId: number }>(`/meters/${id}/replace-device`, {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

/** Human-readable German labels for the meter types. */
export const METER_TYPE_LABELS: Record<MeterType, string> = {
  electricity: 'Strom',
  water: 'Wasser',
  gas: 'Gas',
  operating_hours: 'Betriebsstunden',
}

/** PrimeIcons class per meter type, for list/detail rendering. */
export const METER_TYPE_ICONS: Record<MeterType, string> = {
  electricity: 'pi pi-bolt',
  water: 'pi pi-cloud',
  gas: 'pi pi-cloud',
  operating_hours: 'pi pi-clock',
}
