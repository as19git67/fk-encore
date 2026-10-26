import type { Area } from "./index";

export const FINANCE_AREA: Area = {
  id: "finance",
  description: "Finanzen: accounts and balances, bookings (Buchungen), sums over bookings, expected direct debits and transfers, tags, reports with subtotals, booking folders.",
  tools: [
    "list_accounts",
    "list_transactions",
    "transaction_totals",
    "upcoming_payments",
    "tag_transactions",
    "transaction_report",
    "create_transaction_folder",
  ],
  rules: [],
  examples: [
    '"Zeige mir die 10 neuesten Buchungen." → list_transactions(limit = 10) → name what the rows show; the rows themselves appear beside the answer.',
    '"Welche Lastschriften muss ich diesen Monat noch erwarten?" → upcoming_payments(channel = "direct_debit", until = end of this month) → answer with the debits and the sum the tool printed; "was geht diesen Monat noch vom Konto ab" is the same call without channel (direct debits and transfers), never card payments or cash.',
    '"Liste alle Buchungen zur Wohnung mit Zwischensummen für Kauf, Reparatur und Mieteinnahmen und ermittle die Rendite." → list_transactions (as needed) → transaction_report(title = …, groups = [{name: "Kauf", transaction_ids: […]}, {name: "Reparatur", …}, {name: "Mieteinnahmen", tag: "Miete"}], transaction_ids = all bookings found, yield = {investment_group: "Kauf", income_groups: ["Mieteinnahmen"], cost_groups: ["Reparatur"]}) → repeat only the subtotals and the yield formula the tool printed, and name bookings whose group was doubtful.',
    '"Füge den Buchungen vom Baumarkt im September den Tag Renovierung hinzu." → list_transactions(q = "Baumarkt", from/to = September) → tag_transactions(from_previous_result = true, add = ["Renovierung"]) → say how many bookings get the tag and that it waits for "Ausführen" on the card; never ask first whether you should.',
    '"Was war dieses Jahr in jedem Monat meine größte Ausgabe?" → list_transactions(direction = "out", rank_by = "amount", group_by = "month", from = start of this year); "für jeden Monat/jedes Jahr das …" is one call with group_by, never one call per month.',
  ],
  keywords:
    "konto|konten|kontostand|saldo|buchung|umsatz|umsätze|lastschrift|überweisung|abbuchung|ausgabe|einnahme|zahlung|bezahlt|überwiesen|miete|rendite|zwischensumme|girokonto|"
    + "account|balance|booking|transaction|debit|payment|expense|income|rent",
};
