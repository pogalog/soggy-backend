#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_SCRIPT="${SCRIPT_DIR}/deploy-setup.sh"

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
ALLOW_UNAUTHENTICATED="${ALLOW_UNAUTHENTICATED:-false}"
SECRET_VERSION="${SECRET_VERSION:-latest}"
DB_USER_SECRET="${DB_USER_SECRET:-DB_USER}"
DB_PASS_SECRET="${DB_PASS_SECRET:-DB_PASS}"
DB_NAME_SECRET="${DB_NAME_SECRET:-DB_NAME}"
INSTANCE_CONNECTION_NAME_SECRET="${INSTANCE_CONNECTION_NAME_SECRET:-INSTANCE_CONNECTION_NAME}"
SMTP_PASS_SECRET="${SMTP_PASS_SECRET:-SMTP_PASS}"
STRIPE_SECRET_KEY_SECRET="${STRIPE_SECRET_KEY_SECRET:-STRIPE_SECRET_KEY}"
STRIPE_WEBHOOK_SECRET_SECRET="${STRIPE_WEBHOOK_SECRET_SECRET:-STRIPE_WEBHOOK_SECRET}"
UPS_CLIENT_ID_SECRET="${UPS_CLIENT_ID_SECRET:-UPS_CLIENT_ID}"
UPS_CLIENT_SECRET_SECRET="${UPS_CLIENT_SECRET_SECRET:-UPS_CLIENT_SECRET}"
UPS_SHIPPER_NUMBER_SECRET="${UPS_SHIPPER_NUMBER_SECRET:-UPS_SHIPPER_NUMBER}"
USPS_CONSUMER_KEY_SECRET="${USPS_CONSUMER_KEY_SECRET:-USPS_CONSUMER_KEY}"
USPS_CONSUMER_SECRET_SECRET="${USPS_CONSUMER_SECRET_SECRET:-USPS_CONSUMER_SECRET}"
SHIP_FROM_ADDRESS_SECRET="${SHIP_FROM_ADDRESS_SECRET:-SHIP_FROM_ADDRESS}"
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
  "SHIP_FROM_ADDRESS"
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
  "DB_USER=$(secret_ref "${DB_USER_SECRET}")"
  "DB_PASS=$(secret_ref "${DB_PASS_SECRET}")"
  "DB_NAME=$(secret_ref "${DB_NAME_SECRET}")"
  "SMTP_PASS=$(secret_ref "${SMTP_PASS_SECRET}")"
  "STRIPE_SECRET_KEY=$(secret_ref "${STRIPE_SECRET_KEY_SECRET}")"
  "STRIPE_WEBHOOK_SECRET=$(secret_ref "${STRIPE_WEBHOOK_SECRET_SECRET}")"
  "UPS_CLIENT_ID=$(secret_ref "${UPS_CLIENT_ID_SECRET}")"
  "UPS_CLIENT_SECRET=$(secret_ref "${UPS_CLIENT_SECRET_SECRET}")"
  "UPS_SHIPPER_NUMBER=$(secret_ref "${UPS_SHIPPER_NUMBER_SECRET}")"
  "USPS_CONSUMER_KEY=$(secret_ref "${USPS_CONSUMER_KEY_SECRET}")"
  "USPS_CONSUMER_SECRET=$(secret_ref "${USPS_CONSUMER_SECRET_SECRET}")"
  "SHIP_FROM_ADDRESS=$(secret_ref "${SHIP_FROM_ADDRESS_SECRET}")"
)

OPTIONAL_ENV_KEYS=(
  "PRICE_CURRENCY"
  "DB_SOCKET_PATH"
  "DB_SSL"
  "DB_POOL_MAX"
  "DB_IDLE_TIMEOUT_MS"
  "DB_CONNECTION_TIMEOUT_MS"
  "MAX_CART_QTY"
  "APP_BASE_URL"
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
  SECRET_VARS+=(
    "INSTANCE_CONNECTION_NAME=$(secret_ref "${INSTANCE_CONNECTION_NAME_SECRET}")"
  )
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
  "--$( [[ "${ALLOW_UNAUTHENTICATED}" == "true" ]] && printf 'allow' || printf 'no-allow' )-unauthenticated"
  --remove-env-vars="$(join_by , "${SECRET_ENV_KEYS[@]}")"
  --update-secrets="$(join_by , "${SECRET_VARS[@]}")"
)

if [[ ${#ENV_VARS[@]} -gt 0 ]]; then
  DEPLOY_ARGS+=(--update-env-vars="$(format_gcloud_dict_arg "${ENV_VARS[@]}")")
fi

"${DEPLOY_ARGS[@]}"
