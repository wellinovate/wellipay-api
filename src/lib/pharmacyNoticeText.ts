export type NoticeEvent = "READY" | "DISPATCHED" | "DELIVERED";

export interface NoticeContext {
  pharmacy: string;
  event: NoticeEvent;
  fulfilment: string;
  courierName?: string | null | undefined;
  trackingUrl?: string | null | undefined;
}

// Plain text, no clinical detail. A phone can show these on a lock screen.
export function noticeMessage(c: NoticeContext): string | null {
  switch (c.event) {
    case "READY":
      return c.fulfilment === "PICKUP" ? `${c.pharmacy}: your order is ready for pickup. Bring your ID.` : null;
    case "DISPATCHED":
      return `${c.pharmacy}: your order is on its way${c.courierName ? ` with ${c.courierName}` : ""}. Open the WelliPay app for your delivery code. Give it to the rider only when you have your order.${c.trackingUrl ? ` Track it: ${c.trackingUrl}` : ""}`;
    case "DELIVERED":
      return `${c.pharmacy}: your order was delivered. If this is wrong, call the pharmacy now.`;
  }
}

