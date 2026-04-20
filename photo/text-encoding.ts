/**
 * Repair UTF-8-as-Latin-1 mojibake in a string.
 *
 * Two known paths currently surface corrupted strings into recap titles:
 *  - IPTC location fields read by exifr without a `CodedCharacterSet`
 *    marker get decoded as Latin-1 / Windows-1252 even when the file
 *    actually stored UTF-8 bytes. Result: "Brüssel" → "BrÃ¼ssel".
 *  - llama-cpp-python with JSON-grammar-constrained generation can split
 *    tokens at multi-byte UTF-8 boundaries, producing the same pattern.
 *
 * The fix is a round-trip: take the string, encode it as Latin-1, and
 * decode the resulting bytes as UTF-8. If the result is valid UTF-8
 * that looks meaningfully different (no replacement chars, at least one
 * non-ASCII char introduced/changed), return it. Otherwise return the
 * input unchanged — i.e. the function is a no-op on already-clean text.
 */
export function repairMojibake(input: string): string;
export function repairMojibake(input: string | null): string | null;
export function repairMojibake(input: string | null | undefined): string | null | undefined;
export function repairMojibake(
  input: string | null | undefined,
): string | null | undefined {
  if (input == null || input === "") return input;
  // Only strings that contain a Latin-1 "Ã" (0xC3) followed by another
  // high-bit character can be UTF-8-as-Latin-1 mojibake. Cheap early-out.
  if (!/[\u00c2-\u00c3][\u0080-\u00bf]/.test(input)) return input;
  try {
    const bytes = Buffer.from(input, "latin1");
    const repaired = bytes.toString("utf8");
    if (repaired.includes("\uFFFD")) return input;
    return repaired;
  } catch {
    return input;
  }
}
