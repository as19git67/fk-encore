import { API_BASE_URL, apiFetch } from './client'

export interface LabelPrinter {
  name: string
  info: string | null
  location: string | null
  state: number | null
  stateLabel: string
  makeAndModel: string | null
}

export interface ListPrintersResponse {
  printers: LabelPrinter[]
  selected: string | null
  cupsError: string | null
}

export function listLabelPrinters() {
  return apiFetch<ListPrintersResponse>('/label/printers')
}

export function saveLabelPrinter(printer: string) {
  return apiFetch<{ selected: string }>('/label/printer', {
    method: 'PUT',
    body: JSON.stringify({ printer }),
  })
}

export type LabelTemplateFontKey = 'small' | 'medium' | 'large'
export type LabelTemplateAlign = 'left' | 'center'

export interface LabelTemplate {
  id: string
  name: string
  text: string
  labelCode: string
  fontKey: LabelTemplateFontKey
  align: LabelTemplateAlign
  bold: boolean
}

export interface LabelTemplatesResponse {
  templates: LabelTemplate[]
  lastTemplateId: string | null
}

export function listLabelTemplates() {
  return apiFetch<LabelTemplatesResponse>('/label/templates')
}

export function saveLabelTemplates(
  templates: LabelTemplate[],
  lastTemplateId: string | null,
) {
  return apiFetch<LabelTemplatesResponse>('/label/templates', {
    method: 'PUT',
    body: JSON.stringify({ templates, lastTemplateId }),
  })
}

export interface PrintLabelRequest {
  /** The label rendered to a PNG image, base64-encoded (no data: prefix). */
  imageBase64: string
  copies?: number
  printer?: string
}

export function printLabel(req: PrintLabelRequest) {
  return apiFetch<{ printed: number; printer: string }>('/label/print', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

// ---------- Scanner labels (A4 sheet "#0001" …) ----------

export interface ScannerSheet {
  id: number
  firstNumber: number
  lastNumber: number
  /** "#0001 – #0189", as printed. */
  range: string
  pages: number
  labels: number
  createdAt: string
}

export interface ScannerSettings {
  nextNumber: number
  offsetXMm: number
  offsetYMm: number
}

export interface ScannerOverview extends ScannerSettings {
  sheet: { name: string; columns: number; rows: number; labelsPerPage: number; maxPages: number }
  sheets: ScannerSheet[]
}

export function getScannerOverview() {
  return apiFetch<ScannerOverview>('/label/scanner')
}

export function saveScannerSettings(settings: Partial<ScannerSettings>) {
  return apiFetch<ScannerSettings>('/label/scanner/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  })
}

export function createScannerSheet(pages: number) {
  return apiFetch<{ sheet: ScannerSheet; nextNumber: number }>('/label/scanner/sheets', {
    method: 'POST',
    body: JSON.stringify({ pages }),
  })
}

export function deleteScannerSheet(id: number) {
  return apiFetch<{ deleted: boolean }>(`/label/scanner/sheets/${id}`, { method: 'DELETE' })
}

export const scannerSheetPdfPath = (id: number) => `/label/scanner/sheets/${id}/pdf`
export const SCANNER_TEST_PDF_PATH = '/label/scanner/test-pdf'

// ---------- Binder labels (A4 sheet, four spine labels of 192 × 61 mm) ----------

export type BinderDirection = 'across' | 'along'
export type BinderAlign = 'left' | 'center'

export interface BinderPageSummary {
  id: number
  name: string
  /** The first line of text on the page, without Markdown. */
  excerpt: string
  updatedAt: string
}

export interface BinderPageInput {
  name: string
  /** Markdown per label, top to bottom; always four. */
  labels: string[]
  direction: BinderDirection
  align: BinderAlign
}

export interface BinderPage extends BinderPageInput {
  id: number
  createdAt: string
  updatedAt: string
}

export function listBinderPages() {
  return apiFetch<{ pages: BinderPageSummary[] }>('/label/binder/pages')
}

export function getBinderPage(id: number) {
  return apiFetch<BinderPage>(`/label/binder/pages/${id}`)
}

export function createBinderPage(page: BinderPageInput) {
  return apiFetch<BinderPage>('/label/binder/pages', { method: 'POST', body: JSON.stringify(page) })
}

export function updateBinderPage(id: number, page: BinderPageInput) {
  return apiFetch<BinderPage>(`/label/binder/pages/${id}`, { method: 'PUT', body: JSON.stringify(page) })
}

export function deleteBinderPage(id: number) {
  return apiFetch<{ deleted: boolean }>(`/label/binder/pages/${id}`, { method: 'DELETE' })
}

/**
 * Renders the page as it stands, saved or not, and hands the PDF to the
 * browser as a download. `outlines` draws the label edges for a test print.
 */
export async function downloadBinderPdf(page: Partial<BinderPageInput> & { labels: string[]; outlines?: boolean }) {
  const token = localStorage.getItem('auth_token')
  const resp = await fetch(`${API_BASE_URL}/label/binder/pdf`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(page),
    cache: 'no-store',
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(text || `PDF fehlgeschlagen (${resp.status})`)
  }
  const blob = await resp.blob()
  const disposition = resp.headers.get('Content-Disposition') ?? ''
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
  const plain = /filename="([^"]+)"/.exec(disposition)?.[1]
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = encoded ? decodeURIComponent(encoded) : plain ?? 'Ordneretiketten.pdf'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
