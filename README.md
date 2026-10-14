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
- Bookings. `POST /provider/bookings` records a `CENTRE_VISIT` or `HOME_COLLECTION` (a home collection needs an address) for a registered patient. `GET /provider/bookings` lists them, filtered by `status`, `from` and `to`. `PATCH /provider/bookings/:id` moves the status forward one step: `BOOKED`, `SAMPLE_COLLECTED`, `PROCESSING`, `READY`. A booking can be cancelled only while `BOOKED`.
- Corporate accounts. `POST /provider/corporate-accounts` adds a company. `GET /provider/corporate-accounts` lists them with billed, paid and outstanding totals. `GET /provider/corporate-accounts/:id/statement` lists the account's invoices. To bill a company, send `corporateAccountId` on `POST /provider/invoices`.

Reads are open to every staff level. Bookings are written by front desk levels and above. Packages and accounts are written by Billing, Finance and Admin.
