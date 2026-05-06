/**
 * Utility to parse SEPA fields (EREF, MREF, CRED) from transaction purpose text.
 * Banks often pack these into the purpose string instead of providing them
 * in structured SEPA fields.
 *
 * Examples:
 * "EREF+12345 MREF+67890 CRED+DE12ZZZ00000000001"
 * "Kauf 123 EREF+XY-123"
 */

export interface SepaFields {
  endToEndRef: string | null;
  mandateRef: string | null;
  creditorId: string | null;
  originatorName: string | null;
  recipientName: string | null;
  iban: string | null;
  bic: string | null;
  bankId: string | null;
  customerRef: string | null;
  reference: string | null;
  purposeText: string | null;
}

/**
 * Parses purpose text for SEPA tags. Tags are usually:
 *   EREF+ : End-to-End Reference
 *   KREF+ : Customer Reference
 *   MREF+ : Mandate Reference
 *   CRED+ : Creditor Identifier (or CI+)
 *   ABWA+ : Alternative Payer (Originator)
 *   ABWE+ : Alternative Payee (Recipient)
 *   IBAN+ : IBAN
 *   BIC+  : BIC
 *   BLZ+  : Bank ID
 *   RREF+ : Reference
 *   SVWZ+ : Purpose (SEPA Verwendungszweck)
 *
 * Tags end at the next tag (e.g. "TAG+") or the end of the string.
 * They often have a space before the next tag.
 */
export function parseSepaFields(purpose: string | null | undefined): SepaFields {
  const result: SepaFields = {
    endToEndRef: null,
    mandateRef: null,
    creditorId: null,
    originatorName: null,
    recipientName: null,
    iban: null,
    bic: null,
    bankId: null,
    customerRef: null,
    reference: null,
    purposeText: null,
  };

  if (!purpose) {
    return result;
  }

  // We use simpler regex first as it's more reliable for single-word values
  // then improve if we see more complex patterns.
  
  const erefMatch = purpose.match(/EREF\+([^\s]+)/i);
  if (erefMatch) result.endToEndRef = erefMatch[1];

  const krefMatch = purpose.match(/KREF\+([^\s]+)/i);
  if (krefMatch) result.customerRef = krefMatch[1];

  const mrefMatch = purpose.match(/MREF\+([^\s]+)/i);
  if (mrefMatch) result.mandateRef = mrefMatch[1];

  const credMatch = purpose.match(/(?:CRED|CI)\+([^\s]+)/i);
  if (credMatch) result.creditorId = credMatch[1];

  const abwaMatch = purpose.match(/ABWA\+([^\s]+)/i);
  if (abwaMatch) result.originatorName = abwaMatch[1];

  const abweMatch = purpose.match(/ABWE\+([^\s]+)/i);
  if (abweMatch) result.recipientName = abweMatch[1];

  const ibanMatch = purpose.match(/IBAN\+([^\s]+)/i);
  if (ibanMatch) result.iban = ibanMatch[1];

  const bicMatch = purpose.match(/BIC\+([^\s]+)/i);
  if (bicMatch) result.bic = bicMatch[1];

  const blzMatch = purpose.match(/BLZ\+([^\s]+)/i);
  if (blzMatch) result.bankId = blzMatch[1];

  const rrefMatch = purpose.match(/RREF\+([^\s]+)/i);
  if (rrefMatch) result.reference = rrefMatch[1];

  const svwzMatch = purpose.match(/SVWZ\+([^\s]+)/i);
  if (svwzMatch) result.purposeText = svwzMatch[1];

  // Support for human-readable labels (e.g. CORE / Mandatsref.: \n MS... )
  if (!result.mandateRef) {
    const mrefLabelMatch = purpose.match(/Mandatsref\.:\s*([^\s\r\n]+)/i);
    if (mrefLabelMatch) result.mandateRef = mrefLabelMatch[1];
  }

  if (!result.creditorId) {
    const credLabelMatch = purpose.match(/Gläubiger-ID:\s*([^\s\r\n]+)/i);
    if (credLabelMatch) result.creditorId = credLabelMatch[1];
  }

  if (!result.endToEndRef) {
    const erefLabelMatch = purpose.match(/End-to-End-Ref\.:\s*([^\s\r\n]+)/i);
    // Ignore "nicht angegeben"
    if (erefLabelMatch && !erefLabelMatch[1].toLowerCase().startsWith("nicht")) {
      result.endToEndRef = erefLabelMatch[1];
    }
  }

  return result;
}
