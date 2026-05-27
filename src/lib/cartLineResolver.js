"use strict";

const { env } = require("../config/env");

function toTrimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildOptionSummary(variant) {
  if (!variant || !Array.isArray(variant.optionSelections)) {
    return null;
  }

  const parts = variant.optionSelections
    .map((selection) =>
      selection && typeof selection === "object" ? toTrimmedString(selection.value) : null
    )
    .filter(Boolean);

  return parts.length > 0 ? parts.join(" • ") : null;
}

function buildVariantLabel(variant) {
  if (!variant || typeof variant !== "object") {
    return null;
  }

  return (
    toTrimmedString(variant.title) ||
    buildOptionSummary(variant) ||
    toTrimmedString(variant.sku) ||
    null
  );
}

function resolveCartLineItems(productsById, cartItems) {
  const resolvedItems = [];
  const violations = [];

  for (const cartItem of cartItems) {
    const product = productsById.get(cartItem.productId);
    const variantId = toTrimmedString(cartItem.variantId);
    const baseResolved = {
      lineId: toTrimmedString(cartItem.lineId),
      productId: cartItem.productId,
      variantId,
      quantity: Number(cartItem.quantity || 0),
      lastUpdated: cartItem.lastUpdated || null,
      variantLabel: toTrimmedString(cartItem.variantLabel),
      optionSummary: toTrimmedString(cartItem.optionSummary),
      validationReason: null
    };

    if (!product) {
      const resolved = {
        ...baseResolved,
        sku: null,
        title: null,
        unitAmount: null,
        currency: env.priceCurrency,
        stripeThumbUrl: null,
        shipping: null,
        daysToCreate: 0,
        kind: null,
        hasVariants: false,
        validationReason: "PRODUCT_NOT_FOUND"
      };
      resolvedItems.push(resolved);
      violations.push({
        lineId: resolved.lineId,
        productId: resolved.productId,
        variantId: resolved.variantId,
        requestedQuantity: resolved.quantity,
        reason: resolved.validationReason
      });
      continue;
    }

    if (product.hasVariants) {
      if (!variantId) {
        const resolved = {
          ...baseResolved,
          sku: null,
          title: product.title,
          unitAmount: null,
          currency: product.currency || env.priceCurrency,
          stripeThumbUrl: product.stripeThumbUrl || null,
          shipping: product.shipping || null,
          daysToCreate: Number(product.daysToCreate || 0),
          kind: product.kind || "product",
          hasVariants: true,
          validationReason: "VARIANT_SELECTION_REQUIRED"
        };
        resolvedItems.push(resolved);
        violations.push({
          lineId: resolved.lineId,
          productId: resolved.productId,
          requestedQuantity: resolved.quantity,
          reason: resolved.validationReason
        });
        continue;
      }

      const variant = Array.isArray(product.variants)
        ? product.variants.find((entry) => entry && entry.id === variantId)
        : null;

      if (!variant) {
        const resolved = {
          ...baseResolved,
          sku: null,
          title: product.title,
          unitAmount: null,
          currency: product.currency || env.priceCurrency,
          stripeThumbUrl: product.stripeThumbUrl || null,
          shipping: product.shipping || null,
          daysToCreate: Number(product.daysToCreate || 0),
          kind: product.kind || "product",
          hasVariants: true,
          validationReason: "INVALID_VARIANT"
        };
        resolvedItems.push(resolved);
        violations.push({
          lineId: resolved.lineId,
          productId: resolved.productId,
          variantId: resolved.variantId,
          requestedQuantity: resolved.quantity,
          reason: resolved.validationReason
        });
        continue;
      }

      const optionSummary = buildOptionSummary(variant);
      const variantLabel = buildVariantLabel(variant);
      resolvedItems.push({
        ...baseResolved,
        sku: toTrimmedString(variant.sku) || variant.id,
        title: product.title,
        unitAmount: Number(variant.price?.amount || 0),
        currency: variant.price?.currency || product.currency || env.priceCurrency,
        stripeThumbUrl: product.stripeThumbUrl || null,
        shipping: variant.shipping || product.shipping || null,
        daysToCreate: Number(product.daysToCreate || 0),
        kind: product.kind || "product",
        hasVariants: true,
        variantLabel: baseResolved.variantLabel || variantLabel,
        optionSummary: baseResolved.optionSummary || optionSummary
      });
      continue;
    }

    if (variantId) {
      const resolved = {
        ...baseResolved,
        sku: product.id,
        title: product.title,
        unitAmount: Number(product.sellPriceCents || 0),
        currency: product.currency || env.priceCurrency,
        stripeThumbUrl: product.stripeThumbUrl || null,
        shipping: product.shipping || null,
        daysToCreate: Number(product.daysToCreate || 0),
        kind: product.kind || "product",
        hasVariants: false,
        validationReason: "INVALID_VARIANT"
      };
      resolvedItems.push(resolved);
      violations.push({
        lineId: resolved.lineId,
        productId: resolved.productId,
        variantId: resolved.variantId,
        requestedQuantity: resolved.quantity,
        reason: resolved.validationReason
      });
      continue;
    }

    resolvedItems.push({
      ...baseResolved,
      sku: product.id,
      title: product.title,
      unitAmount: Number(product.sellPriceCents || 0),
      currency: product.currency || env.priceCurrency,
      stripeThumbUrl: product.stripeThumbUrl || null,
      shipping: product.shipping || null,
      daysToCreate: Number(product.daysToCreate || 0),
      kind: product.kind || "product",
      hasVariants: false
    });
  }

  return {
    resolvedItems,
    violations
  };
}

function buildDisplayName(cartLine) {
  const title = toTrimmedString(cartLine.title) || cartLine.productId || "Product";
  const variantLabel = toTrimmedString(cartLine.variantLabel);
  const optionSummary = toTrimmedString(cartLine.optionSummary);

  if (variantLabel && optionSummary && variantLabel !== optionSummary) {
    return `${title} - ${variantLabel} (${optionSummary})`;
  }

  if (variantLabel) {
    return `${title} - ${variantLabel}`;
  }

  if (optionSummary) {
    return `${title} - ${optionSummary}`;
  }

  return title;
}

module.exports = {
  buildDisplayName,
  buildOptionSummary,
  buildVariantLabel,
  resolveCartLineItems
};
