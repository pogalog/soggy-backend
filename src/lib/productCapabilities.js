"use strict";

function normalizeKind(productOrKind) {
  if (typeof productOrKind === "string") {
    return productOrKind.trim().toLowerCase();
  }

  if (!productOrKind || typeof productOrKind !== "object") {
    return "";
  }

  const value = productOrKind.productKind || productOrKind.kind;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isCommissionCommitment(productOrKind) {
  return normalizeKind(productOrKind) === "commission_commitment";
}

function isDigitalProduct(productOrKind) {
  return normalizeKind(productOrKind) === "digital";
}

function consumesProductionCapacity(productOrKind) {
  return !isCommissionCommitment(productOrKind) && normalizeKind(productOrKind) !== "commission_final" && !isDigitalProduct(productOrKind);
}

function requiresShipping(productOrKind) {
  return !isCommissionCommitment(productOrKind) && !isDigitalProduct(productOrKind);
}

function hasFixedSingleQuantity(productOrKind) {
  return isCommissionCommitment(productOrKind) || normalizeKind(productOrKind) === "commission_final" || isDigitalProduct(productOrKind);
}

module.exports = {
  consumesProductionCapacity,
  hasFixedSingleQuantity,
  isCommissionCommitment,
  isDigitalProduct,
  normalizeKind,
  requiresShipping
};
