/**
 * The background queues surfaced on the admin system-status page.
 *
 * Each queue is operated from its own module (photos, documents, finance);
 * this list only says where to look and what a user must hold to get there.
 * Keeping it as data makes the "which tiles does this user see" question
 * testable without a DOM.
 */
export interface QueueOverviewEntry {
  /** Stable key, also used as the list key in the view. */
  id: string
  label: string
  description: string
  icon: string
  /** Route of the module page that can act on this queue. */
  routeName: string
  /**
   * Everything the user must hold to reach that page: the module's own
   * permission (the module is hidden without it) plus the route guard.
   */
  permissions: string[]
}

export const queueOverview: QueueOverviewEntry[] = [
  {
    id: 'photos',
    label: 'Foto-Scan-Queue',
    description:
      'Gesichtserkennung, Embeddings, POI-Erkennung und Vorschaubilder für hochgeladene Fotos.',
    icon: 'pi pi-images',
    routeName: 'fotos-settings-scan-queue',
    permissions: ['photos.view', 'data.manage'],
  },
  {
    id: 'documents',
    label: 'Dokument-Verarbeitung',
    description: 'OCR / Text-Extraktion, KI-Klassifikation und Embedding für Dokumente.',
    icon: 'pi pi-file',
    routeName: 'dokumente-verarbeitung',
    permissions: ['documents.view', 'data.manage'],
  },
  {
    id: 'finance',
    label: 'Finance KI-Tagging',
    description: 'KI-Tag-Vorschläge für neue Buchungen.',
    icon: 'pi pi-tags',
    routeName: 'finance-tag-queue',
    permissions: ['module.finance', 'data.manage'],
  },
]

/** The queues this user may actually navigate to. */
export function visibleQueues(
  hasPermission: (key: string) => boolean,
  entries: QueueOverviewEntry[] = queueOverview,
): QueueOverviewEntry[] {
  return entries.filter((q) => q.permissions.every((p) => hasPermission(p)))
}
