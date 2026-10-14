export interface ResultRow {
  status: string;
}

// A booking can move to READY only when every result on it is ready.
export function pendingResults(results: ResultRow[]): number {
  return results.filter((r) => r.status !== "READY").length;
}

// Results can be entered once the sample is collected (or the scan is done).
export function canEnterResults(bookingStatus: string): boolean {
  return bookingStatus === "SAMPLE_COLLECTED" || bookingStatus === "PROCESSING" || bookingStatus === "READY";
}
