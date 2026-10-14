export interface PatientResultRow {
  status: string;
  serviceItemId: string | null;
}

// A patient sees a result in the app when it is ready and its test is set up
// for digital delivery. Everything else is collected in person.
export function visibleToPatient(row: PatientResultRow, digitalItemIds: Set<string>): boolean {
  return row.status === "READY" && row.serviceItemId !== null && digitalItemIds.has(row.serviceItemId);
}
