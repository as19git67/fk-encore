/**
 * Shared vocabulary and helpers of the retirement forecast (issue #1337).
 *
 * The numbers come from the backend engine (finance/forecast-engine.ts);
 * this file only names things and converts between nominal and today's
 * purchasing power for display.
 */

import type {
  ForecastItemType,
  ForecastMilestone,
  ForecastMilestoneKind,
  ForecastPerson,
  ForecastPot,
  ForecastScenarioConfig,
  ForecastTimeRef,
  ForecastYearRow,
} from '../../../api/finance'

export const MILESTONE_KIND_LABELS: Record<ForecastMilestoneKind, string> = {
  leave_work: 'Ausstieg aus dem Beruf',
  statutory_pension: 'Gesetzliche Rente',
  company_pension: 'Betriebsrente',
  private_pension: 'Private Rente',
  life_insurance_maturity: 'Ablauf Lebensversicherung',
  custom: 'Eigener Zeitpunkt',
}

export const ITEM_TYPE_LABELS: Record<ForecastItemType, string> = {
  salary: 'Gehalt (netto)',
  income: 'Sonstige Einnahme',
  expense: 'Ausgabe',
  living_expense: 'Lebenshaltung',
  health_insurance: 'Krankenversicherung',
  asset: 'Vermögen / Anlage',
  life_insurance: 'Kapitallebensversicherung',
  pension: 'Rente / Pension',
}

/** Item types that belong to a person; the others may be household items. */
export const PERSONAL_ITEM_TYPES: ReadonlySet<ForecastItemType> = new Set([
  'salary',
  'health_insurance',
  'life_insurance',
  'pension',
])

export const ITEM_GROUPS: Array<{ label: string; types: ForecastItemType[] }> = [
  { label: 'Einnahmen', types: ['salary', 'income'] },
  { label: 'Renten und Versicherungen', types: ['pension', 'life_insurance'] },
  { label: 'Vermögen', types: ['asset'] },
  { label: 'Ausgaben', types: ['living_expense', 'health_insurance', 'expense'] },
]

export const POT_LABELS: Record<ForecastPot, string> = {
  cash: 'Tagesgeld / Konto',
  depot: 'Depot',
  real_estate: 'Immobilien',
  other: 'Sonstiges',
  insurance: 'Versicherungen',
}

export const HI_MODE_LABELS = {
  employed: 'Angestellt (Arbeitnehmeranteil)',
  statutory_voluntary: 'Freiwillig gesetzlich',
  family: 'Familienversichert',
  kvdr: 'Krankenversicherung der Rentner (KVdR)',
  private: 'Privat',
} as const

export type HiMode = keyof typeof HI_MODE_LABELS

export const PENSION_KIND_LABELS = {
  statutory: 'Gesetzliche Rente',
  company: 'Betriebsrente / bAV',
  private: 'Private Rentenversicherung',
} as const

export const FREQUENCY_LABELS = {
  monthly: 'monatlich',
  yearly: 'jährlich',
  once: 'einmalig',
} as const

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
const eurCents = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })

export function formatEur(value: number | null | undefined, cents = false): string {
  if (value == null || !Number.isFinite(value)) return '–'
  return (cents ? eurCents : eur).format(value)
}

/** 0.025 → "2,5 %" */
export function formatPct(rate: number): string {
  return `${(rate * 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })} %`
}

/** Nominal → today's purchasing power. */
export function deflate(value: number, year: number, startYear: number, inflationRate: number): number {
  return value / Math.pow(1 + inflationRate, year - startYear)
}

/** A value of a year row, deflated when `real` is set. */
export function displayValue(
  value: number,
  row: ForecastYearRow,
  startYear: number,
  inflationRate: number,
  real: boolean,
): number {
  return real ? deflate(value, row.year, startYear, inflationRate) : value
}

export function ageInYear(person: ForecastPerson, year: number): number {
  return year - Number(person.birthDate.slice(0, 4))
}

export function currentAge(person: ForecastPerson): number {
  return ageInYear(person, new Date().getFullYear())
}

/** Milestone as the current scenario sees it (override wins). */
export function effectiveMilestone(
  m: ForecastMilestone,
  config: ForecastScenarioConfig,
): { date: string | null; age: number | null } {
  const o = config.milestoneOverrides[String(m.id)]
  if (!o) return { date: m.date, age: m.age }
  if (o.age != null) return { date: null, age: o.age }
  if (o.date) return { date: o.date, age: null }
  return { date: m.date, age: m.age }
}

export function describeWhen(when: { date: string | null; age: number | null }): string {
  if (when.age != null) return `mit ${when.age}`
  if (when.date) return `am ${when.date.slice(8, 10)}.${when.date.slice(5, 7)}.${when.date.slice(0, 4)}`
  return '–'
}

export function describeTimeRef(
  ref: ForecastTimeRef | null | undefined,
  milestones: ForecastMilestone[],
  persons: ForecastPerson[],
  fallback: string,
): string {
  if (!ref) return fallback
  switch (ref.kind) {
    case 'milestone': {
      const m = milestones.find((x) => x.id === ref.milestoneId)
      if (!m) return 'Zeitpunkt fehlt'
      const p = persons.find((x) => x.id === m.personId)
      return persons.length > 1 && p ? `${m.label} (${p.label})` : m.label
    }
    case 'date':
      return describeWhen({ date: ref.date, age: null })
    case 'age': {
      const p = persons.find((x) => x.id === ref.personId)
      return `${p ? p.label + ' ' : ''}mit ${ref.age}`
    }
  }
}

/** Reads a theme token, with a fallback for tests and thumbnails. */
export function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** One colour per pot, from the theme's primitive tokens. */
export function potColors(): Record<ForecastPot, string> {
  return {
    cash: cssVar('--p-sky-400', '#38bdf8'),
    depot: cssVar('--p-indigo-500', '#6366f1'),
    other: cssVar('--p-teal-500', '#14b8a6'),
    real_estate: cssVar('--p-amber-500', '#f59e0b'),
    insurance: cssVar('--p-purple-400', '#c084fc'),
  }
}

/** A stable colour for the n-th source of a cash-flow chart. */
export function seriesColor(index: number): string {
  const names = [
    '--p-sky-500',
    '--p-emerald-500',
    '--p-violet-500',
    '--p-amber-500',
    '--p-rose-500',
    '--p-teal-500',
    '--p-indigo-400',
    '--p-lime-500',
    '--p-orange-500',
    '--p-cyan-600',
  ]
  const fallbacks = ['#0ea5e9', '#10b981', '#8b5cf6', '#f59e0b', '#f43f5e', '#14b8a6', '#818cf8', '#84cc16', '#f97316', '#0891b2']
  const i = index % names.length
  return cssVar(names[i] ?? '--p-primary-color', fallbacks[i] ?? '#3b82f6')
}

/** "#rrggbb" → "rgba(r,g,b,a)" so an area can sit under a line. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m?.[1]) return color
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Sensible starting data for a new item of a type. */
export function defaultItemData(type: ForecastItemType): Record<string, unknown> {
  switch (type) {
    case 'salary':
      return { amount: 3000, growthRate: 0.02 }
    case 'income':
      return { amount: 0, frequency: 'monthly', growthRate: 0, taxRate: 0 }
    case 'expense':
      return { amount: 0, frequency: 'monthly', growthRate: null }
    case 'living_expense':
      return { amount: 2500 }
    case 'health_insurance':
      return {
        employedAmount: 450,
        bridgeMode: 'statutory_voluntary',
        bridgeAmount: 0,
        retiredMode: 'kvdr',
        retiredAmount: 0,
        privateGrowthRate: 0.03,
      }
    case 'asset':
      return { pot: 'cash', currentValue: 0, returnRate: null, monthlyContribution: 0, contributionEnd: null }
    case 'life_insurance':
      return {
        surrenderValue: 0,
        monthlyPremium: 0,
        premiumEnd: null,
        guaranteedPayout: 0,
        projectedPayout: 0,
        maturity: null,
        payoutMode: 'lump_sum',
        annuityAmount: 0,
        taxRate: 0,
      }
    case 'pension':
      return {
        kind: 'statutory',
        monthlyAmount: 0,
        start: null,
        regularAge: 67,
        deductionPerMonth: 0.003,
        deductionOffsetCost: null,
        growthRate: 0.02,
        monthlyContribution: 0,
        contributionEnd: null,
        lumpSumOption: null,
        payoutMode: 'annuity',
        taxRate: 0,
      }
  }
}

/** One line that says what an item is worth, for the list. */
export function summarizeItem(type: ForecastItemType, data: Record<string, unknown>, linkedBalance: number | null): string {
  const n = (k: string) => (typeof data[k] === 'number' ? (data[k] as number) : 0)
  switch (type) {
    case 'salary':
      return `${formatEur(n('amount'))} / Monat`
    case 'income':
    case 'expense':
      return `${formatEur(n('amount'))} ${FREQUENCY_LABELS[(data.frequency as keyof typeof FREQUENCY_LABELS) ?? 'monthly']}`
    case 'living_expense':
      return `${formatEur(n('amount'))} / Monat`
    case 'health_insurance':
      return `${formatEur(n('employedAmount'))} / Monat, danach ${HI_MODE_LABELS[(data.bridgeMode as HiMode) ?? 'statutory_voluntary']}`
    case 'asset':
      return `${formatEur(linkedBalance ?? n('currentValue'))}${linkedBalance != null ? ' (aus Konto)' : ''}`
    case 'life_insurance':
      return `Rückkauf ${formatEur(n('surrenderValue'))}, Ablauf ${formatEur(n('projectedPayout'))}`
    case 'pension':
      return `${formatEur(n('monthlyAmount'))} / Monat`
  }
}
