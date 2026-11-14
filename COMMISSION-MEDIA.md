# Finished commission photos

## Storage and access recommendation

Keep `soggy-commission-requests` private. No new bucket, public ACLs, `allUsers` grant, or expiring customer signed URLs are needed.

Finished photos use `<existing upload_directory>/finished/<random photo UUID>/`:

- `original`: original upload, never served to customers.
- `display.jpg`: auto-oriented, metadata-stripped, watermarked JPEG, at most 2000 px per side.
- `email.jpg`: watermarked JPEG, at most 800 px per side and 512 KiB.

`commission_product_images` stores the owning commission and the three object paths separately from customer references in `commissions.storage_images`. Legacy requests without an upload directory reuse the metadata directory, or get `commissions/<commission ID>` if no existing directory is available.

Admin media routes use the existing worker session and backend IAM protection. Customer image routes take a commission ID and a random photo UUID, look up **only** finished-photo records belonging to that commission, and serve only the display JPEG. They do not accept a bucket or object path. Images become available at `ready_to_ship` (including legacy `read_to_ship`) and remain available for `payment_received`, `shipped`, and `closed`. Earlier/cancelled stages and deleted photos return no customer media. Customer reference images and `meta.json` are never included.

As with the existing customer commission review page, this is **access by possession of a private link**, not customer-account authentication. Anyone given the commission link can view the finished photos once published. Responses use `private, no-store` and `noindex`; the customer gallery bypasses the public Next image optimizer. If strict recipient-only access is required later, add authentication or a separate customer access token to both the review page and image routes.

Required service-account permissions on this bucket (verify existing grants before adding any):

- Admin backend runtime: `storage.objects.create`, `storage.objects.get`, `storage.objects.delete` (a scoped custom role, or bucket-level Storage Object User).
- Customer backend runtime: `storage.objects.get` for rendering images and loading email copies (already needs read access for commission metadata).
- No browser, customer, or public principal receives direct bucket access. Frontends use their existing backend invoker permissions.

Keep the admin backend non-public; worker authorization is enforced by the admin frontend's existing authenticated proxy. No cloud IAM changes are made by this feature.

## Maker workflow

1. General contains request identifiers, customer-supplied details, timestamps and reference images. Empty references use one short message.
2. Manage contains status, requires-commit, time cost, deposit, item subtotal, package weight/dimensions, ship date, checkout/email controls and save/delete actions. Unsaved edits survive tab switches.
3. Media uploads/removes finished photos immediately, independently of the management draft. The existing multipart upload and product watermark processing are reused. Multiple files upload sequentially with per-file errors. Up to 12 photos are supported; the existing product upload byte limit also applies.
4. Upload photos **before** saving Ready to Ship. The existing ready-email action includes the current photos. Uploading later updates the page but does not automatically resend email; use the existing Send / retry email control to send the changed content. If all photos are unchanged, the existing email deduplication applies.

The ready email includes a framed “Take a look at what we made for you!” section with CID inline attachments. These are embedded message copies, not signed URLs. No photos means no empty frame. Image download failure prevents sending an incomplete ready email and can be retried through the existing control. Removing a photo revokes site access and deletes its stored objects, but cannot recall copies already delivered by email. Email-client rendering still varies; the existing checkout/page link is always provided.

## Rollout

1. Apply `sql-util/commission-media-migration.sql` to the shared database **before either backend**. It is additive and rerunnable.
2. Verify the bucket permissions above and existing private backend invoker configuration.
3. Deploy `soggy-admin-backend` and `soggy-backend`, then `soggy-admin` and `soggy-stitches`.
4. Use an internal test commission: upload photos while in progress; verify worker preview works but customer preview is hidden. Set Ready to Ship and check the received email and gallery. Remove a test photo and check its site URL no longer works. Verify a commission with no photos still gets its normal ready email.

Tests: `npm test` in both backends. PostgreSQL integration tests use only a disposable database named `soggy_commission_test`; initialize the existing commission/order schemas and checkout migration first, then run `COMMISSION_TEST_DATABASE_URL=postgresql://127.0.0.1:55439/soggy_commission_test npm test`. Never point these tests at production. Email MIME tests use Nodemailer's local stream transport, not SMTP.

References: [Nodemailer inline images](https://nodemailer.com/message/embedded-images), [Cloud Storage access control](https://docs.cloud.google.com/storage/docs/access-control).
