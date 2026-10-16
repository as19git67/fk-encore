/**
 * A stand-in for `~encore/clients` in the assistant's tests: one vi.fn per
 * endpoint the tools call, so a test can script a service's answer and check
 * the arguments it got. Used as `vi.mock("~encore/clients", ...)`.
 */

import { vi } from "vitest";

export const clients = {
  finance: {
    listAccounts: vi.fn(),
    listTransactions: vi.fn(),
    query: vi.fn(),
    listUpcomingDebits: vi.fn(),
    batchTag: vi.fn(),
    previewGroupedReport: vi.fn(),
    createGroupedReport: vi.fn(),
    getTransaction: vi.fn(),
  },
  documents: {
    listDocumentCategories: vi.fn(),
    searchDocumentsEndpoint: vi.fn(),
    getDocument: vi.fn(),
    setDocumentFollowUp: vi.fn(),
    findDocumentTextBoxes: vi.fn(),
    createCollection: vi.fn(),
    updateCollectionItem: vi.fn(),
    startCollectionExport: vi.fn(),
    getCollection: vi.fn(),
    getDocumentText: vi.fn(),
    getDocumentReceiptSuggestion: vi.fn(),
    storeGeneratedDocument: vi.fn(),
  },
  photo: {
    listPhotos: vi.fn(),
    getPhotoDetailsBatch: vi.fn(),
    searchPhotosNatural: vi.fn(),
    listRecaps: vi.fn(),
    listAlbums: vi.fn(),
    listPersons: vi.fn(),
    createAlbum: vi.fn(),
    batchUpdateAlbumPhotos: vi.fn(),
    updatePhotoCuration: vi.fn(),
  },
  meter: {
    listMeters: vi.fn(),
    listReadings: vi.fn(),
    getMeterReport: vi.fn(),
  },
  aiqueue: {
    acquireSlot: vi.fn(async () => ({ slotId: 1, status: "active", position: 0 })),
    pollSlot: vi.fn(async () => ({ status: "active", position: 0 })),
    releaseSlot: vi.fn(async () => {}),
    cancelSlot: vi.fn(async () => {}),
  },
  realtime: { publishEvent: vi.fn(async () => {}) },
  user: { getLlmStatus: vi.fn() },
};

/** Forget scripted answers and recorded calls of the service endpoints. */
export function resetClients(): void {
  for (const service of [clients.finance, clients.documents, clients.photo, clients.meter]) {
    for (const fn of Object.values(service)) fn.mockReset();
  }
}

/** Every service endpoint call, as `service.endpoint`, in order. */
export function calledEndpoints(): string[] {
  const calls: Array<{ name: string; order: number }> = [];
  for (const [service, endpoints] of Object.entries({
    finance: clients.finance, documents: clients.documents, photo: clients.photo, meter: clients.meter,
  })) {
    for (const [name, fn] of Object.entries(endpoints)) {
      fn.mock.invocationCallOrder.forEach((order) => calls.push({ name: `${service}.${name}`, order }));
    }
  }
  return calls.sort((a, b) => a.order - b.order).map((c) => c.name);
}
