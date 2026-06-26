/**
 * IndexedDB-backed queue for transactions created while offline.
 *
 * Flow: photo → on-device OCR → fill form → save offline → drain
 * when connectivity returns.  The receipt blob is stored alongside
 * the transaction data so it can be uploaded once online.
 */

const DB_NAME = 'fk-offline'
const DB_VERSION = 1
const STORE = 'pending-transactions'

export interface PendingTransaction {
  id?: number
  timestamp: number
  accountId: number
  bookingDate: string
  amount: number
  counterparty: string
  purpose?: string
  tags: string[]
  receiptBlob?: ArrayBuffer
  receiptFileName?: string
  receiptMimeType?: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function queuePendingTransaction(
  tx: Omit<PendingTransaction, 'id' | 'timestamp'>,
): Promise<void> {
  const db = await openDb()
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    await idbRequest(store.add({ ...tx, timestamp: Date.now() }))
  } finally {
    db.close()
  }
}

export async function getPendingTransactions(): Promise<PendingTransaction[]> {
  const db = await openDb()
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    return await idbRequest<PendingTransaction[]>(store.getAll())
  } finally {
    db.close()
  }
}

export async function removePendingTransaction(id: number): Promise<void> {
  const db = await openDb()
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
    await idbRequest(store.delete(id))
  } finally {
    db.close()
  }
}

export async function getPendingCount(): Promise<number> {
  const db = await openDb()
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    return await idbRequest<number>(store.count())
  } finally {
    db.close()
  }
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
