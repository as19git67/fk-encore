import log from 'encore.dev/log'
import { dailyAtUtc, schedule } from '../lib/local-cron'
import { markExpiredSuggestionsIgnored } from './document-match.service'

export async function expirePendingDocumentMatches(): Promise<void> {
  await markExpiredSuggestionsIgnored()
  log.info('finance-document-match-cleanup: expired pending suggestions')
}

schedule({
  name: 'finance-document-match-cleanup',
  description: 'Unbeantwortete Belegvorschläge nach 30 Tagen als ignoriert markieren',
  service: 'finance',
  scheduleLabel: 'daily 05:30 UTC',
  nextFire: dailyAtUtc(5, 30),
  run: () => expirePendingDocumentMatches(),
})
