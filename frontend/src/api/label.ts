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

export type LabelTemplateFontKey = 'small' | 'medium' | 'large'
export type LabelTemplateAlign = 'left' | 'center'

export interface LabelTemplate {
  id: string
  name: string
  text: string
  labelCode: string
  fontKey: LabelTemplateFontKey
  align: LabelTemplateAlign
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
