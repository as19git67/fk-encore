/**
 * On-device receipt OCR: image preprocessing + tesseract.js.
 *
 * Runs entirely in the browser — no server round-trip for text
 * extraction. The heavier server-side OCR + LLM classification runs
 * asynchronously in the background to enrich the transaction later.
 */

import { createWorker, type Worker } from 'tesseract.js'
import { extractReceiptAmount, extractReceiptDate } from './receiptExtract'

export interface ReceiptOcrResult {
  text: string
  amount: number | null
  date: string | null
  processedImage: Blob
}

let workerPromise: Promise<Worker> | null = null

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('deu', 1, {
      legacyCore: false,
      legacyLang: false,
    }).catch((err) => {
      workerPromise = null
      throw err
    })
  }
  return workerPromise
}

/**
 * Preprocess the image on a Canvas for better OCR results:
 * grayscale → contrast boost → adaptive-ish binarization (Otsu
 * approximation via high-contrast + threshold).
 *
 * Returns a JPEG blob of the processed image (also used for upload
 * so the server stores the cleaned version).
 */
export async function preprocessReceiptImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = imageData

  // Grayscale + collect histogram for Otsu threshold
  const histogram = new Uint32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114)
    data[i] = gray
    data[i + 1] = gray
    data[i + 2] = gray
    histogram[gray]!++
  }

  // Otsu's threshold
  const totalPixels = canvas.width * canvas.height
  let sumTotal = 0
  for (let i = 0; i < 256; i++) sumTotal += i * histogram[i]!

  let sumBg = 0
  let weightBg = 0
  let maxVariance = 0
  let threshold = 128

  for (let t = 0; t < 256; t++) {
    weightBg += histogram[t]!
    if (weightBg === 0) continue
    const weightFg = totalPixels - weightBg
    if (weightFg === 0) break
    sumBg += t * histogram[t]!
    const meanBg = sumBg / weightBg
    const meanFg = (sumTotal - sumBg) / weightFg
    const variance = weightBg * weightFg * (meanBg - meanFg) ** 2
    if (variance > maxVariance) {
      maxVariance = variance
      threshold = t
    }
  }

  // Apply binarization
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i]! >= threshold ? 255 : 0
    data[i] = v
    data[i + 1] = v
    data[i + 2] = v
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
}

/**
 * Run on-device OCR on a receipt image.
 *
 * 1. Preprocess for contrast/binarization
 * 2. Recognize text via tesseract.js (deu)
 * 3. Extract amount + date via regex
 *
 * Returns the recognized fields plus the preprocessed image blob
 * (for upload to the server).
 */
export async function recognizeReceipt(file: File): Promise<ReceiptOcrResult> {
  const processedImage = await preprocessReceiptImage(file)
  const worker = await getWorker()
  const { data } = await worker.recognize(processedImage)
  const text = data.text ?? ''
  return {
    text,
    amount: extractReceiptAmount(text),
    date: extractReceiptDate(text),
    processedImage,
  }
}
