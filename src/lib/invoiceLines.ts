export interface LineInput {
  quantity: number;
  unitPriceMinor: number;
}

export function linesTotal(lines: LineInput[]): number {
  return lines.reduce((sum, l) => sum + l.quantity * l.unitPriceMinor, 0);
}

// Returns a message when the lines do not add up to the invoice amount.
export function linesProblem(lines: LineInput[], amountMinor: number): string | null {
  const total = linesTotal(lines);
  if (total !== amountMinor) return `The lines add up to ${total} kobo but the invoice amount is ${amountMinor} kobo.`;
  return null;
}
