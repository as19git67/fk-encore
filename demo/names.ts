/**
 * Every name, address and number the demo household uses
 * (documentation/plans/demodaten.md). All of it is invented and meant to
 * look invented: "Mustermann", "Musterstadt", the bank code 00000000, the
 * domain beispiel.test. Nothing here may ever be taken from real data.
 */

export const DEMO_EMAIL_DOMAIN = "beispiel.test";

/** The second adult of the household, created as a user of its own. */
export const DEMO_SPOUSE = {
  name: "Erika Mustermann",
  email: `erika@${DEMO_EMAIL_DOMAIN}`,
} as const;

/** The adults and the child as subject persons of the admin's household. */
export const DEMO_HOUSEHOLD = {
  self: "Max Mustermann",
  spouse: DEMO_SPOUSE.name,
  child: "Kim Mustermann",
  address: "Beispielstraße 1, 12345 Musterstadt",
} as const;

/** The bank of the demo accounts: a bank code no real bank has. */
export const DEMO_BANK = {
  name: "Demo-Bank eG",
  code: "00000000",
} as const;

/**
 * A German IBAN in the valid layout (country, check digits, 8-digit bank
 * code, 10-digit account number) with the bank code 00000000, which no
 * bank carries. The check digits are computed, so validators that only
 * check the checksum accept it.
 */
export function demoIban(accountNumber: string): string {
  const account = accountNumber.padStart(10, "0").slice(-10);
  const bban = `${DEMO_BANK.code}${account}`;
  // ISO 7064 mod 97-10 over BBAN + "DE00", letters as two digits (D=13, E=14).
  const numeric = `${bban}131400`;
  let rest = 0;
  for (const digit of numeric) rest = (rest * 10 + Number(digit)) % 97;
  const check = String(98 - rest).padStart(2, "0");
  return `DE${check}${bban}`;
}

/** Counterparties of the household's bookings: invented firms with obviously synthetic names. */
export const DEMO_COUNTERPARTIES = {
  employerSelf: "Musterwerke GmbH",
  employerSpouse: "Beispiel Pflegedienst gGmbH",
  landlord: "Muster Wohnbau GmbH",
  utilities: "Stadtwerke Musterstadt",
  insurer: "Beispiel-Versicherung AG",
  familyFund: "Familienkasse Musterstadt",
  phone: "Beispielfunk GmbH",
  groceries: ["Beispielmarkt", "Muster Frische", "Demo Discount", "Bäckerei Beispiel"],
  pharmacy: "Muster-Apotheke",
  fuel: "Tankstelle Musterweg",
  online: "Beispiel Versand GmbH",
} as const;
