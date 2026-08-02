import log from 'encore.dev/log'
import { dailyAtUtc, schedule } from '../lib/local-cron'
import { markExpiredSuggestionsIgnored } from './document-match.service'

export async function expirePendingDocumentMatches(): Promise<void> {
  await markExpiredSuggestionsIgnored()
  log.info('finance-document-match-cleanup: expired pending suggestions')
}

// 11:30 Berlin (CEST) / 09:30 UTC — part of the 10–13 Uhr batch window.
schedule({
  name: 'finance-document-match-cleanup',
  description: 'Unbeantwortete Belegvorschläge nach 30 Tagen als ignoriert markieren',
  service: 'finance',
  scheduleLabel: 'daily 09:30 UTC',
  nextFire: dailyAtUtc(9, 30),
  run: () => expirePendingDocumentMatches(),
})
