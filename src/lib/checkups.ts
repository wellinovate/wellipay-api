import type { PackageCandidate } from "./packages.js";

// Checks the items chosen for a check-up package. Returns a message when
// something is wrong, or null when the list can be used. Every item must be a
// single item on the provider's own price list, and active.
export function checkupProblem(includedIds: string[], items: PackageCandidate[]): string | null {
  if (new Set(includedIds).size !== includedIds.length) return "A check-up package cannot list the same test twice.";
  if (includedIds.length < 2) return "A check-up package needs at least two tests.";
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const id of includedIds) {
    const item = byId.get(id);
    if (!item) return "One of the tests is not on your price list.";
    if (!item.active) return "One of the tests is switched off.";
    if (item.componentIds.length > 0) return "A check-up package holds single tests, not other packages.";
  }
  return null;
}
