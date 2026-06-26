/**
 * Composable that drains the offline transaction queue when
 * connectivity is restored.  Mount it once at the app/module level
 * so pending items are replayed automatically.
 */

import { onMounted, onUnmounted, ref } from 'vue'
import {
  getPendingTransactions,
  getPendingCount,
  removePendingTransaction,
  type PendingTransaction,
} from '../utils/offlineQueue'
import { uploadReceiptCapture } from '../api/documents'
import { createTransaction } from '../api/finance'

export function useOfflineSync() {
  const pendingCount = ref(0)
  const draining = ref(false)
  const lastResult = ref<{ success: number; failed: number } | null>(null)

  async function refreshCount() {
    try {
      pendingCount.value = await getPendingCount()
    } catch {
      pendingCount.value = 0
    }
  }

  async function drainQueue(): Promise<void> {
    if (draining.value || !navigator.onLine) return
    const items = await getPendingTransactions()
    if (items.length === 0) return

    draining.value = true
    let success = 0
    let failed = 0

    for (const item of items) {
      try {
        await replayTransaction(item)
        await removePendingTransaction(item.id!)
        success++
      } catch {
        failed++
      }
    }

    draining.value = false
    lastResult.value = { success, failed }
    await refreshCount()
  }

  async function replayTransaction(item: PendingTransaction): Promise<void> {
    let receiptDocumentId: number | undefined

    if (item.receiptBlob) {
      const file = new File(
        [item.receiptBlob],
        item.receiptFileName || 'receipt.jpg',
        { type: item.receiptMimeType || 'image/jpeg' },
      )
      const uploaded = await uploadReceiptCapture(file)
      receiptDocumentId = uploaded.id
    }

    await createTransaction({
      account_id: item.accountId,
      booking_date: item.bookingDate,
      amount: item.amount,
      counterparty: item.counterparty,
      purpose: item.purpose,
      tags: item.tags,
      receipt_document_id: receiptDocumentId,
    })
  }

  function onOnline() {
    void drainQueue()
  }

  onMounted(() => {
    window.addEventListener('online', onOnline)
    void refreshCount()
    if (navigator.onLine) void drainQueue()
  })

  onUnmounted(() => {
    window.removeEventListener('online', onOnline)
  })

  return { pendingCount, draining, lastResult, drainQueue }
}
