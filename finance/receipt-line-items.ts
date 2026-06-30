export interface ReceiptLineItem {
  name: string;
  amount: number;
}

/** Human-readable receipt positions for the transaction's notes field. */
export function formatReceiptLineItemsNotice(
  items: ReceiptLineItem[],
  currencyCode: string,
): string | null {
  const lines = items
    .filter((item) => item.name.trim().length > 0 && Number.isFinite(item.amount))
    .map((item) => {
      const amount = item.amount.toFixed(2).replace(".", ",");
      return `- ${item.name.trim()}: ${amount} ${currencyCode}`;
    });

  return lines.length > 0 ? `Belegpositionen:\n${lines.join("\n")}` : null;
}
