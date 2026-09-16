import { describe, it, expect } from 'vitest'
import type { MeterType } from '../api/meters'
import { compareMetersByTypeAndName, sortMetersByTypeAndName } from './meterSort'

function meter(type: MeterType, name: string) {
  return { type, name }
}

describe('sortMetersByTypeAndName', () => {
  it('groups by type in the order the app declares them', () => {
    const sorted = sortMetersByTypeAndName([
      meter('operating_hours', 'Verdichter'),
      meter('gas', 'Gaszähler'),
      meter('water', 'Wasser Haus'),
      meter('electricity', 'Netzbezug'),
    ])
    expect(sorted.map((m) => m.type)).toEqual(['electricity', 'water', 'gas', 'operating_hours'])
  })

  it('sorts by name inside a type', () => {
    const sorted = sortMetersByTypeAndName([
      meter('electricity', 'Wallbox'),
      meter('electricity', 'Einspeisung'),
      meter('electricity', 'PV-Produktion'),
    ])
    expect(sorted.map((m) => m.name)).toEqual(['Einspeisung', 'PV-Produktion', 'Wallbox'])
  })

  it('reads numbers in a name as numbers', () => {
    const sorted = sortMetersByTypeAndName([
      meter('water', 'Zähler 10'),
      meter('water', 'Zähler 2'),
      meter('water', 'Zähler 1'),
    ])
    expect(sorted.map((m) => m.name)).toEqual(['Zähler 1', 'Zähler 2', 'Zähler 10'])
  })

  it('sorts umlauts next to their base letter, not after Z', () => {
    const sorted = sortMetersByTypeAndName([
      meter('gas', 'Zähler'),
      meter('gas', 'Ölzähler'),
      meter('gas', 'Ofen'),
    ])
    expect(sorted.map((m) => m.name)).toEqual(['Ofen', 'Ölzähler', 'Zähler'])
  })

  it('leaves the given array untouched', () => {
    const input = [meter('gas', 'B'), meter('electricity', 'A')]
    const sorted = sortMetersByTypeAndName(input)
    expect(input.map((m) => m.name)).toEqual(['B', 'A'])
    expect(sorted.map((m) => m.name)).toEqual(['A', 'B'])
  })

  it('puts an unknown type last instead of first', () => {
    const sorted = sortMetersByTypeAndName([
      { type: 'quantum_flux' as MeterType, name: 'Neu' },
      meter('operating_hours', 'Verdichter'),
    ])
    expect(sorted.map((m) => m.name)).toEqual(['Verdichter', 'Neu'])
  })

  it('exposes the comparator for sorting in place', () => {
    expect(compareMetersByTypeAndName(meter('electricity', 'B'), meter('water', 'A'))).toBeLessThan(0)
    expect(compareMetersByTypeAndName(meter('water', 'A'), meter('water', 'A'))).toBe(0)
  })
})
