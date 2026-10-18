/**
 * Labels and badge severities for a document's tax role
 * (documentation/plans/steuer-belegrolle.md): `beleg` is the evidence filed
 * with the return, `bezug` concerns a tax matter but is not the evidence,
 * `keine` has no tax relation.
 */
import type { TaxRole } from '../api/documents'

export const TAX_ROLES: readonly TaxRole[] = ['beleg', 'bezug', 'keine']

export const TAX_ROLE_LABELS: Record<TaxRole, string> = {
  beleg: 'Beleg',
  bezug: 'Bezug',
  keine: 'Kein Steuerbezug',
}

/** The badge the detail page and the help page show. */
export const TAX_ROLE_TAG_LABELS: Record<TaxRole, string> = {
  beleg: 'Steuerrelevant',
  bezug: 'Steuerbezug',
  keine: 'Nicht steuerrelevant',
}

export const TAX_ROLE_SEVERITIES: Record<TaxRole, 'success' | 'warn' | 'secondary'> = {
  beleg: 'success',
  bezug: 'warn',
  keine: 'secondary',
}

export const TAX_ROLE_HINTS: Record<TaxRole, string> = {
  beleg: 'Dieses Dokument ist der Beleg, der für die Steuererklärung eingereicht oder aufbewahrt wird.',
  bezug:
    'Dieses Dokument betrifft einen steuerlichen Sachverhalt, ist aber nicht der Beleg – die Steuer braucht es nicht.',
  keine: 'Dieses Dokument wird nicht für die Steuererklärung benötigt.',
}

/** Options for a three-way choice (edit form, filter, batch dialog). */
export const TAX_ROLE_OPTIONS = TAX_ROLES.map((value) => ({ value, label: TAX_ROLE_LABELS[value] }))

export function isTaxRole(value: unknown): value is TaxRole {
  return typeof value === 'string' && (TAX_ROLES as readonly string[]).includes(value)
}
