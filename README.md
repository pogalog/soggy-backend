# Product + Cart Cloud Functions

Node.js HTTP Cloud Functions for product retrieval and shopping cart CRUD backed by Cloud SQL Postgres.

## API routes (single service)

Run/deploy one HTTP function and route by path:

- Product: `GET /products/:id`
- Cart:
  - `POST /cart` (server generates `sessionId`; `/cart/:sessionId` also accepted)
  - `GET|PUT|DELETE /cart/:sessionId`

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

## Files

- `index.js`: Cloud Function export(s), including routed `api`
- `src/handlers/apiHandler.js`: path-based router for product/cart endpoints
- `src/handlers/getProductHandler.js`: HTTP request handling
- `src/models/productModel.js`: SQL query + schema-to-contract mapping
- `src/handlers/cartHandler.js`: cart CRUD HTTP handling
- `src/models/cartModel.js`: cart CRUD SQL operations
- `cart-schema.sql`: cart table schema
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

3. Run locally:

```bash
npm start
```

This serves both `/products/...` and `/cart/...` from the same local process.

`npm run dev:debug` is available if you explicitly want framework debug behavior during local troubleshooting.

4. Example request:

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
