# wellipay-api

The WelliPay integration service — the server-to-server system described in
[`wellipaypro/docs/mobile-app-integration.md`](../wellipaypro/docs/mobile-app-integration.md)
and its [OpenAPI contract](../wellipaypro/docs/mobile-app-integration.openapi.json).
It sits between provider backends (like WelliPayPro) and the separate
Patient MobileApp. It is not the provider console, and the provider
browser must never call it directly — see the contract doc's trust rules.

## What's implemented

- `POST /oauth/token` — client-credentials token issuance (interim issuer; see note in `src/lib/tokens.ts` about swapping in a real IdP)
- `POST /provider/invoices`, `GET /provider/invoices/:invoiceId`
- `POST /provider/family-funding-requests`
- `POST /provider/eligibility-checks` (persists as `PENDING` — no payer adapter is wired up yet; see the note in `src/routes/eligibility.ts`)
- `POST /provider/financial-consents`
- Idempotency-Key enforcement on every write (`src/lib/idempotency.ts`)
- Tenant scoping resolved only from the bearer token, never the request body
- Outbound webhook delivery: HMAC-SHA256 signed, transactional outbox, bounded exponential backoff, dead-letter after `WEBHOOK_MAX_ATTEMPTS` (`src/lib/webhooks.ts`, `src/worker.ts`)
- `application/problem+json` errors (RFC 9457) on every error path

## What's deliberately not implemented yet

These are the contract doc's own "Decisions to confirm before implementation" —
building them now would mean guessing at an answer instead of getting one:

- A real OIDC/OAuth identity provider (currently a self-issued JWT; functionally complete, not production-final)
- A payer/HMO eligibility adapter (eligibility checks are created and left `PENDING`)
- Webhook endpoint registration API for provider backends (currently a `WebhookEndpoint` table with no route to manage it — add one once a provider needs to self-serve this, or seed it directly)
- Payment processor integration (out of scope for this service per the contract — WelliPay's ledger consumes verified processor callbacks, which aren't specified here)

## Local development

```bash
cp .env.example .env
# fill in DATABASE_URL (a local Postgres 18) and TOKEN_SIGNING_SECRET
# (openssl rand -base64 48)

npm install
npm run prisma:migrate:dev   # creates tables, prompts for a migration name
npm run prisma:seed          # creates a tenant + API client, prints the client_secret once
npm run dev                  # http://localhost:3000
```

Smoke test:

```bash
# 1. get a token
TOKEN=$(curl -s -X POST http://localhost:3000/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=client_abc_healthcare&client_secret=<from seed output>' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')

# 2. create an invoice
curl -s -X POST http://localhost:3000/provider/invoices \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-invoice-0001-abcdef' \
  -d '{
    "providerInvoiceRef": "INV-2048",
    "facilityRef": "fac_wuse",
    "patientRef": "pat_opaque_1187",
    "description": "Consultation, ECG and Full Blood Count",
    "amountMinor": 5800000,
    "currency": "NGN"
  }'
```

## Deploying to Render, against `wellipaypro-db`

1. Push this repo to GitHub (`wellinovate/wellipay-api` or similar).
2. Render dashboard → New → Web Service → connect the repo. `render.yaml` in this repo configures the service — Render will pick it up automatically (Blueprint), or set the equivalent manually:
   - Build command: `npm ci && npm run prisma:generate && npm run build`
   - Start command: `npm run prisma:migrate && npm start`
   - Health check path: `/healthz`
3. Environment variables — set on the service (Settings → Environment):
   - `DATABASE_URL` — from `wellipaypro-db`: open that Postgres instance in Render → Info tab → **Internal Connection String** (not the external one; both services are in the same Render network, so internal is faster and doesn't leave Render's private network). If `wellipaypro-db` is Postgres 18, no version-specific changes are needed here — the schema uses nothing beyond standard SQL types.
   - `TOKEN_SIGNING_SECRET` — `render.yaml` auto-generates this; leave it, don't reuse across environments.
   - `TOKEN_ISSUER` / `TOKEN_AUDIENCE` / `WEBHOOK_MAX_ATTEMPTS` — defaults in `render.yaml` are fine to start.
4. Deploy. The start command runs `prisma migrate deploy` before booting, so tables are created automatically from `prisma/migrations/` on first deploy — **you must generate a migration locally first** with `npm run prisma:migrate:dev` and commit the resulting `prisma/migrations/` folder; Render doesn't generate migrations for you, only applies committed ones.
5. Once live, run the seed script once against production to create the first tenant/credential — either via Render's Shell tab (`npm run prisma:seed`) or by connecting to the external connection string locally with production `DATABASE_URL` set temporarily. Save the printed `client_secret` immediately; it's not stored anywhere retrievable.
6. Point WelliPayPro's provider backend (once it exists) or any other consumer at this service's base URL for `/oauth/token` and `/provider/*`.

## Design notes worth knowing before extending this

- **Money is always an integer.** `amountMinor` as `BigInt` in Postgres, `number` at the JSON boundary (see `src/lib/money.ts`). Never introduce a float column or a float in a request/response schema for an amount.
- **Idempotency-Key vs. natural uniqueness are both enforced**, deliberately redundant: the Idempotency-Key guards the HTTP write itself (retry-safe), and a `@@unique([tenantId, providerInvoiceRef])`-style constraint guards the underlying business fact (two different idempotency keys can't create two invoices for the same provider-issued reference). Keep both when adding new writes.
- **The outbox pattern is why `queueEvent()` always runs inside the same `$transaction` as the state change.** Never call `prisma.outboxEvent.create()` outside a transaction shared with the write that caused the event — that reopens the crash window the outbox exists to close.
- **`request.auth.tenantId` is the only source of tenant identity.** Never trust a `tenantRef`/`facilityRef` read from a request body for authorization decisions — only for filtering after the tenant is already established from the token.


## Provider onboarding and payouts

Any provider (hospital, diagnostic lab, pharmacy, independent practitioner) joins in three steps:

1. The provider applies with `POST /onboarding/applications` (public, rate-limited to 5 an hour per address). `GET /onboarding/banks` lists the banks for the form. The API asks the bank who owns the account number and returns that name.
2. A person at Wellinovate reviews it in the Render shell:
   - `npm run provider:list` shows pending applications and the account name the bank returned. Check that the name matches the business.
   - `APPLICATION_ID=... ADMIN_PASSWORD='...' npm run provider:approve` creates the Paystack subaccount, the tenant and the first Admin sign-in.
   - `APPLICATION_ID=... REASON='...' npm run provider:reject` rejects it.
3. The provider signs in to the console with the contact email and the password you set.

Online payments for a tenant with a Paystack subaccount settle to that provider's bank account. The provider bears Paystack's fee. `PLATFORM_FEE_PERCENT` is the share the platform keeps, set when a provider is approved. The first tenant, created by the seed script, has no subaccount and settles to the platform account.

## Refunds on split payments

A payment for a provider with a Paystack subaccount settles to the provider. Paystack takes a refund from the platform's own balance, not from the subaccount. Two things follow:

- The platform's Paystack balance must hold at least the refund amount before a refund is approved. If it does not, Paystack answers "Insufficient balance to process refund" and the refund stays pending.
- After the refund is approved, the provider owes the platform that amount. The refund is marked `recoveryStatus: OWED`.

From the Render shell:

```
npm run recovery:list
REFUND_ID=... NOTE='paid by bank transfer' npm run recovery:settle
REFUND_ID=... NOTE='reason' npm run recovery:waive
```

These commands only change the record. They do not move money.

## Staying signed in

A staff token lasts 15 minutes. `POST /staff/refresh` swaps a token that has not yet expired for a new one, so a person who keeps working stays signed in. A token that has already expired cannot be renewed, so 15 minutes without a request still signs them out.

The sign-in time travels inside every renewed token. Renewal stops `SESSION_MAX_HOURS` after sign-in (default 8), whatever the activity. The refresh reads the staff record again: a deactivated account or a changed access level takes effect at the next renewal.

## Refund status from Paystack

A refund paid through Paystack stores Paystack's refund id and status when it is approved. Paystack moves it on afterwards (`pending`, `processing`, `processed`, `needs-attention`, `failed`). `POST /provider/refunds/:refundId/gateway-status` asks Paystack for the current status and saves it. The console calls it for refunds that have not reached `processed` or `failed`.

If a refund ends as `failed` or `needs-attention`, the patient has not been paid. The console flags it. Contact Paystack support with the refund id.

## Price list

Each provider keeps a saved price list. Prices are whole kobo.

- `GET /provider/service-items` lists active items. Add `includeInactive=true` to include switched-off ones, and `q` to search by name.
- `POST /provider/service-items` adds an item (`name`, `unitPriceMinor`, optional `category`). Billing, Finance and Admin only.
- `PATCH /provider/service-items/:id` changes the name, category or price, or sets `active: false`. Items are switched off, not deleted, so old invoices keep their history.

Invoices copy the name and price when they are made. Changing an item does not change an old invoice.
## Family funding through Paystack

A sponsor can pay their pledge online instead of at the desk.

1. Create the funding request as before (`POST /provider/family-funding-requests`). Each sponsor gets a contribution with an id.
2. `POST /provider/paystack/charges` with `invoiceId`, the sponsor's `email` and `fundingContributionId`. The amount is the pledged amount, so do not send `amountMinor`. The reply has an `authorizationUrl` to send to the sponsor.
3. When Paystack confirms the charge, the webhook records the payment, marks the contribution paid and updates the request. The request becomes `FUNDED` when every pledge is paid. A `family.contribution.updated` event is sent.

`GET /provider/family-funding-requests` lists requests with their pledges and statuses. Filter with `invoiceId`.

A pledge that is already paid is refused with `contribution_already_settled`. If a pledge was settled another way while a link was open, the money is still recorded as a payment and the pledge is left as it was.

## Packages, bookings and corporate accounts

For diagnostic centres and other providers that bill in bundles or on account.

- Packages. `POST /provider/service-items` and `PATCH /provider/service-items/:id` take `componentIds`, the ids of the items inside a package. A package needs at least two active single items and cannot hold another package. It has its own price. Items return `isPackage` and `componentIds`.
- Bookings. `POST /provider/bookings` records a `CENTRE_VISIT` or `HOME_COLLECTION` (a home collection needs an address) for a registered patient. `GET /provider/bookings` lists them, filtered by `status`, `from` and `to`. `PATCH /provider/bookings/:id` moves the status forward one step: `BOOKED`, `SAMPLE_COLLECTED`, `PROCESSING`, `READY`. A booking can be cancelled only while `BOOKED`. Send `kind: "IMAGING"` for a scan. A scan is done at the centre, and `GET /provider/bookings` can filter by `kind`. The statuses are the same; a console shows them as booked, scan done, reporting and report ready.
- Corporate accounts. `POST /provider/corporate-accounts` adds a company. `GET /provider/corporate-accounts` lists them with billed, paid and outstanding totals. `GET /provider/corporate-accounts/:id/statement` lists the account's invoices. To bill a company, send `corporateAccountId` on `POST /provider/invoices`.

Reads are open to every staff level. Bookings are written by front desk levels and above. Packages and accounts are written by Billing, Finance and Admin.

## Diagnostic test catalogue and check-up packages

The master catalogue lives in `src/data/diagnosticCatalogue.ts`. It has 48 tests in 11 categories. Each test has a code such as `LAB-HAEM-001`, a category, a sample type and the check-up lists it belongs to (`MALE`, `FEMALE`). It carries no prices.

A provider offers a master test by adding it to its price list. That creates a price list item with the test's `masterCode`, and the provider sets the price, turnaround time, preparation, home collection and digital results. One offer per test per provider.

- `GET /provider/catalogue/diagnostic-tests` lists the master tests with the provider's offer joined to each. Filters: `q`, `category` (a category code such as `HAEM`).
- `POST /provider/catalogue/diagnostic-tests/offers` offers up to 60 tests at once. Each needs `code` and `unitPriceMinor`. Tests already offered, or whose name another item uses, come back under `skipped`.
- `/provider/service-items` accepts and returns `serviceCode`, `sampleType`, `turnaround`, `preparation`, `homeCollection` and `digitalResults`.

Check-up packages are optional and stay separate from the test catalogue. A package has a tier (`CLASSIC`, `EXECUTIVE`, `DIAMOND`, `PLATINUM`), an audience (`ALL`, `MALE`, `FEMALE`), a price, the included price list items (at least two, single and active), exclusions and an availability flag.

- `GET /provider/checkup-packages`
- `POST /provider/checkup-packages`
- `PATCH /provider/checkup-packages/:id`

Tier contents and prices are not fixed by the platform. Each provider sets its own.

Migration `20261014070000_diagnostic_catalogue` is hand-written SQL.

## Invoice lines, payment limit and test results

**Invoice lines.** `POST /provider/invoices` accepts an optional `lines` array (1 to 60). Each line has `description`, `quantity` (default 1), `unitPriceMinor` and an optional `serviceItemId`. The lines must add up to `amountMinor`, or the API returns 422 `lines_total_mismatch`. Invoices read back with `lines` and a `lineTotalMinor` on each. Invoices made without lines are unchanged.

**Payment limit.** `POST /provider/payments` returns 422 `payment_exceeds_balance` when the amount is more than what is still owed, or when the invoice is already paid or cancelled. Paystack webhook payments are not blocked, because the money has already been taken.

**Test results.** Each booking can carry one result per test.

- `GET /provider/bookings/:id/results`
- `POST /provider/bookings/:id/results` lists the tests on the booking (`tests`: `testName`, optional `serviceItemId`). Tests already listed are skipped.
- `PATCH /provider/booking-results/:resultId` sets `resultText`, `abnormal` and `status` (`PENDING` or `READY`). A result cannot be marked ready without text. Results can be entered once the sample is collected.
- A booking cannot move to `READY` while a result on it is still pending (409 `results_incomplete`).

Patients do not see results through the patient API yet.

Migration `20261014080000_invoice_lines_results` is hand-written SQL.

## Patient results and SMS reminders

**Patient results.** `GET /patient/results` (scope `patient.self.read`) returns the signed-in patient's ready results. A result appears only when it is ready and its test has `digitalResults` set on the price list. Results typed without a linked price list item are not shown. `inPersonCount` is the number of ready results the lab hands over in person.

**SMS.** Reminders go through Termii. Set `TERMII_API_KEY` in Render. `TERMII_SENDER_ID` (default `N-Alert`) and `TERMII_CHANNEL` (`dnd` default, `generic` or `whatsapp`) are optional. The sender ID must be approved in your Termii account.

- `GET /provider/sms-status` returns `{ "enabled": true | false }`.
- `POST /provider/bookings/:id/reminder` with `{ "message" }` texts the patient. Only for a booking that is still `BOOKED`. Returns 503 until the key is set, 422 when the patient has no usable phone, and 409 if a reminder went out in the last 15 minutes. The booking records `reminderSentAt`.

Migration `20261014090000_booking_reminder` is hand-written SQL.

## Guest payment, patient payment and transaction history

Two ways to pay. Both start a Paystack checkout. Paystack's signed webhook is the only thing that marks a bill paid. A browser redirect proves nothing.

**Pay as a guest (no account).**
- `POST /provider/invoices/:id/pay-link` (staff) returns a `payToken` for the invoice. Send `{ "rotate": true }` to replace it and stop the old link working. The link is `<pay page>?t=<payToken>`.
- `GET /public/pay/:token` shows the provider, the bill and the balance. It shows the patient's first name only.
- `POST /public/pay/:token/charge` with `email`, optional `phone` and optional `amountMinor` (default: the balance) returns `authorizationUrl`, `reference` and a `claimCode`.
- `GET /public/pay/:token/charges/:reference` returns the status and receipt details. It shows the `claimCode` while the payment is pending or paid.
- These routes are rate limited per IP. Set `PAY_PAGE_URL` to the public pay page so guests return to it after checkout.

**Pay as a signed-in patient.**
- `POST /patient/paystack/charges` with `invoiceId`, optional `email` (else the one on file) and optional `amountMinor`.
- `GET /patient/transactions` lists every payment attempt on the patient's bills, plus guest payments they claimed. Filter with `status`. Each row has `transactionId`, `reference`, `processor`, the provider, the bill, `status` (`PENDING`, `SUCCESS`, `FAILED`), `refundStatus` (`NONE`, `PENDING`, `REFUNDED`) and the bill's lines when it has them.
- `GET /patient/transactions/:reference` returns one row.
- `POST /patient/transactions/claim` with `claimCode` adds a guest payment to the patient's profile. It works within the same provider only, and a payment can belong to one profile.

Settlement status per payment is not tracked yet. Paystack is the only processor.

Migration `20261014100000_guest_and_patient_pay` is hand-written SQL.
