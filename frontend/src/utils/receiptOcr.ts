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
 * Detect receipt boundaries via Sobel edge projection and return
 * the crop rectangle, or null if cropping wouldn't help.
 *
 * Works by computing gradient magnitude, projecting onto rows and
 * columns, then finding the region where edge density exceeds a
 * threshold. Pure canvas — no OpenCV needed.
 */
export function detectDocumentBounds(
  width: number,
  height: number,
  pixelData: Uint8ClampedArray,
): { x: number; y: number; w: number; h: number } | null {
  if (width < 100 || height < 100) return null

  const gray = new Uint8Array(width * height)
  for (let i = 0; i < gray.length; i++) {
    const j = i * 4
    gray[i] = Math.round(pixelData[j]! * 0.299 + pixelData[j + 1]! * 0.587 + pixelData[j + 2]! * 0.114)
  }

  const rowProj = new Float64Array(height)
  const colProj = new Float64Array(width)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const tl = gray[(y - 1) * width + (x - 1)]!
      const tr = gray[(y - 1) * width + (x + 1)]!
      const ml = gray[y * width + (x - 1)]!
      const mr = gray[y * width + (x + 1)]!
      const bl = gray[(y + 1) * width + (x - 1)]!
      const bc = gray[(y + 1) * width + x]!
      const br = gray[(y + 1) * width + (x + 1)]!
      const tc = gray[(y - 1) * width + x]!
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br
      const mag = Math.sqrt(gx * gx + gy * gy)
      rowProj[y]! += mag
      colProj[x]! += mag
    }
  }

  for (let y = 0; y < height; y++) rowProj[y]! /= width
  for (let x = 0; x < width; x++) colProj[x]! /= height

  let rowMax = 0
  let colMax = 0
  for (let y = 0; y < height; y++) if (rowProj[y]! > rowMax) rowMax = rowProj[y]!
  for (let x = 0; x < width; x++) if (colProj[x]! > colMax) colMax = colProj[x]!
  if (rowMax === 0 || colMax === 0) return null

  const rowThresh = rowMax * 0.12
  const colThresh = colMax * 0.12
  let top = 0, bottom = height - 1, left = 0, right = width - 1
  while (top < height && rowProj[top]! < rowThresh) top++
  while (bottom > top && rowProj[bottom]! < rowThresh) bottom--
  while (left < width && colProj[left]! < colThresh) left++
  while (right > left && colProj[right]! < colThresh) right--

  const margin = Math.round(Math.min(width, height) * 0.01)
  top = Math.max(0, top - margin)
  bottom = Math.min(height - 1, bottom + margin)
  left = Math.max(0, left - margin)
  right = Math.min(width - 1, right + margin)

  const cropW = right - left + 1
  const cropH = bottom - top + 1

  if (cropW < width * 0.4 || cropH < height * 0.4) return null
  if (cropW >= width * 0.95 && cropH >= height * 0.95) return null

  return { x: left, y: top, w: cropW, h: cropH }
}

/**
 * Preprocess the image on a Canvas for better OCR results:
 * auto-crop → grayscale → Otsu binarization.
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

  // Auto-crop: detect receipt edges and remove background
  const rawData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const bounds = detectDocumentBounds(canvas.width, canvas.height, rawData.data)
  if (bounds) {
    const cropped = ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h)
    canvas.width = bounds.w
    canvas.height = bounds.h
    ctx.putImageData(cropped, 0, 0)
  }

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
