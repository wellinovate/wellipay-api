export interface PackageCandidate {
  id: string;
  active: boolean;
  componentIds: string[];
}

// Checks the items chosen for a package. Returns a message when something is
// wrong, or null when the list can be used. A package holds single items only,
// so packages cannot nest, and every item must be active and belong to the
// provider (the caller passes only that provider's items).
export function packageProblem(componentIds: string[], items: PackageCandidate[], ownId?: string): string | null {
  if (new Set(componentIds).size !== componentIds.length) return "A package cannot list the same item twice.";
  if (componentIds.length < 2) return "A package needs at least two items.";
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const id of componentIds) {
    if (id === ownId) return "A package cannot contain itself.";
    const item = byId.get(id);
    if (!item) return "One of the package items is not on your price list.";
    if (!item.active) return "One of the package items is switched off.";
    if (item.componentIds.length > 0) return "A package cannot contain another package.";
  }
  return null;
}
