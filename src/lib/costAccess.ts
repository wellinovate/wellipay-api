// What a unit cost the pharmacy paid is commercial information. Only Admin and
// Finance staff see it. Billing can enter it on a stock receipt but not read it back.
const COST_LEVELS = ["ADMIN", "FINANCE"];

export function canSeeCost(auth: { staff?: { level: string } | undefined } | undefined | null): boolean {
  const level = auth?.staff?.level;
  return !!level && COST_LEVELS.includes(level);
}
