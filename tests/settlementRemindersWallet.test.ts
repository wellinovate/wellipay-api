import { describe, it, expect } from "vitest";
import { mapGatewaySettlementStatus, netMinor, settlementSummary, shouldAdvance } from "../src/lib/settlementStatus.js";
import { parseAuthorization, cardExpired, cardView } from "../src/lib/cards.js";
import { topUpProblem, walletPayProblem, walletView, MAX_BALANCE_MINOR } from "../src/lib/wallet.js";
import { reminderTimeProblem, reminderMessage, dueState } from "../src/lib/reminders.js";
import { listSettlementTransactions, chargeAuthorization, PaystackDeclined, listSettlements } from "../src/lib/paystack.js";

describe("settlement status", () => {
  it("maps Paystack payout states", () => {
    expect(mapGatewaySettlementStatus("success")).toBe("SETTLED");
    expect(mapGatewaySettlementStatus("failed")).toBe("FAILED");
    expect(mapGatewaySettlementStatus("pending")).toBe("PROCESSING");
    expect(mapGatewaySettlementStatus(undefined)).toBe("PROCESSING");
  });
  it("takes the fee off the amount", () => {
    expect(netMinor({ amountMinor: 100000n, feesMinor: 1500n })).toBe(98500n);
    expect(netMinor({ amountMinor: 100000n, feesMinor: null })).toBe(100000n);
    expect(netMinor({ amountMinor: 1000n, feesMinor: 5000n })).toBe(0n);
  });
  it("totals payments by where the money is", () => {
    const s = settlementSummary([
      { amountMinor: 100000n, feesMinor: 1500n, settlementStatus: "SETTLED" },
      { amountMinor: 50000n, feesMinor: 750n, settlementStatus: "AWAITING" },
      { amountMinor: 20000n, feesMinor: null, settlementStatus: "PROCESSING" },
      { amountMinor: 10000n, feesMinor: null, settlementStatus: "FAILED" },
    ]);
    expect(s).toEqual({ awaitingMinor: 49250, processingMinor: 20000, settledMinor: 98500, failedMinor: 10000, feesMinor: 2250 });
  });
  it("never moves a payment backwards", () => {
    expect(shouldAdvance("AWAITING", "PROCESSING")).toBe(true);
    expect(shouldAdvance("PROCESSING", "SETTLED")).toBe(true);
    expect(shouldAdvance("SETTLED", "PROCESSING")).toBe(false);
    expect(shouldAdvance("SETTLED", "SETTLED")).toBe(false);
  });
});

describe("saved cards", () => {
  const auth = { authorization_code: "AUTH_x", reusable: true, signature: "SIG_1", last4: "4081", brand: "visa", exp_month: "12", exp_year: "2030", bank: "TEST BANK" };
  it("reads a reusable card", () => {
    expect(parseAuthorization(auth)).toMatchObject({ authorizationCode: "AUTH_x", last4: "4081", brand: "visa" });
  });
  it("ignores a card Paystack says cannot be reused", () => expect(parseAuthorization({ ...auth, reusable: false })).toBeNull());
  it("ignores missing or odd data", () => {
    expect(parseAuthorization(null)).toBeNull();
    expect(parseAuthorization({ ...auth, last4: "12" })).toBeNull();
    expect(parseAuthorization({ ...auth, authorization_code: "" })).toBeNull();
  });
  it("knows when a card has expired", () => {
    expect(cardExpired("01", "2026", new Date("2026-02-01"))).toBe(true);
    expect(cardExpired("01", "2026", new Date("2026-01-31"))).toBe(false);
    expect(cardExpired(null, null)).toBe(false);
  });
  it("never shows the token", () => {
    const v = cardView({ id: "m1", brand: "visa", last4: "4081", expMonth: "12", expYear: "2030", bank: null, createdAt: new Date("2026-10-14") }, new Date("2026-10-14"));
    expect(JSON.stringify(v)).not.toContain("AUTH");
    expect(v).toMatchObject({ methodId: "m1", last4: "4081", expired: false });
  });
});

describe("wallet limits", () => {
  it("rejects a top-up under ₦100", () => expect(topUpProblem(9999n, 0n)).toMatch(/smallest/));
  it("rejects a top-up over ₦500,000", () => expect(topUpProblem(50_000_001n, 0n)).toMatch(/largest/));
  it("rejects a top-up past the balance cap", () => expect(topUpProblem(10_000_000n, MAX_BALANCE_MINOR - 5_000_000n)).toMatch(/hold more/));
  it("allows a normal top-up", () => expect(topUpProblem(500_000n, 0n)).toBeNull());
  it("blocks a payment over the balance", () => expect(walletPayProblem(500_000n, 100_000n, 500_000n)).toMatch(/too low/));
  it("blocks a payment over the bill", () => expect(walletPayProblem(600_000n, 900_000n, 500_000n)).toMatch(/more than/));
  it("blocks a paid bill", () => expect(walletPayProblem(100_000n, 900_000n, 0n)).toMatch(/nothing left/));
  it("allows a covered payment", () => expect(walletPayProblem(500_000n, 900_000n, 500_000n)).toBeNull());
  it("shows the balance", () => expect(walletView(250_000n)).toMatchObject({ balanceMinor: 250000, currency: "NGN" }));
});

describe("reminders", () => {
  const now = new Date("2026-10-14T10:00:00Z");
  it("rejects a time in the past", () => expect(reminderTimeProblem(new Date("2026-10-14T09:00:00Z"), now)).toMatch(/at least a minute/));
  it("rejects a time too far out", () => expect(reminderTimeProblem(new Date("2027-06-01T00:00:00Z"), now)).toMatch(/within 180 days/));
  it("rejects an invalid date", () => expect(reminderTimeProblem(new Date("nope"), now)).toMatch(/valid/));
  it("allows tomorrow", () => expect(reminderTimeProblem(new Date("2026-10-15T10:00:00Z"), now)).toBeNull());
  it("classifies bills by due date", () => {
    expect(dueState(null, now)).toBe("OPEN");
    expect(dueState(new Date("2026-10-13T00:00:00Z"), now)).toBe("OVERDUE");
    expect(dueState(new Date("2026-10-16T00:00:00Z"), now)).toBe("DUE_SOON");
    expect(dueState(new Date("2026-11-30T00:00:00Z"), now)).toBe("OPEN");
  });
  it("writes a short message", () => {
    const m = reminderMessage("Lab One", 1250000, "Full blood count and malaria parasite test and more");
    expect(m).toContain("₦12,500");
    expect(m).toContain("Lab One");
    expect(m).toContain("...");
    expect(m.length).toBeLessThan(200);
  });
});

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}

describe("Paystack settlement and saved-card calls", () => {
  it("lists the transactions in a payout", async () => {
    const r = await listSettlementTransactions("sk", "42", 1, fakeFetch({ status: true, data: [{ reference: "wp_a", id: 1 }, { id: 2 }, { reference: "wp_b" }] }));
    expect(r.items.map((i) => i.reference)).toEqual(["wp_a", "wp_b"]);
    expect(r.hasMore).toBe(false);
  });
  it("passes the subaccount when listing payouts", async () => {
    let url = "";
    const f = (async (u: string) => { url = u; return { ok: true, status: 200, json: async () => ({ status: true, data: [] }) }; }) as unknown as typeof fetch;
    await listSettlements("sk", { from: "2026-10-01", subaccount: "ACCT_x" }, f);
    expect(url).toContain("subaccount=ACCT_x");
  });
  it("charges a saved card", async () => {
    const r = await chargeAuthorization("sk", { email: "a@b.co", amountMinor: 5000, authorizationCode: "AUTH_x", reference: "wp_1" }, fakeFetch({ status: true, data: { status: "success" } }));
    expect(r.status).toBe("success");
  });
  it("reports a declined card as declined", async () => {
    await expect(chargeAuthorization("sk", { email: "a@b.co", amountMinor: 5000, authorizationCode: "AUTH_x", reference: "wp_1" }, fakeFetch({ status: true, data: { status: "failed", gateway_response: "Insufficient funds" } }))).rejects.toBeInstanceOf(PaystackDeclined);
  });
});
