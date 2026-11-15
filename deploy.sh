#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_SCRIPT="${SCRIPT_DIR}/deploy-setup.sh"

# Deploy target:
#   ./deploy.sh            -> private `api` function (Cloud Run IAM: API_INVOKER_MEMBERS only)
#   ./deploy.sh webhook    -> public `stripeWebhook` function (Stripe signature-verified, webhook path only)
# DRY_RUN=true prints the gcloud commands instead of running them.
DEPLOY_TARGET="${1:-api}"
case "${DEPLOY_TARGET}" in
  api)
    ;;
  webhook)
    export FUNCTION_NAME="${WEBHOOK_FUNCTION_NAME:-stripe-webhook}"
    export ENTRY_POINT="stripeWebhook"
    ;;
  *)
    echo "Usage: $0 [api|webhook]" >&2
    exit 2
    ;;
esac

if [[ -f "${SETUP_SCRIPT}" ]]; then
  # Load project-specific deploy defaults into the current shell before computing args.
  # shellcheck disable=SC1090
  source "${SETUP_SCRIPT}"
fi

PROJECT_ID="${PROJECT_ID:-soggy-stitches}"
FUNCTION_NAME="${FUNCTION_NAME:-products}"
ENTRY_POINT="${ENTRY_POINT:-api}"
REGION="${REGION:-us-east1}"
RUNTIME="${RUNTIME:-nodejs22}"
DRY_RUN="${DRY_RUN:-false}"
MAX_INSTANCE_COUNT="${MAX_INSTANCE_COUNT:-8}"

# Public access is decided by the entry point, never by a free-floating flag: only the
# webhook-only entry point may be public. Every other entry point exposes the whole API.
if [[ "${ENTRY_POINT}" == "stripeWebhook" ]]; then
  ALLOW_UNAUTHENTICATED="true"
  # Each instance holds up to DB_POOL_MAX connections to a db-f1-micro; webhook traffic is
  # light, so keep it from competing with the API for connection slots.
  MAX_INSTANCE_COUNT="${WEBHOOK_MAX_INSTANCE_COUNT:-2}"
else
  if [[ "${ALLOW_UNAUTHENTICATED:-false}" == "true" ]]; then
    echo "Refusing to deploy entry point '${ENTRY_POINT}' with unauthenticated access." >&2
    echo "Only the Stripe webhook is public: use './deploy.sh webhook'." >&2
    exit 1
  fi
  ALLOW_UNAUTHENTICATED="false"
  # Who may invoke the private API (space-separated IAM members). The storefront's Cloud Run
  # service account calls it with Google ID tokens (soggy-stitches/lib/internalFetch.ts).
  if [[ -z "${API_INVOKER_MEMBERS:-}" ]]; then
    echo "API_INVOKER_MEMBERS is empty; the storefront would lose access. Set it in deploy-setup.sh." >&2
    exit 1
  fi
fi
FUNCTION_MEMORY="${FUNCTION_MEMORY:-512Mi}"
SECRET_VERSION="${SECRET_VERSION:-latest}"
DB_USER_SECRET="${DB_USER_SECRET:-DB_USER}"
DB_PASS_SECRET="${DB_PASS_SECRET:-DB_PASS}"
DB_NAME_SECRET="${DB_NAME_SECRET:-DB_NAME}"
INSTANCE_CONNECTION_NAME_SECRET="${INSTANCE_CONNECTION_NAME_SECRET:-INSTANCE_CONNECTION_NAME}"
DB_IAM_AUTH="${DB_IAM_AUTH:-true}"
DB_IAM_USER="${DB_IAM_USER:-soggy-backend@${PROJECT_ID}.iam}"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:-soggy-backend@${PROJECT_ID}.iam.gserviceaccount.com}"
NETWORK="${NETWORK:-default}"
SUBNET="${SUBNET:-default}"
DIRECT_VPC_EGRESS="${DIRECT_VPC_EGRESS:-private-ranges-only}"
SMTP_PASS_SECRET="${SMTP_PASS_SECRET:-SMTP_PASS}"
STRIPE_SECRET_KEY_SECRET="${STRIPE_SECRET_KEY_SECRET:-STRIPE_SECRET_KEY}"
STRIPE_WEBHOOK_SECRET_SECRET="${STRIPE_WEBHOOK_SECRET_SECRET:-STRIPE_WEBHOOK_SECRET}"
UPS_CLIENT_ID_SECRET="${UPS_CLIENT_ID_SECRET:-UPS_CLIENT_ID}"
UPS_CLIENT_SECRET_SECRET="${UPS_CLIENT_SECRET_SECRET:-UPS_CLIENT_SECRET}"
UPS_SHIPPER_NUMBER_SECRET="${UPS_SHIPPER_NUMBER_SECRET:-UPS_SHIPPER_NUMBER}"
USPS_CONSUMER_KEY_SECRET="${USPS_CONSUMER_KEY_SECRET:-USPS_CONSUMER_KEY}"
USPS_CONSUMER_SECRET_SECRET="${USPS_CONSUMER_SECRET_SECRET:-USPS_CONSUMER_SECRET}"
SHIPPING_QUOTE_SIGNING_SECRET_SECRET="${SHIPPING_QUOTE_SIGNING_SECRET_SECRET:-SHIPPING_QUOTE_SIGNING_SECRET}"
SHIP_FROM_ADDRESS_SECRET="${SHIP_FROM_ADDRESS_SECRET:-SHIP_FROM_ADDRESS}"
DIGITAL_ACCESS_HASH_SALT_SECRET="${DIGITAL_ACCESS_HASH_SALT_SECRET:-DIGITAL_ACCESS_HASH_SALT}"
SECRET_ENV_KEYS=(
  "DB_USER"
  "DB_PASS"
  "DB_NAME"
  "INSTANCE_CONNECTION_NAME"
  "SMTP_PASS"
  "STRIPE_SECRET_KEY"
  "STRIPE_WEBHOOK_SECRET"
  "UPS_CLIENT_ID"
  "UPS_CLIENT_SECRET"
  "UPS_SHIPPER_NUMBER"
  "USPS_CONSUMER_KEY"
  "USPS_CONSUMER_SECRET"
  "SHIPPING_QUOTE_SIGNING_SECRET"
  "SHIP_FROM_ADDRESS"
  "DIGITAL_ACCESS_HASH_SALT"
)

join_by() {
  local delimiter="$1"
  shift
  local IFS="${delimiter}"
  printf '%s' "$*"
}

format_gcloud_dict_arg() {
  local delimiter="^#^"
  printf '%s%s' "${delimiter}" "$(join_by "#" "$@")"
}

append_env_var_if_set() {
  local key="$1"
  local value="${!key-}"

  if [[ -n "${value}" ]]; then
    ENV_VARS+=("${key}=${value}")
  fi
}

secret_ref() {
  local secret_name="$1"

  if [[ "${secret_name}" == projects/* ]]; then
    printf '%s' "${secret_name}"
    return 0
  fi

  if [[ "${secret_name}" == *:* ]]; then
    printf '%s' "${secret_name}"
    return 0
  fi

  printf '%s:%s' "${secret_name}" "${SECRET_VERSION}"
}

ENV_VARS=()
SECRET_VARS=(
  "DB_NAME=$(secret_ref "${DB_NAME_SECRET}")"
  "SMTP_PASS=$(secret_ref "${SMTP_PASS_SECRET}")"
  "STRIPE_SECRET_KEY=$(secret_ref "${STRIPE_SECRET_KEY_SECRET}")"
  "STRIPE_WEBHOOK_SECRET=$(secret_ref "${STRIPE_WEBHOOK_SECRET_SECRET}")"
  "UPS_CLIENT_ID=$(secret_ref "${UPS_CLIENT_ID_SECRET}")"
  "UPS_CLIENT_SECRET=$(secret_ref "${UPS_CLIENT_SECRET_SECRET}")"
  "UPS_SHIPPER_NUMBER=$(secret_ref "${UPS_SHIPPER_NUMBER_SECRET}")"
  "USPS_CONSUMER_KEY=$(secret_ref "${USPS_CONSUMER_KEY_SECRET}")"
  "USPS_CONSUMER_SECRET=$(secret_ref "${USPS_CONSUMER_SECRET_SECRET}")"
  "SHIPPING_QUOTE_SIGNING_SECRET=$(secret_ref "${SHIPPING_QUOTE_SIGNING_SECRET_SECRET}")"
  "SHIP_FROM_ADDRESS=$(secret_ref "${SHIP_FROM_ADDRESS_SECRET}")"
  "DIGITAL_ACCESS_HASH_SALT=$(secret_ref "${DIGITAL_ACCESS_HASH_SALT_SECRET}")"
)
REMOVE_SECRET_KEYS=()

if [[ "${DB_IAM_AUTH}" == "true" ]]; then
  REMOVE_SECRET_KEYS+=("DB_USER" "DB_PASS" "INSTANCE_CONNECTION_NAME")
else
  SECRET_VARS+=(
    "DB_USER=$(secret_ref "${DB_USER_SECRET}")"
    "DB_PASS=$(secret_ref "${DB_PASS_SECRET}")"
  )
fi

OPTIONAL_ENV_KEYS=(
  "PRICE_CURRENCY"
  "DB_SOCKET_PATH"
  "DB_SSL"
  "DB_POOL_MAX"
  "DB_IDLE_TIMEOUT_MS"
  "DB_CONNECTION_TIMEOUT_MS"
  "MAX_CART_QTY"
  "MAX_CART_WORK_DAYS"
  "APP_BASE_URL"
  "GCP_PROJECT_ID"
  "DIGITAL_ASSETS_BUCKET"
  "DIGITAL_ACCESS_DAYS"
  "DIGITAL_DOWNLOAD_LIMIT"
  "DIGITAL_SIGNED_URL_SECONDS"
  "STRIPE_TAX_CODE"
  "STRIPE_SHIPPING_ALLOWED_COUNTRIES"
  "STRIPE_SHIPPING_TAX_CODE"
  "STRIPE_THUMBNAILS_GCS_BUCKET"
  "UPS_BASE_URL"
  "UPS_RATE_VERSION"
  "UPS_PICKUP_TYPE"
  "UPS_CUSTOMER_CLASSIFICATION"
  "UPS_PACKAGING_TYPE"
  "UPS_PACKAGE_BILL_TYPE"
  "UPS_COMPRESSION_RATIO"
  "UPS_PACKAGE_PADDING_INCHES"
  "UPS_TIMEOUT_MS"
  "USPS_BASE_URL"
  "USPS_SERVICE_STANDARDS_BASE_URL"
  "USPS_PROCESSING_CATEGORY"
  "USPS_RATE_INDICATOR"
  "USPS_DESTINATION_ENTRY_FACILITY_TYPE"
  "USPS_PRICE_TYPE"
  "USPS_MAIL_CLASSES"
  "USPS_TIMEOUT_MS"
  "SHIPPING_QUOTE_TTL_SECONDS"
  "SHIPPING_PROVIDER_DEADLINE_MS"
  "COMMISSION_GCS_BUCKET"
  "COMMISSION_FROM_EMAIL"
  "COMMISSION_BUSINESS_EMAIL"
  "COMMISSION_COMPANY_NAME"
  "COMMISSION_EMAIL_HEADER_IMAGE_URL"
  "SMTP_SERVICE"
  "SMTP_HOST"
  "SMTP_PORT"
  "SMTP_SECURE"
  "SMTP_USER"
)

for key in "${OPTIONAL_ENV_KEYS[@]}"; do
  append_env_var_if_set "${key}"
done

if [[ -n "${DB_HOST:-}" ]]; then
  DB_PORT="${DB_PORT:-5432}"
  ENV_VARS+=("DB_HOST=${DB_HOST}" "DB_PORT=${DB_PORT}")
else
  INSTANCE_CONNECTION_NAME="${INSTANCE_CONNECTION_NAME:-$(gcloud secrets versions access "${SECRET_VERSION}" --secret="${INSTANCE_CONNECTION_NAME_SECRET}" --project="${PROJECT_ID}")}"
  ENV_VARS+=("INSTANCE_CONNECTION_NAME=${INSTANCE_CONNECTION_NAME}")
fi

ENV_VARS+=("DB_IAM_AUTH=${DB_IAM_AUTH}")
if [[ "${DB_IAM_AUTH}" == "true" ]]; then
  ENV_VARS+=("DB_IAM_USER=${DB_IAM_USER}")
fi

DEPLOY_ARGS=(
  gcloud functions deploy "${FUNCTION_NAME}"
  --gen2
  --project="${PROJECT_ID}"
  --region="${REGION}"
  --runtime="${RUNTIME}"
  --source="."
  --entry-point="${ENTRY_POINT}"
  --trigger-http
  --max-instances="${MAX_INSTANCE_COUNT}"
  --memory="${FUNCTION_MEMORY}"
  --run-service-account="${RUNTIME_SERVICE_ACCOUNT}"
  --network="${NETWORK}"
  --subnet="${SUBNET}"
  --direct-vpc-egress="${DIRECT_VPC_EGRESS}"
  "--$( [[ "${ALLOW_UNAUTHENTICATED}" == "true" ]] && printf 'allow' || printf 'no-allow' )-unauthenticated"
  --remove-env-vars="$(join_by , "${SECRET_ENV_KEYS[@]}")"
  --update-secrets="$(join_by , "${SECRET_VARS[@]}")"
)

if [[ ${#REMOVE_SECRET_KEYS[@]} -gt 0 ]]; then
  DEPLOY_ARGS+=(--remove-secrets="$(join_by , "${REMOVE_SECRET_KEYS[@]}")")
fi

if [[ ${#ENV_VARS[@]} -gt 0 ]]; then
  DEPLOY_ARGS+=(--update-env-vars="$(format_gcloud_dict_arg "${ENV_VARS[@]}")")
fi

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

run "${DEPLOY_ARGS[@]}"

# A gen2 function is a Cloud Run service with the same name. `--no-allow-unauthenticated`
# only declines to ADD a public binding; it does not remove an existing one. So for the
# private API, explicitly remove public members and (re)grant the intended invokers.
if [[ "${ALLOW_UNAUTHENTICATED}" != "true" ]]; then
  RUN_SERVICE_ARGS=(--project="${PROJECT_ID}" --region="${REGION}")

  for member in ${API_INVOKER_MEMBERS}; do
    run gcloud run services add-iam-policy-binding "${FUNCTION_NAME}" "${RUN_SERVICE_ARGS[@]}" \
      --member="${member}" --role="roles/run.invoker" --quiet --format=none
  done

  if [[ "${DRY_RUN}" == "true" ]]; then
    CURRENT_INVOKERS="allUsers allAuthenticatedUsers"
  else
    # Fails the script (set -e) if the policy can't be read, rather than assuming it's private.
    CURRENT_INVOKERS="$(gcloud run services get-iam-policy "${FUNCTION_NAME}" "${RUN_SERVICE_ARGS[@]}" \
      --flatten="bindings[].members" \
      --filter="bindings.role=roles/run.invoker" \
      --format="value(bindings.members)")"
  fi

  for public_member in allUsers allAuthenticatedUsers; do
    if grep -qxw "${public_member}" <<<"$(tr ' ' '\n' <<<"${CURRENT_INVOKERS}")"; then
      run gcloud run services remove-iam-policy-binding "${FUNCTION_NAME}" "${RUN_SERVICE_ARGS[@]}" \
        --member="${public_member}" --role="roles/run.invoker" --quiet --format=none
      echo "Removed public invoker '${public_member}' from ${FUNCTION_NAME}."
    fi
  done

  echo "${FUNCTION_NAME} is private. Invokers: ${API_INVOKER_MEMBERS}"
fi
