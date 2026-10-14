export type BookingStatusValue = "BOOKED" | "SAMPLE_COLLECTED" | "PROCESSING" | "READY" | "CANCELLED";

// A booking moves forward one step at a time. It can be cancelled only before
// the sample is collected. READY and CANCELLED are final.
const NEXT: Record<BookingStatusValue, BookingStatusValue[]> = {
  BOOKED: ["SAMPLE_COLLECTED", "CANCELLED"],
  SAMPLE_COLLECTED: ["PROCESSING"],
  PROCESSING: ["READY"],
  READY: [],
  CANCELLED: [],
};

export function canMoveBooking(from: BookingStatusValue, to: BookingStatusValue): boolean {
  return NEXT[from].includes(to);
}

export function nextBookingStatuses(from: BookingStatusValue): BookingStatusValue[] {
  return NEXT[from];
}
