# Product + Cart Cloud Functions

Node.js HTTP Cloud Functions for product retrieval and shopping cart CRUD backed by Cloud SQL Postgres.

## API routes (single service)

Run/deploy one HTTP function and route by path:

- Product: `GET /products/:id`
- Commission details: `GET /products/commissions?commission_id=:id`
- Markets: `GET /markets`
- Cart:
  - `POST /cart` (server generates `sessionId`; `/cart/:sessionId` also accepted)
  - `GET|PUT|DELETE /cart/:sessionId`
- Commission form: `POST /api/commission/form`
- Order lookup: `GET /api/orders/:id`
- Checkout: `POST /api/checkout/session`
- Shipping quote: `POST /api/shipping/quote`
- Stripe webhook: `POST /api/stripe/webhook`

Legacy exports `getProduct` and `cartService` still exist, but both now point to the same routed handler.

## Product endpoint

- `GET /products/:id`
- `GET /?id=:id` (fallback format for direct function URLs)

Success response shape matches `contract/get-products-id-response.json`.

## Markets endpoint

- `GET /markets`
- `GET /api/markets`

Returns all rows from the `markets` table ordered by `start_time` ascending. Each
row includes the stable `market_id` as both `id` and `marketId`, plus the legacy
display fields.

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
  "channel": "online",
  "shippingDetails": {
    "name": "Test Customer",
    "line1": "210 Peachtree St NW",
    "line2": "",
    "city": "Atlanta",
    "state": "GA",
    "postalCode": "30303",
    "country": "US"
  }
}
```

Market pickup request body:

```json
{
  "cartSessionId": "sess_123",
  "channel": "online",
  "shippingMethod": "market",
  "shippingDetails": {
    "market_id": "soggy_spring_craft_market_20260516t140000z",
    "name": "Test Customer"
  }
}
```

Behavior notes:

- Reads cart items and product pricing from Postgres (client prices are ignored).
- Creates a pending `orders` + `order_items` snapshot in Postgres before calling Stripe Checkout.
- For online orders with physical items, requires `shippingDetails`, calls the UPS Rating API, and persists the cheapest live UPS option on the order snapshot.
- Uses inline Stripe `price_data.product_data` (no Stripe Product/Price setup required).
- Creates a Stripe Customer with the pre-collected shipping address so hosted Checkout can stay focused on payment while Stripe Tax still has a shipping destination to work from.
- Adds the quoted UPS method as a fixed Stripe shipping option, preserving the exact service name shown to the customer.
- Enables Stripe automatic tax and applies optional `STRIPE_TAX_CODE` to each merchandise line item.
- Attempts to attach the first image found under `STRIPE_THUMBNAILS_GCS_BUCKET/<product_id>/` as the Stripe Checkout product image.
- Returns both `checkoutUrl` and `orderId`.
- Market pickup checkout validates the selected event by `shippingDetails.market_id`
  when present. Legacy address + `start_time` validation remains supported during
  the UI rollout.

## Shipping quote endpoint

- `POST /api/shipping/quote`

Request body:

```json
{
  "cartSessionId": "sess_123",
  "shippingDetails": {
    "name": "Test Customer",
    "line1": "210 Peachtree St NW",
    "line2": "",
    "city": "Atlanta",
    "state": "GA",
    "postalCode": "30303",
    "country": "US"
  }
}
```

Behavior notes:

- Reads cart items and product shipping dimensions/weight from Postgres.
- Packs the cart into a single estimated shipment using a soft-goods compression heuristic.
- Calls the UPS OAuth token endpoint with `UPS_CLIENT_ID` + `UPS_CLIENT_SECRET`.
- Calls the UPS Rating `Shop` endpoint and returns only the cheapest valid option.
- Returns `shippingRequired: false` when the cart only contains non-shippable commission commitment items.

## Order lookup endpoint

- `GET /api/orders/:id`

Returns the persisted order snapshot from Postgres, including:

- order status
- currency and totals
- created/updated timestamps
- the order item snapshot used for Stripe Checkout
- persisted shipping method, amount, address, and quote metadata when available

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

## Commission follow-up email endpoints

- `POST /commissions/commit`
- `POST /api/commissions/commit`
- `POST /commission/finalize`
- `POST /api/commission/finalize`

Request body:

```json
{
  "commissionId": "cm_123"
}
```

Behavior notes:

- Both endpoints look up the commission by `commissionId`.
- Customer email is loaded from the stored `meta.json` in Cloud Storage using the commission row's `storage_bucket` + `meta_path`.
- `POST /commissions/commit` sends the quote/commit email, includes `total_cost`, and calculates the estimated completion date from the current date plus `time_cost` days.
- `POST /commission/finalize` sends the finished-order/final checkout email and includes `total_cost`.

## Commission details endpoint

- `GET /products/commissions?commission_id=:id`
- `GET /api/products/commissions?commission_id=:id`

Returns the customer-safe commission details needed to render the frontend commit-review page, including:

- `item_name`
- `item_description`
- `yarn_type`
- `yarn_color`
- `attachment_material_type`
- `status`
- `time_cost`
- `ship_date`
- `total_cost`
- `requires_commit`

## Stripe webhook endpoint

- `POST /api/stripe/webhook`

This endpoint verifies `Stripe-Signature` using the raw request body (`req.rawBody`) and `STRIPE_WEBHOOK_SECRET`. On `checkout.session.completed`, it marks the order as `paid`, stores Stripe IDs, decrements inventory in a transaction with idempotent status checks, and sends a customer confirmation email using the email present on the Checkout Session payload without persisting that email locally.

## Files

- `index.js`: Cloud Function export(s), including routed `api`
- `src/handlers/apiHandler.js`: path-based router for product/cart/market endpoints
- `src/handlers/getProductHandler.js`: HTTP request handling
- `src/handlers/getCommissionHandler.js`: customer-facing commission detail lookup
- `src/models/productModel.js`: SQL query + schema-to-contract mapping
- `src/handlers/marketHandler.js`: market list HTTP handling
- `src/models/marketModel.js`: market list SQL query + response mapping
- `src/handlers/cartHandler.js`: cart CRUD HTTP handling
- `src/models/cartModel.js`: cart CRUD SQL operations
- `src/handlers/commissionFormHandler.js`: commission form intake + email delivery
- `src/models/commissionModel.js`: non-PII commission persistence
- `src/lib/commissionEmailTemplates.js`: HTML email rendering for customer/business messages
- `src/lib/mailer.js`: SMTP mail transport
- `src/handlers/checkoutHandler.js`: Stripe Checkout Session creation from DB cart state
- `src/handlers/shippingQuoteHandler.js`: UPS shipping quote lookup from DB cart state
- `src/handlers/orderHandler.js`: order summary lookup for checkout return pages
- `src/handlers/stripeWebhookHandler.js`: Stripe webhook signature verification + payment reconciliation
- `src/models/orderModel.js`: order persistence and transactional payment finalization
- `src/lib/shippingQuote.js`: shipping address normalization, package estimation, and quote selection
- `src/lib/upsClient.js`: UPS OAuth token + Rating API client
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

For the local Docker-backed flow used with the main site in `~/soggy-stitches`, set the DB connection in `.env` to TCP and point checkout redirects at the frontend:

```dotenv
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASS=woofins
DB_NAME=postgres
APP_BASE_URL=http://localhost:3000
```

If you only run the backend by itself, `APP_BASE_URL=http://localhost:8080` is fine. Checkout, shipping, Stripe webhook, UPS, and SMTP env vars are only needed for those corresponding endpoints.

3. Start Postgres locally (fresh local setup):

```bash
docker volume create soggy-postgres-dev-data
docker run -d \
  --name soggy-postgres-dev \
  -e POSTGRES_PASSWORD=woofins \
  -e POSTGRES_DB=postgres \
  -p 5432:5432 \
  -v soggy-postgres-dev-data:/var/lib/postgresql/data \
  postgres:16
```

Set a shell-local `DATABASE_URL` for `psql`:

```bash
export DATABASE_URL=postgresql://postgres:woofins@127.0.0.1:5432/postgres
```

4. Load the schema.

Fresh local catalog database:

```bash
psql "$DATABASE_URL" -f product-schema.sql
psql "$DATABASE_URL" -f cart-schema.sql
psql "$DATABASE_URL" -f commission-schema.sql
psql "$DATABASE_URL" -f order-schema.sql
psql "$DATABASE_URL" -f sql-util/product-inserts.sql
psql "$DATABASE_URL" -f sql-util/catalog-schema-migration.sql
psql "$DATABASE_URL" -f sql-util/catalog-dev-seed.sql
```

Existing database upgrade path:

```bash
psql "$DATABASE_URL" -f sql-util/commission-form-migration.sql
psql "$DATABASE_URL" -f sql-util/stripe-checkout-migration.sql
psql "$DATABASE_URL" -f sql-util/ups-shipping-migration.sql
psql "$DATABASE_URL" -f sql-util/catalog-schema-migration.sql
```

If your database already has checkout orders and you only need the new canceled-checkout status:

```bash
psql "$DATABASE_URL" -f sql-util/checkout-cancelled-status-migration.sql
```

`sql-util/catalog-dev-seed.sql` is optional, but it is the quickest way to get local category/tag/attribute/variant data for the updated product pages.

5. Run locally:

```bash
npm start
```

This serves both `/products/...` and `/cart/...` from the same local process.

`npm run dev:debug` is available if you explicitly want framework debug behavior during local troubleshooting.

6. If you are also running the main site from `~/soggy-stitches`, point it at this backend:

```bash
cd ~/soggy-stitches
PRODUCTS_API_BASE_URL=http://localhost:8080 npm run dev
```

The frontend local product pages should then load from this backend at `http://localhost:3000`.

7. Example requests:

```bash
curl "http://localhost:8080/?id=prod_123"
curl "http://localhost:8080/api/products/moon-bunny-plush"
```

Optional cleanup:

```bash
docker stop soggy-postgres-dev
docker rm -f soggy-postgres-dev
docker volume rm soggy-postgres-dev-data
```

## Deploy to Cloud Functions (Gen 2)

Use the included script:

```bash
PROJECT_ID="your-project-id" \
REGION="us-central1" \
ALLOW_UNAUTHENTICATED="true" \
DB_USER_SECRET="DB_USER" \
DB_PASS_SECRET="DB_PASS" \
DB_NAME_SECRET="DB_NAME" \
INSTANCE_CONNECTION_NAME_SECRET="INSTANCE_CONNECTION_NAME" \
SMTP_PASS_SECRET="SMTP_PASS" \
STRIPE_SECRET_KEY_SECRET="STRIPE_SECRET_KEY" \
STRIPE_WEBHOOK_SECRET_SECRET="STRIPE_WEBHOOK_SECRET" \
./deploy.sh
```

By default, the script assumes these Secret Manager secret names match the environment variable names and uses the `latest` version:

- `DB_USER`
- `DB_PASS`
- `DB_NAME`
- `INSTANCE_CONNECTION_NAME`
- `SMTP_PASS`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

Override the secret names with `*_SECRET` vars if your secret names differ. You can also set `SECRET_VERSION` to use a version other than `latest`.

In this repo's checked-in [`deploy-setup.sh`](/home/anaiah/soggy-cloud-functions/deploy-setup.sh), the project defaults are currently:

- `STRIPE_SECRET_KEY_SECRET=STRIPE_LIVE_KEY`
- `STRIPE_WEBHOOK_SECRET_SECRET=STRIPE_CHECKOUT_WEBHOOK_SECRET`

The deployed Cloud Function service account must have `roles/secretmanager.secretAccessor` on those secrets.

Stripe webhooks require the HTTP function to accept unauthenticated requests. In this repo's checked-in [`deploy-setup.sh`](/home/anaiah/soggy-cloud-functions/deploy-setup.sh), `ALLOW_UNAUTHENTICATED=true` is enabled so Stripe can reach `/api/stripe/webhook`.

If you use direct TCP instead of Cloud SQL sockets, set `DB_HOST` (and optional `DB_PORT`); in that mode the deploy script will skip `INSTANCE_CONNECTION_NAME`.

To deploy the unified API service, set `ENTRY_POINT=api` (recommended). Existing `getProduct` and `cartService` entry points are aliases to the same routed handler.

## Notes

- Currency in the response defaults to `USD` and can be changed with `PRICE_CURRENCY`.
- DB auth is currently password-based, but deploys now inject `DB_USER`, `DB_PASS`, `DB_NAME`, and `INSTANCE_CONNECTION_NAME` from Secret Manager.
- Stripe Checkout requires `APP_BASE_URL`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET`.
- The deploy script injects `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` from Secret Manager.
- `STRIPE_TAX_CODE` is optional. If set, it is sent on each Checkout line item as `price_data.product_data.tax_code`.
- `STRIPE_SHIPPING_ALLOWED_COUNTRIES` controls which checkout destinations are supported. It defaults to `US`.
- `STRIPE_SHIPPING_TAX_CODE` defaults to Stripe's standard shipping tax code (`txcd_92010001`) and applies to the generated shipping rate.
- UPS checkout shipping requires `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET`, `UPS_SHIPPER_NUMBER`, and `SHIP_FROM_ADDRESS`.
- `SHIP_FROM_ADDRESS` should be stored as JSON in Secret Manager and include the ship-from name plus line1/city/state/postalCode/country.
- `UPS_CUSTOMER_CLASSIFICATION` defaults to `04` for retail-location pricing, and `UPS_PICKUP_TYPE` defaults to `03` for counter drop-off style rating. Keep both configurable because a future account-billed label-purchase flow may need different values.
- The quote packer assumes soft goods and compresses height by `UPS_COMPRESSION_RATIO` (default `0.8`) with `UPS_PACKAGE_PADDING_INCHES` (default `0.5`) added back for a safer carton estimate.
- `STRIPE_THUMBNAILS_GCS_BUCKET` defaults to `soggy-thumbnails`.
- Commission email delivery requires SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`). The deploy script injects `SMTP_PASS` from Secret Manager.
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
