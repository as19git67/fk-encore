import type { InjectionKey } from 'vue'
import { useReferenceData } from '../composables/useReferenceData'
import { getActivePinia } from 'pinia'
import { useTagsStore } from '../stores/finance/tags'

/**
 * What a confirmed assistant card changed in the app's own caches. The
 * action ran on the server, but lists the app keeps for the whole session
 * (albums, persons, finance tags) still held the old state: an album the
 * assistant created showed only after a browser refresh. After every
 * executed card the caches it may have touched are dropped, so the next
 * page that reads them loads afresh. Cheap enough to do for any card:
 * an invalidated cache costs one request on the next visit.
 */
export function refreshAfterProposal(tool: string): void {
  const { invalidateAlbums, invalidatePersons } = useReferenceData()
  // Albums: create_album, add_photos_to_album, a collage filed in an album,
  // a photo book; any other card leaves the list as it was, but one request
  // is cheaper than a list that lies.
  invalidateAlbums()
  if (tool.includes('photo') || tool.includes('album') || tool.includes('collage')) invalidatePersons()
  if (tool.includes('transaction') && getActivePinia()) {
    const tags = useTagsStore()
    if (tags.items.length) void tags.refresh().catch(() => { /* the list page loads them again */ })
  }
}

/**
 * Lets a card ask the open conversation to go on once it ran: the rest of
 * the question that needed its result. Provided by the assistant page; a
 * card shown elsewhere (Storybook, a test) has none and does nothing.
 */
export const CONTINUE_AFTER_PROPOSAL: InjectionKey<(message: string) => void> = Symbol('continueAfterProposal')

/** The question the app asks for the assistant once a card ran. */
export function continuationQuestion(summary: string, continuation: string): string {
  return `Die Karte ist ausgeführt: ${summary.replace(/[.\s]+$/, '')}. Mach jetzt weiter: ${continuation}`
}
