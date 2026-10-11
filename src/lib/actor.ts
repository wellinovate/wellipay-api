// Who performed an action. A staff token carries the signed-in person's
// identity, so that always wins and a name typed into the request body is
// ignored. A server-to-server token (client credentials) has no person
// behind it, so the integrating system must name the actor itself.
export interface ActorSource {
  staff?: { id: string; name: string; role: string };
}

export function resolveActor(auth: ActorSource | undefined, supplied: string | null | undefined): string | null {
  if (auth?.staff) return `${auth.staff.name} [${auth.staff.id}]`.slice(0, 120);
  const trimmed = supplied?.trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}
