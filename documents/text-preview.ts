export const DOCUMENT_TEXT_PREVIEW_LENGTH = 420;

export function documentTextPreview(
  value: string | null | undefined,
  maxLength = DOCUMENT_TEXT_PREVIEW_LENGTH,
): string | null {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trim()}…`;
}
