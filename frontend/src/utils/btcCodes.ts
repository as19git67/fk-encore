/**
 * ISO BTC code lookup for the frontend — German descriptions only.
 * Data sourced from finance/iso-btc-codes.ts; kept in sync manually.
 */

const DOMAINS_DE: Record<string, string> = {
  ACMT: "Kontoverwaltung",
  CAMT: "Cash Management",
  CMDT: "Rohstoffe",
  DERV: "Derivate",
  FORX: "Devisen",
  LDAS: "Kredite, Einlagen & Syndizierungen",
  PMET: "Edelmetalle",
  PMNT: "Zahlungsverkehr",
  SECU: "Wertpapiere",
  TRAD: "Handelsfinanzierung",
  XTND: "Sonstige",
};

const FAMILIES_DE: Record<string, string> = {
  ACOP: "Sonstige Gutschriftsoperationen",
  ADOP: "Sonstige Belastungsoperationen",
  BLOC: "Gesperrte Transaktionen",
  CAPL: "Cash Pooling",
  CCRD: "Kundenkartentransaktionen",
  CNTR: "Kassenzähler / Kassentransaktionen",
  CORP: "Kapitalmaßnahme",
  CSLN: "Verbraucherkredite",
  CUST: "Depotführung",
  DRFT: "Wechsel",
  FTDP: "Termingeldeinlagen",
  FTLN: "Terminkredite",
  FTUR: "Futures",
  FWRD: "Devisentermingeschäfte",
  GUAR: "Garantien / Aval",
  ICCN: "Ausgehende Konzentrationsaufträge",
  ICDT: "Ausgehende Überweisungen",
  ICHQ: "Ausgestellte Schecks",
  IDDT: "Ausgehende Lastschriften",
  IRCT: "Ausgehende Echtzeitüberweisungen",
  MCOP: "Sonstige Gutschriftsvorgänge",
  MCRD: "Händlerkartentransaktionen",
  MDOP: "Sonstige Belastungsvorgänge",
  NTAV: "Nicht verfügbar",
  OPCL: "Kontoeröffnung und -schließung",
  OTHR: "Sonstige",
  RCCN: "Eingehende Konzentrationsaufträge",
  RCDT: "Eingehende Überweisungen",
  RCHQ: "Eingereichte Schecks",
  RDDT: "Eingehende Lastschriften",
  RRCT: "Eingehende Echtzeitüberweisungen",
  SETT: "Handel, Clearing und Abrechnung",
  SPOT: "Kassengeschäfte",
};

const SUBFAMILIES_DE: Record<string, string> = {
  ACCC: "Kontoschließung",
  BBDD: "SEPA-Firmenlastschrift (B2B)",
  BOOK: "Buchinterner Transfer / Kontoübertrag",
  CCHQ: "Inhaberscheck / Reisescheck",
  CDPT: "Einzahlung",
  CHRG: "Entgelt / Gebühr",
  COMM: "Provision",
  CWDL: "Barabhebung",
  DAJT: "Belastungskorrektur",
  DPST: "Anlage (Termingeld)",
  DVCA: "Bardividende / Zinsgutschrift",
  ESCT: "SEPA-Überweisung",
  ESDD: "SEPA-Basislastschrift (CORE)",
  FCDP: "Fremdwährungseinzahlung",
  INTR: "Zinsen",
  NTAV: "Nicht verfügbar",
  OODD: "Einmalige Lastschrift",
  ORCQ: "Orderscheck",
  OTHR: "Sonstige",
  POSC: "Kreditkartenzahlung",
  POSD: "POS-Zahlung (Debitkarte)",
  POSP: "POS-Zahlung",
  PSTE: "Storno",
  RCDD: "Storno (Zahlungsstornierung)",
  RIMB: "Rückerstattung",
  RPMT: "Rückzahlung",
  RRTN: "Rücküberweisung",
  SALA: "Gehalts- / Rentenzahlung",
  SDVA: "Eilüberweisung (gleichtägig)",
  SMRT: "Geldkartentransaktion",
  STAM: "Abrechnung bei Fälligkeit",
  STDO: "Dauerauftrag",
  STLR: "Abrechnung unter Vorbehalt",
  TRAD: "Wertpapierhandel",
  UPCQ: "Unbezahlter Scheck",
  UPCT: "Unbezahlte Kartentransaktion",
  UPDD: "Rückgabe / Widerspruch Lastschrift",
  URCQ: "Scheck unter Vorbehalt",
  XBCT: "Grenzüberschreitende Überweisung",
  XBST: "Grenzüberschreitender Dauerauftrag",
  XRTN: "Rücküberweisung (grenzüberschreitend)",
};

/**
 * Returns the German label for an ISO BTC code at the given level.
 * Returns `undefined` when the code is unknown.
 */
export function lookupBtcCodeDe(
  level: 'domain' | 'family' | 'subfamily',
  code: string | null | undefined,
): string | undefined {
  if (!code) return undefined
  const key = code.trim().toUpperCase()
  switch (level) {
    case 'domain':    return DOMAINS_DE[key]
    case 'family':    return FAMILIES_DE[key]
    case 'subfamily': return SUBFAMILIES_DE[key]
  }
}
