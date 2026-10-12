import { describe, it, expect } from "vitest";
import { createApplicationSchema } from "../src/schemas/onboarding.js";
import { listBanks, resolveAccount, createSubaccount, initializeTransaction, PaystackError } from "../src/lib/paystack.js";

const secret = "sk_test_example";
const json = (data: unknown, status = 200) => (async () => new Response(JSON.stringify(data), { status })) as unknown as typeof fetch;

const valid = {
  businessName: "Greenlife Pharmacy",
  providerType: "PHARMACY",
  contactName: "Ada Obi",
  contactEmail: "ada@greenlife.ng",
  contactPhone: "08012345678",
  bankCode: "058",
  accountNumber: "0123456789",
};

describe("createApplicationSchema", () => {
  it("accepts a complete application", () => {
    expect(createApplicationSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts every provider type and rejects unknown ones", () => {
    for (const t of ["HOSPITAL", "DIAGNOSTIC_LAB", "PHARMACY", "INDEPENDENT_PRACTITIONER"]) {
      expect(createApplicationSchema.safeParse({ ...valid, providerType: t }).success).toBe(true);
    }
    expect(createApplicationSchema.safeParse({ ...valid, providerType: "CLINIC" }).success).toBe(false);
  });
  it("rejects a short or non-numeric account number", () => {
    expect(createApplicationSchema.safeParse({ ...valid, accountNumber: "12345" }).success).toBe(false);
    expect(createApplicationSchema.safeParse({ ...valid, accountNumber: "01234abcde" }).success).toBe(false);
  });
  it("accepts +234 and 0 phone formats and rejects others", () => {
    expect(createApplicationSchema.safeParse({ ...valid, contactPhone: "+2348012345678" }).success).toBe(true);
    expect(createApplicationSchema.safeParse({ ...valid, contactPhone: "12345" }).success).toBe(false);
  });
  it("rejects a bad email", () => {
    expect(createApplicationSchema.safeParse({ ...valid, contactEmail: "nope" }).success).toBe(false);
  });
});

describe("Paystack onboarding calls", () => {
  it("listBanks returns name and code", async () => {
    const banks = await listBanks(secret, json({ status: true, data: [{ name: "Access Bank", code: "044" }, { name: "", code: "x" }] }));
    expect(banks).toEqual([{ name: "Access Bank", code: "044" }]);
  });

  it("resolveAccount sends the number and bank code and returns the account name", async () => {
    let url = "";
    const fake = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ status: true, data: { account_name: "GREENLIFE PHARMACY LTD" } }));
    }) as unknown as typeof fetch;
    const r = await resolveAccount(secret, { accountNumber: "0123456789", bankCode: "058" }, fake);
    expect(r.accountName).toBe("GREENLIFE PHARMACY LTD");
    expect(url).toContain("account_number=0123456789");
    expect(url).toContain("bank_code=058");
  });

  it("resolveAccount throws when the bank cannot confirm the account", async () => {
    await expect(resolveAccount(secret, { accountNumber: "0000000000", bankCode: "058" }, json({ status: false, message: "Could not resolve account name" }, 422))).rejects.toThrow(PaystackError);
  });

  it("createSubaccount posts the bank details and returns the ACCT code", async () => {
    let body: Record<string, unknown> = {};
    const fake = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ status: true, data: { subaccount_code: "ACCT_abc123" } }));
    }) as unknown as typeof fetch;
    const r = await createSubaccount(secret, { businessName: "Greenlife", bankCode: "058", accountNumber: "0123456789", platformPercent: 2 }, fake);
    expect(r.subaccountCode).toBe("ACCT_abc123");
    expect(body).toEqual({ business_name: "Greenlife", bank_code: "058", account_number: "0123456789", percentage_charge: 2 });
  });

  it("createSubaccount throws with Paystack's message", async () => {
    await expect(createSubaccount(secret, { businessName: "x", bankCode: "058", accountNumber: "1", platformPercent: 0 }, json({ status: false, message: "Invalid account" }, 400))).rejects.toThrow("Invalid account");
  });
});

describe("initializeTransaction with a subaccount", () => {
  const capture = () => {
    const sent: { body: Record<string, unknown> } = { body: {} };
    const fake = (async (_u: string, init: RequestInit) => {
      sent.body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ status: true, data: { authorization_url: "https://checkout.paystack.com/x", access_code: "x" } }));
    }) as unknown as typeof fetch;
    return { sent, fake };
  };

  it("sends the subaccount and makes the provider bear Paystack's fee", async () => {
    const { sent, fake } = capture();
    await initializeTransaction(secret, { email: "a@b.com", amountMinor: 5000, reference: "wp_1", subaccount: "ACCT_abc123" }, fake);
    expect(sent.body["subaccount"]).toBe("ACCT_abc123");
    expect(sent.body["bearer"]).toBe("subaccount");
  });

  it("sends no subaccount fields when the tenant has none", async () => {
    const { sent, fake } = capture();
    await initializeTransaction(secret, { email: "a@b.com", amountMinor: 5000, reference: "wp_1", subaccount: null }, fake);
    expect(sent.body).not.toHaveProperty("subaccount");
    expect(sent.body).not.toHaveProperty("bearer");
  });
});
