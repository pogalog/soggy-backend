#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${DB_USER:?Set DB_USER}"
: "${DB_PASS:?Set DB_PASS}"
: "${DB_NAME:?Set DB_NAME}"

FUNCTION_NAME="${FUNCTION_NAME:-getProduct}"
ENTRY_POINT="${ENTRY_POINT:-api}"
REGION="${REGION:-us-east1}"
RUNTIME="${RUNTIME:-nodejs20}"

ENV_VARS="DB_USER=${DB_USER},DB_PASS=${DB_PASS},DB_NAME=${DB_NAME}"

if [[ -n "${PRICE_CURRENCY:-}" ]]; then
  ENV_VARS="${ENV_VARS},PRICE_CURRENCY=${PRICE_CURRENCY}"
fi

if [[ -n "${INSTANCE_CONNECTION_NAME:-}" ]]; then
  gcloud functions deploy "${FUNCTION_NAME}" \
    --gen2 \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --runtime="${RUNTIME}" \
    --source="." \
    --entry-point="${ENTRY_POINT}" \
    --trigger-http \
    # --allow-unauthenticated \
    --set-env-vars="${ENV_VARS},INSTANCE_CONNECTION_NAME=${INSTANCE_CONNECTION_NAME}"
else
  : "${DB_HOST:?Set DB_HOST when INSTANCE_CONNECTION_NAME is not provided}"
  DB_PORT="${DB_PORT:-5432}"
  gcloud functions deploy "${FUNCTION_NAME}" \
    --gen2 \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --runtime="${RUNTIME}" \
    --source="." \
    --entry-point="${ENTRY_POINT}" \
    --trigger-http \
    # --allow-unauthenticated \
    --set-env-vars="${ENV_VARS},DB_HOST=${DB_HOST},DB_PORT=${DB_PORT}"
fi
