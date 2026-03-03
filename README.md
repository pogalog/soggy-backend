# Product + Cart Cloud Functions

Node.js HTTP Cloud Functions for product retrieval and shopping cart CRUD backed by Cloud SQL Postgres.

## API routes (single service)

Run/deploy one HTTP function and route by path:

- Product: `GET /products/:id`
- Cart:
  - `POST /cart` (server generates `sessionId`; `/cart/:sessionId` also accepted)
  - `GET|PUT|DELETE /cart/:sessionId`
- Commission form: `POST /api/commission/form`
- Checkout: `POST /api/checkout/session`
- Stripe webhook: `POST /api/stripe/webhook`

Legacy exports `getProduct` and `cartService` still exist, but both now point to the same routed handler.

## Product endpoint

- `GET /products/:id`
- `GET /?id=:id` (fallback format for direct function URLs)

Success response shape matches `contract/get-products-id-response.json`.

## Cart endpoints

Handled by the same routed API function

- `POST /cart/:sessionId` or `POST /?sessionId=:sessionId`
- `GET /cart/:sessionId` or `GET /?sessionId=:sessionId`
- `PUT /cart/:sessionId` or `PUT /?sessionId=:sessionId`
- `DELETE /cart/:sessionId` or `DELETE /?sessionId=:sessionId`

Request body for `POST`/`PUT`:

```json
{
  "items": [
    { "productId": "prod_123", "quantity": 2 },
    { "productId": "prod_456", "quantity": 1 }
  ]
}
```

`POST` creates a new cart and returns a generated `sessionId` (or uses a supplied one if provided). It returns `409` if that session already has cart rows. `PUT` replaces the cart contents for the session and accepts an empty `items` array to clear the cart.

## Checkout endpoint

- `POST /api/checkout/session`

Request body:

```json
{
  "cartSessionId": "sess_123",
  "channel": "online"
}
```

Behavior notes:

- Reads cart items and product pricing from Postgres (client prices are ignored).
- Creates `orders` + `order_items` rows in Postgres before calling Stripe Checkout.
- Uses inline Stripe `price_data.product_data` (no Stripe Product/Price setup required).
- Enables Stripe automatic tax and applies optional `STRIPE_TAX_CODE` to each line item.
- Returns a `checkoutUrl` to redirect the client to Stripe-hosted Checkout.

## Commission form endpoint

- `POST /commissions`
- `POST /api/commissions`
- Legacy alias: `POST /api/commission/form`

Request body shape matches `schemas/post-api-commission-form.request.json`.

Behavior notes:

- Accepts the simpler `submissionKey + form` payload from the UI.
- Backward-compatible: the older nested `customer` / `item` / `materials` payload is still accepted.
- `storage` is optional. Requests with no images are valid.
- Stores only non-PII fields in Postgres: submission key, item/material details, and storage metadata.
- Does not persist customer name, email, or phone in the `commissions` table.
- Sends two HTML emails over SMTP: one to the customer and one to the business inbox.
- Storage images are rendered in the business email body as authenticated Cloud Storage links using `COMMISSION_GCS_BUCKET` + each `objectPath`.

## Stripe webhook endpoint

- `POST /api/stripe/webhook`

This endpoint verifies `Stripe-Signature` using the raw request body (`req.rawBody`) and `STRIPE_WEBHOOK_SECRET`. On `checkout.session.completed`, it marks the order as `paid`, stores Stripe IDs, and decrements inventory in a transaction with idempotent status checks to avoid double-decrementing on retries.

## Files

- `index.js`: Cloud Function export(s), including routed `api`
- `src/handlers/apiHandler.js`: path-based router for product/cart endpoints
- `src/handlers/getProductHandler.js`: HTTP request handling
- `src/models/productModel.js`: SQL query + schema-to-contract mapping
- `src/handlers/cartHandler.js`: cart CRUD HTTP handling
- `src/models/cartModel.js`: cart CRUD SQL operations
- `src/handlers/commissionFormHandler.js`: commission form intake + email delivery
- `src/models/commissionModel.js`: non-PII commission persistence
- `src/lib/commissionEmailTemplates.js`: HTML email rendering for customer/business messages
- `src/lib/mailer.js`: SMTP mail transport
- `src/handlers/checkoutHandler.js`: Stripe Checkout Session creation from DB cart state
- `src/handlers/stripeWebhookHandler.js`: Stripe webhook signature verification + payment reconciliation
- `src/models/orderModel.js`: order persistence and transactional payment finalization
- `src/lib/stripeClient.js`: lazy Stripe SDK client loader
- `cart-schema.sql`: cart table schema
- `commission-schema.sql`: commission intake table schema
- `order-schema.sql`: orders + order_items schema
- `src/db/pool.js`: shared Postgres pool
- `src/config/env.js`: environment loading/parsing

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

Only `.env` is loaded at runtime. `.env.example` is just a template and is not read by the app.

3. Apply DB schema updates (once per database):

```bash
psql "$DATABASE_URL" -f product-schema.sql
psql "$DATABASE_URL" -f cart-schema.sql
psql "$DATABASE_URL" -f commission-schema.sql
psql "$DATABASE_URL" -f order-schema.sql
```

If you already have an older DB, apply the incremental script instead:

```bash
psql "$DATABASE_URL" -f sql-util/commission-form-migration.sql
psql "$DATABASE_URL" -f sql-util/stripe-checkout-migration.sql
```

4. Run locally:

```bash
npm start
```

This serves both `/products/...` and `/cart/...` from the same local process.

`npm run dev:debug` is available if you explicitly want framework debug behavior during local troubleshooting.

5. Example request:

```bash
curl "http://localhost:8080/products/prod_123"
```

## Deploy to Cloud Functions (Gen 2)

Use the included script:

```bash
PROJECT_ID="your-project-id" \
REGION="us-central1" \
DB_USER="postgres" \
DB_PASS="your-password" \
DB_NAME="products_db" \
INSTANCE_CONNECTION_NAME="your-project:your-region:your-instance" \
./deploy.sh
```

If you use direct TCP instead of Cloud SQL sockets, set `DB_HOST` (and optional `DB_PORT`) and omit `INSTANCE_CONNECTION_NAME`.

To deploy the unified API service, set `ENTRY_POINT=api` (recommended). Existing `getProduct` and `cartService` entry points are aliases to the same routed handler.

## Notes

- Currency in the response defaults to `USD` and can be changed with `PRICE_CURRENCY`.
- DB auth is currently password-based (`DB_PASS` required).
- Stripe Checkout requires `APP_BASE_URL`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET`.
- `STRIPE_TAX_CODE` is optional. If set, it is sent on each Checkout line item as `price_data.product_data.tax_code`.
- Commission email delivery requires SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`).
- For Gmail, you can instead set `SMTP_SERVICE=gmail` plus `SMTP_USER` and `SMTP_PASS` (Google App Password). In that mode, `SMTP_HOST` is optional.
- `COMMISSION_FROM_EMAIL` and `COMMISSION_BUSINESS_EMAIL` default to `soggystitches@gmail.com`.

## Local Stripe testing

With the Stripe CLI (replace the port if you run Functions Framework on a different one):

```bash
stripe listen --forward-to localhost:8080/api/stripe/webhook
```

Use the printed webhook signing secret to populate `STRIPE_WEBHOOK_SECRET` in `.env`.

Trigger a sample event:

```bash
stripe trigger checkout.session.completed
```

For end-to-end local testing, create a real checkout session via `POST /api/checkout/session`, open the returned `checkoutUrl`, and complete payment using Stripe test cards.
