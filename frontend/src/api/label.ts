import { apiFetch } from './client'

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

export interface PrintLabelRequest {
  text: string
  copies?: number
  printer?: string
}

export function printLabel(req: PrintLabelRequest) {
  return apiFetch<{ printed: number; printer: string }>('/label/print', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}
