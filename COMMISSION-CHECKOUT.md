# Commission checkout and shipping

`commissions.total_cost` is the item subtotal in cents, before shipping and tax.
Final checkout credits the sum of paid commitment order lines, not the current
`commitment_deposit_amount` setting. Stripe calculates tax on the remaining item
balance and selected shipping, using the existing checkout configuration.

## Lifecycle

1. A quote email takes the customer to `/commission/:id`. A paid commitment
   changes the commission to `committed`. Quotes without an upfront payment can
   be confirmed on the same page. Legacy `customer_committed` values are migrated.
2. Workers enter package weight (lb) and dimensions (in), then save `ready_to_ship`.
   The email shows the item subtotal, payment already received, and remaining
   balance. Its checkout button takes the customer to the commission page.
3. The customer adds the finished commission to the normal cart, selects shipping
   or market pickup, and starts checkout. The backend creates a `pending_payment`
   order before creating the Stripe Checkout Session.
4. `order_items.product_id` links to `commissions.id`; `product_kind` distinguishes
   `commission_commitment` from `commission_final`. This snapshot persists even
   when a worker edits the quote. The admin commission editor and Orders screen
   provide links in both directions.
5. Confirmed payment changes the commission to `payment_received`. An order
   containing only finished commissions and nonphysical items becomes
   `ready_to_ship`; mixed orders retain the standard production workflow.
6. Workers enter carrier/tracking in **Orders → Mark shipped**. The database
   trigger updates the linked commission to `shipped` and sets its ship date.
   The existing `soggy-integrations` order notification sends the tracking email.
   Pickup/delivery fulfillment also synchronizes the commission.

## Retry and concurrency behavior

- **Send / retry customer email** works without changing commission status.
  Successful identical quote/final-checkout emails are deduplicated; failed
  attempts can be retried. SMTP acceptance is recorded, not inbox delivery.
- Orders retains its existing fulfillment-notification retry action. Failed or
  skipped notifications are reported after marking an order shipped.
- Commission checkout claims prevent overlapping sessions for the same stage.
  Starting a replacement checkout expires the previous open Stripe session.
  Completed sessions awaiting payment reconciliation cannot be replaced.
- Checkout validates the commission stage and amount again under a database lock.
  Paid final commissions cannot be purchased again even if their status is reset.
- Stripe `checkout.session.completed` and `checkout.session.async_payment_succeeded`
  are reconciled only with `paid` or `no_payment_required` payment status.
- The admin editor rejects stale saves so an open screen cannot overwrite a
  newer payment or shipment status.

## Rollout

Apply `sql-util/commission-checkout-migration.sql` to the shared database **before**
deploying these changes. It expects the digital-assets and order-tracking-workflow
migrations already to be applied. It adds package data, email-delivery records,
checkout claims, the final-purchase kind, and the order/commission shipping trigger.
Then deploy `soggy-backend`, `soggy-admin-backend`, `soggy-stitches`, and `soggy-admin`.
Keep the existing `soggy-integrations` service configured for shipping notifications.
Ensure Stripe's webhook subscription includes `checkout.session.async_payment_succeeded`
and `checkout.session.async_payment_failed` as well as `checkout.session.completed`.

Existing ready-to-ship commissions need package measurements entered before
carrier shipping quotes can work. Historical deposits must have their paid order
lines recorded as `commission_commitment` to receive credit. Status alone is not
evidence of payment; payments made outside this checkout are not inferred.

## Verification

`npm test` runs the unit and signed-webhook tests. For the database regression,
create a disposable PostgreSQL database named `soggy_commission_test` and run:

```sh
COMMISSION_TEST_DATABASE_URL=postgresql://127.0.0.1:55439/soggy_commission_test npm test
```

That regression initializes the disposable schema and exercises deposit payment,
final order creation, stale/duplicate checkout rejection, final payment,
shipping synchronization, repeated payment events, and email retry/deduplication.
It also checks the sibling `soggy-admin-backend` commission update model.
It does not send email or contact Stripe/carriers.
