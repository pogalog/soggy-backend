"use strict";

const { randomUUID } = require("node:crypto");
const { env } = require("../config/env");
const { requestUpsShopRates } = require("./upsClient");
const {
  requestUspsBaseRate,
  requestUspsServiceStandards
} = require("./uspsClient");

const UPS_SERVICE_NAME_BY_CODE = {
  "01": "UPS Next Day Air",
  "02": "UPS 2nd Day Air",
  "03": "UPS Ground",
  "12": "UPS 3 Day Select",
  "13": "UPS Next Day Air Saver",
  "14": "UPS Next Day Air Early",
  "59": "UPS 2nd Day Air A.M."
};

const USPS_SERVICE_NAME_BY_MAIL_CLASS = {
  BOUND_PRINTED_MATTER: "Bound Printed Matter",
  "FIRST-CLASS_PACKAGE_RETURN_SERVICE": "First-Class Package Return Service",
  "FIRST-CLASS_PACKAGE_SERVICE": "First-Class Package Service",
  GROUND_RETURN_SERVICE: "Ground Return Service",
  LIBRARY_MAIL: "Library Mail",
  MEDIA_MAIL: "Media Mail",
  PARCEL_SELECT: "Parcel Select",
  PARCEL_SELECT_LIGHTWEIGHT: "Parcel Select Lightweight",
  PRIORITY_MAIL: "Priority Mail",
  PRIORITY_MAIL_EXPRESS: "Priority Mail Express",
  PRIORITY_MAIL_EXPRESS_RETURN_SERVICE: "Priority Mail Express Return Service",
  PRIORITY_MAIL_RETURN_SERVICE: "Priority Mail Return Service",
  USPS_CONNECT_LOCAL: "USPS Connect Local",
  USPS_CONNECT_MAIL: "USPS Connect Mail",
  USPS_CONNECT_REGIONAL: "USPS Connect Regional",
  USPS_GROUND_ADVANTAGE: "USPS Ground Advantage",
  USPS_GROUND_ADVANTAGE_RETURN_SERVICE: "USPS Ground Advantage Return Service",
  USPS_RETAIL_GROUND: "USPS Retail Ground"
};

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toTrimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function toUpperString(value) {
  const normalized = toTrimmedString(value);
  return normalized ? normalized.toUpperCase() : "";
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isCommissionProduct(product) {
  return product && product.kind === "commission_commitment";
}

function normalizeShippingDetailsInput(value, options = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const addressSource =
    raw.address && typeof raw.address === "object" ? raw.address : raw;

  const normalized = {
    name: toTrimmedString(raw.name) || null,
    address: {
      line1: toTrimmedString(addressSource.line1),
      line2: toTrimmedString(addressSource.line2) || null,
      city: toTrimmedString(addressSource.city),
      state: toUpperString(addressSource.state),
      postalCode: toTrimmedString(addressSource.postalCode),
      country: toUpperString(addressSource.country) || "US"
    }
  };

  if (options.requireName && !normalized.name) {
    throw withStatusError("shippingDetails.name is required", 400);
  }

  const missingField = [
    ["line1", normalized.address.line1],
    ["city", normalized.address.city],
    ["state", normalized.address.state],
    ["postalCode", normalized.address.postalCode],
    ["country", normalized.address.country]
  ].find((entry) => !entry[1]);

  if (missingField) {
    throw withStatusError(`shippingDetails.address.${missingField[0]} is required`, 400);
  }

  if (normalized.address.country !== "US") {
    throw withStatusError("Shipping quotes currently support US destinations only", 422);
  }

  return normalized;
}

function parseShipFromAddressSecret() {
  const raw = toTrimmedString(env.shipFromAddress);
  if (!raw) {
    throw withStatusError("SHIP_FROM_ADDRESS is required", 500);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw withStatusError("SHIP_FROM_ADDRESS must be valid JSON", 500);
  }

  const addressSource =
    payload && payload.address && typeof payload.address === "object"
      ? payload.address
      : payload;
  const addressLines = Array.isArray(addressSource.addressLine)
    ? addressSource.addressLine
    : Array.isArray(addressSource.AddressLine)
      ? addressSource.AddressLine
      : [addressSource.line1, addressSource.line2].filter(Boolean);

  const line1 = toTrimmedString(addressLines[0]);
  const line2 = toTrimmedString(addressLines[1]) || null;
  const city = toTrimmedString(addressSource.city || addressSource.City);
  const state = toUpperString(
    addressSource.state ||
      addressSource.stateProvinceCode ||
      addressSource.StateProvinceCode
  );
  const postalCode = toTrimmedString(
    addressSource.postalCode || addressSource.PostalCode
  );
  const country = toUpperString(
    addressSource.country || addressSource.countryCode || addressSource.CountryCode
  );

  if (!line1 || !city || !state || !postalCode || !country) {
    throw withStatusError(
      "SHIP_FROM_ADDRESS must include line1, city, state/stateProvinceCode, postalCode, and country/countryCode",
      500
    );
  }

  return {
    name: toTrimmedString(payload.name) || "Soggy Stitches",
    address: {
      line1,
      line2,
      city,
      state,
      postalCode,
      country
    }
  };
}

function toUpsAddress(address) {
  const lines = [address.line1];
  if (address.line2) {
    lines.push(address.line2);
  }

  return {
    AddressLine: lines,
    City: address.city,
    StateProvinceCode: address.state,
    PostalCode: address.postalCode,
    CountryCode: address.country
  };
}

function roundWeightLbs(value) {
  return Math.max(0.1, Math.round(value * 10) / 10);
}

function roundDimensionInches(value) {
  return Math.max(1, Math.ceil(value));
}

function buildPackageSummary(productsById, cartItems) {
  const missingShippingData = [];
  const shippableUnits = [];

  for (const cartItem of cartItems) {
    const product = productsById.get(cartItem.productId);
    const productKind = cartItem.kind || product?.kind || null;
    if (!product || productKind === "commission_commitment") {
      continue;
    }

    const shipping = cartItem.shipping || product.shipping || null;
    const missingShippingId =
      cartItem.variantId && typeof cartItem.variantId === "string"
        ? `${cartItem.productId}:${cartItem.variantId}`
        : cartItem.productId;
    if (
      !shipping ||
      !toPositiveNumber(shipping.weightLbs) ||
      !shipping.dimensionsIn ||
      !toPositiveNumber(shipping.dimensionsIn.length) ||
      !toPositiveNumber(shipping.dimensionsIn.width) ||
      !toPositiveNumber(shipping.dimensionsIn.height)
    ) {
      missingShippingData.push(missingShippingId);
      continue;
    }

    const sortedDimensions = [
      Number(shipping.dimensionsIn.length),
      Number(shipping.dimensionsIn.width),
      Number(shipping.dimensionsIn.height)
    ].sort((left, right) => right - left);

    for (let index = 0; index < cartItem.quantity; index += 1) {
      shippableUnits.push({
        productId: missingShippingId,
        weightLbs: Number(shipping.weightLbs),
        lengthIn: sortedDimensions[0],
        widthIn: sortedDimensions[1],
        heightIn: sortedDimensions[2]
      });
    }
  }

  if (missingShippingData.length > 0) {
    const error = withStatusError(
      "One or more products are missing shipping weight or dimensions",
      422
    );
    error.details = {
      missingShippingDataProductIds: Array.from(new Set(missingShippingData))
    };
    throw error;
  }

  if (shippableUnits.length === 0) {
    return null;
  }

  const compressionRatio = Number(env.upsCompressionRatio || 0.8);
  const paddingInches = Number(env.upsPackagePaddingInches || 0.5);
  const totalWeightLbs = shippableUnits.reduce((sum, unit) => sum + unit.weightLbs, 0);
  const maxLengthIn = shippableUnits.reduce(
    (max, unit) => Math.max(max, unit.lengthIn),
    0
  );
  const maxWidthIn = shippableUnits.reduce(
    (max, unit) => Math.max(max, unit.widthIn),
    0
  );
  const maxCompressedHeightIn = shippableUnits.reduce(
    (max, unit) => Math.max(max, unit.heightIn * compressionRatio),
    0
  );
  const compressedVolumeIn3 = shippableUnits.reduce(
    (sum, unit) => sum + unit.lengthIn * unit.widthIn * unit.heightIn * compressionRatio,
    0
  );

  const estimatedWidthIn = Math.max(
    maxWidthIn,
    Math.min(maxLengthIn, Math.sqrt(compressedVolumeIn3 / maxLengthIn))
  );
  const estimatedHeightIn = Math.max(
    maxCompressedHeightIn,
    compressedVolumeIn3 / (maxLengthIn * estimatedWidthIn)
  );

  const packedDimensions = [
    maxLengthIn + paddingInches,
    estimatedWidthIn + paddingInches,
    estimatedHeightIn + paddingInches
  ]
    .map(roundDimensionInches)
    .sort((left, right) => right - left);

  return {
    weightLbs: roundWeightLbs(totalWeightLbs),
    dimensionsIn: {
      length: packedDimensions[0],
      width: packedDimensions[1],
      height: packedDimensions[2]
    },
    totalUnits: shippableUnits.length
  };
}

function getTimePartsInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });

  const entries = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  return {
    weekday: entries.weekday,
    year: Number(entries.year),
    month: Number(entries.month),
    day: Number(entries.day),
    hour: Number(entries.hour),
    minute: Number(entries.minute)
  };
}

function addDays(parts, days, timeZone) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + days);
  return getTimePartsInZone(date, timeZone);
}

function resolvePickupSchedule() {
  const timeZone = "America/New_York";
  let parts = getTimePartsInZone(new Date(), timeZone);
  const isWeekend = parts.weekday === "Sat" || parts.weekday === "Sun";
  const pastCutoff = parts.hour >= 15;

  if (isWeekend || pastCutoff) {
    do {
      parts = addDays(parts, 1, timeZone);
    } while (parts.weekday === "Sat" || parts.weekday === "Sun");

    return {
      date: `${parts.year}${String(parts.month).padStart(2, "0")}${String(parts.day).padStart(2, "0")}`,
      time: "1200"
    };
  }

  const roundedMinute = Math.min(45, Math.ceil(parts.minute / 15) * 15);
  const hour = roundedMinute === 60 ? parts.hour + 1 : parts.hour;
  const minute = roundedMinute === 60 ? 0 : roundedMinute;
  const clampedHour = Math.max(9, Math.min(15, hour));

  return {
    date: `${parts.year}${String(parts.month).padStart(2, "0")}${String(parts.day).padStart(2, "0")}`,
    time: `${String(clampedHour).padStart(2, "0")}${String(minute).padStart(2, "0")}`
  };
}

function resolveMailingDate() {
  const pickup = resolvePickupSchedule();
  return `${pickup.date.slice(0, 4)}-${pickup.date.slice(4, 6)}-${pickup.date.slice(6, 8)}`;
}

function requireZip5(postalCode, label) {
  const digits = String(postalCode || "").replace(/\D/g, "");
  if (digits.length < 5) {
    throw withStatusError(`${label} must include a valid 5-digit US ZIP code`, 422);
  }

  return digits.slice(0, 5);
}

function buildRateRequest({ shipFrom, shippingDetails, packageSummary }) {
  return {
    RateRequest: {
      Request: {
        TransactionReference: {
          CustomerContext: "Soggy Stitches shipping quote",
          TransactionIdentifier: randomUUID()
        }
      },
      PickupType: {
        Code: env.upsPickupType
      },
      CustomerClassification: {
        Code: env.upsCustomerClassification
      },
      Shipment: {
        Shipper: {
          Name: shipFrom.name,
          ShipperNumber: env.upsShipperNumber,
          Address: toUpsAddress(shipFrom.address)
        },
        ShipFrom: {
          Name: shipFrom.name,
          Address: toUpsAddress(shipFrom.address)
        },
        ShipTo: {
          Name: shippingDetails.name || "Customer",
          Address: toUpsAddress(shippingDetails.address)
        },
        Package: [
          {
            PackagingType: {
              Code: env.upsPackagingType
            },
            Dimensions: {
              UnitOfMeasurement: {
                Code: "IN"
              },
              Length: String(packageSummary.dimensionsIn.length),
              Width: String(packageSummary.dimensionsIn.width),
              Height: String(packageSummary.dimensionsIn.height)
            },
            PackageWeight: {
              UnitOfMeasurement: {
                Code: "LBS"
              },
              Weight: String(packageSummary.weightLbs)
            }
          }
        ],
        DeliveryTimeInformation: {
          PackageBillType: env.upsPackageBillType,
          Pickup: resolvePickupSchedule()
        }
      }
    }
  };
}

function parseMoneyValue(value) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function resolveQuotedCharge(shipment) {
  const negotiated =
    shipment &&
    shipment.NegotiatedRateCharges &&
    shipment.NegotiatedRateCharges.TotalCharge &&
    typeof shipment.NegotiatedRateCharges.TotalCharge === "object"
      ? shipment.NegotiatedRateCharges.TotalCharge
      : null;
  const published =
    shipment && shipment.TotalCharges && typeof shipment.TotalCharges === "object"
      ? shipment.TotalCharges
      : null;
  const candidate = negotiated || published;

  if (!candidate) {
    return null;
  }

  const amountCents = parseMoneyValue(candidate.MonetaryValue);
  if (!Number.isInteger(amountCents)) {
    return null;
  }

  return {
    amountCents,
    currency:
      typeof candidate.CurrencyCode === "string" && candidate.CurrencyCode.trim()
        ? candidate.CurrencyCode.trim().toUpperCase()
        : "USD",
    negotiated: Boolean(negotiated)
  };
}

function resolveServiceName(shipment) {
  const timeInTransitName =
    shipment &&
    shipment.TimeInTransit &&
    shipment.TimeInTransit.ServiceSummary &&
    shipment.TimeInTransit.ServiceSummary.Service &&
    typeof shipment.TimeInTransit.ServiceSummary.Service.Description === "string"
      ? shipment.TimeInTransit.ServiceSummary.Service.Description.trim()
      : "";

  if (timeInTransitName) {
    return timeInTransitName;
  }

  const serviceCode =
    shipment && shipment.Service && typeof shipment.Service.Code === "string"
      ? shipment.Service.Code.trim()
      : "";
  if (serviceCode && UPS_SERVICE_NAME_BY_CODE[serviceCode]) {
    return UPS_SERVICE_NAME_BY_CODE[serviceCode];
  }

  const serviceDescription =
    shipment && shipment.Service && typeof shipment.Service.Description === "string"
      ? shipment.Service.Description.trim()
      : "";

  return serviceDescription || (serviceCode ? `UPS ${serviceCode}` : "UPS shipping");
}

function parseTransitDetails(shipment) {
  const summary =
    shipment &&
    shipment.TimeInTransit &&
    shipment.TimeInTransit.ServiceSummary &&
    typeof shipment.TimeInTransit.ServiceSummary === "object"
      ? shipment.TimeInTransit.ServiceSummary
      : null;
  const estimate =
    summary &&
    summary.EstimatedArrival &&
    typeof summary.EstimatedArrival === "object"
      ? summary.EstimatedArrival
      : null;
  const arrival =
    estimate && estimate.Arrival && typeof estimate.Arrival === "object"
      ? estimate.Arrival
      : null;

  return {
    businessDaysInTransit:
      estimate && Number.isFinite(Number(estimate.BusinessDaysInTransit))
        ? Number(estimate.BusinessDaysInTransit)
        : shipment &&
            shipment.GuaranteedDelivery &&
            Number.isFinite(Number(shipment.GuaranteedDelivery.BusinessDaysInTransit))
          ? Number(shipment.GuaranteedDelivery.BusinessDaysInTransit)
          : null,
    estimatedDeliveryDate:
      arrival && typeof arrival.Date === "string" && arrival.Date.trim()
        ? arrival.Date.trim()
        : null,
    estimatedDeliveryTime:
      arrival && typeof arrival.Time === "string" && arrival.Time.trim()
        ? arrival.Time.trim()
        : null
  };
}

function normalizeEstimatedDeliveryDate(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalized = value.trim();
  if (/^\d{8}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  const isoDateMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoDateMatch && isoDateMatch[1]) {
    return isoDateMatch[1];
  }

  return null;
}

function normalizeEstimatedDeliveryTime(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalized = value.trim();
  if (/^\d{6}$/.test(normalized)) {
    return normalized;
  }

  const timeMatch = normalized.match(/T(\d{2}:\d{2}:\d{2})/);
  if (timeMatch && timeMatch[1]) {
    return timeMatch[1].replace(/:/g, "");
  }

  return null;
}

function buildShippingOptionId(carrier, serviceCode, serviceName) {
  const normalizedCarrier = toUpperString(carrier) || "CARRIER";
  const normalizedServiceCode =
    typeof serviceCode === "string" && serviceCode.trim()
      ? serviceCode.trim().toUpperCase()
      : "";

  if (normalizedServiceCode) {
    return `${normalizedCarrier}:${normalizedServiceCode}`;
  }

  const fallback = String(serviceName || "shipping")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${normalizedCarrier}:${fallback || "SHIPPING"}`;
}

function formatAmountDisplay(amountCents, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency
  }).format(amountCents / 100);
}

function decorateShippingOption(option, quotedAt) {
  return {
    ...option,
    optionId: buildShippingOptionId(option.carrier, option.serviceCode, option.serviceName),
    amountDisplay: formatAmountDisplay(option.amountCents, option.currency),
    quotedAt
  };
}

function parseRatedShipmentOption(shipment) {
  const charge = resolveQuotedCharge(shipment);
  if (!charge) {
    return null;
  }

  const serviceCode =
    shipment && shipment.Service && typeof shipment.Service.Code === "string"
      ? shipment.Service.Code.trim()
      : null;
  const transit = parseTransitDetails(shipment);

  return {
    carrier: "UPS",
    serviceCode,
    mailClass: null,
    serviceName: resolveServiceName(shipment),
    amountCents: charge.amountCents,
    currency: charge.currency,
    businessDaysInTransit:
      Number.isFinite(transit.businessDaysInTransit) && transit.businessDaysInTransit > 0
        ? transit.businessDaysInTransit
        : null,
    estimatedDeliveryDate: normalizeEstimatedDeliveryDate(transit.estimatedDeliveryDate),
    estimatedDeliveryTime: normalizeEstimatedDeliveryTime(transit.estimatedDeliveryTime),
    negotiated: charge.negotiated
  };
}

function sortOptionsByPrice(options) {
  return options
    .filter(Boolean)
    .sort((left, right) => {
      if (left.amountCents !== right.amountCents) {
        return left.amountCents - right.amountCents;
      }

      const leftDays =
        Number.isFinite(left.businessDaysInTransit) ? left.businessDaysInTransit : 999;
      const rightDays =
        Number.isFinite(right.businessDaysInTransit) ? right.businessDaysInTransit : 999;

      if (leftDays !== rightDays) {
        return leftDays - rightDays;
      }

      return left.serviceName.localeCompare(right.serviceName);
    });
}

function sortOptionsForDisplay(options) {
  return [...options].sort((left, right) => {
    const carrierOrder = {
      USPS: 0,
      UPS: 1
    };

    const leftCarrierRank =
      carrierOrder[left.carrier] === undefined ? 99 : carrierOrder[left.carrier];
    const rightCarrierRank =
      carrierOrder[right.carrier] === undefined ? 99 : carrierOrder[right.carrier];

    if (leftCarrierRank !== rightCarrierRank) {
      return leftCarrierRank - rightCarrierRank;
    }

    if (left.carrier !== right.carrier) {
      return left.carrier.localeCompare(right.carrier);
    }

    if (left.amountCents !== right.amountCents) {
      return left.amountCents - right.amountCents;
    }

    const leftDays =
      Number.isFinite(left.businessDaysInTransit) ? left.businessDaysInTransit : 999;
    const rightDays =
      Number.isFinite(right.businessDaysInTransit) ? right.businessDaysInTransit : 999;
    if (leftDays !== rightDays) {
      return leftDays - rightDays;
    }

    return left.serviceName.localeCompare(right.serviceName);
  });
}

function chooseDefaultOption(options) {
  return sortOptionsByPrice(options)[0] || null;
}

function summarizeProviderError(carrier, error) {
  return {
    carrier,
    statusCode:
      error && Number.isFinite(Number(error.statusCode))
        ? Number(error.statusCode)
        : null,
    message:
      error instanceof Error
        ? error.message
        : error === undefined || error === null
          ? "Unknown shipping provider error"
          : String(error),
    cause:
      error && error.cause instanceof Error
        ? error.cause.message
        : null
  };
}

async function quoteUpsShippingOptions({ shipFrom, shippingDetails, packageSummary }) {
  const rateRequest = buildRateRequest({
    shipFrom,
    shippingDetails,
    packageSummary
  });
  const response = await requestUpsShopRates(rateRequest);
  const ratedShipments =
    response &&
    response.RateResponse &&
    Array.isArray(response.RateResponse.RatedShipment)
      ? response.RateResponse.RatedShipment
      : [];

  const quotedAt = new Date().toISOString();
  const options = sortOptionsByPrice(
    ratedShipments.map(parseRatedShipmentOption).filter(Boolean)
  )
    .slice(0, 2)
    .map((option) => decorateShippingOption(option, quotedAt));

  if (options.length === 0) {
    const error = withStatusError("UPS did not return any valid shipping quotes", 502);
    error.details = response;
    throw error;
  }

  return options;
}

function resolveUspsServiceName(mailClass) {
  if (mailClass && USPS_SERVICE_NAME_BY_MAIL_CLASS[mailClass]) {
    return USPS_SERVICE_NAME_BY_MAIL_CLASS[mailClass];
  }

  return String(mailClass || "USPS Shipping")
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => (part === "usps" ? "USPS" : `${part[0].toUpperCase()}${part.slice(1)}`))
    .join(" ");
}

function buildUspsBaseRateRequest({
  originZIPCode,
  destinationZIPCode,
  packageSummary,
  mailClass,
  mailingDate
}) {
  return {
    originZIPCode,
    destinationZIPCode,
    weight: packageSummary.weightLbs,
    length: packageSummary.dimensionsIn.length,
    width: packageSummary.dimensionsIn.width,
    height: packageSummary.dimensionsIn.height,
    mailClass,
    processingCategory: env.uspsProcessingCategory,
    rateIndicator: env.uspsRateIndicator,
    destinationEntryFacilityType: env.uspsDestinationEntryFacilityType,
    priceType: env.uspsPriceType,
    mailingDate,
    hasNonstandardCharacteristics: false
  };
}

function parseUspsEstimate(payload) {
  const estimate = Array.isArray(payload) ? payload.find(Boolean) : null;
  if (!estimate || typeof estimate !== "object") {
    return {
      businessDaysInTransit: null,
      estimatedDeliveryDate: null,
      estimatedDeliveryTime: null
    };
  }

  const delivery =
    estimate.delivery && typeof estimate.delivery === "object" ? estimate.delivery : null;
  const scheduledDeliveryValue =
    delivery && typeof delivery.scheduledDeliveryDateTime === "string"
      ? delivery.scheduledDeliveryDateTime
      : typeof estimate.scheduledDeliveryDate === "string"
        ? estimate.scheduledDeliveryDate
        : null;

  return {
    businessDaysInTransit:
      Number.isFinite(Number(estimate.serviceStandard)) && Number(estimate.serviceStandard) > 0
        ? Number(estimate.serviceStandard)
        : Number.isFinite(Number(estimate.days)) && Number(estimate.days) > 0
          ? Number(estimate.days)
          : null,
    estimatedDeliveryDate: normalizeEstimatedDeliveryDate(scheduledDeliveryValue),
    estimatedDeliveryTime: normalizeEstimatedDeliveryTime(scheduledDeliveryValue)
  };
}

function parseUspsBaseRateOption({ mailClass, rateResponse, estimate }) {
  const rate =
    rateResponse &&
    Array.isArray(rateResponse.rates) &&
    rateResponse.rates[0] &&
    typeof rateResponse.rates[0] === "object"
      ? rateResponse.rates[0]
      : null;

  const amountCents = parseMoneyValue(
    rate && rate.price !== undefined ? rate.price : rateResponse && rateResponse.totalBasePrice
  );
  if (!Number.isInteger(amountCents)) {
    return null;
  }

  return {
    carrier: "USPS",
    serviceCode: mailClass,
    mailClass,
    serviceName: resolveUspsServiceName(mailClass),
    amountCents,
    currency: String(env.priceCurrency || "USD").toUpperCase(),
    businessDaysInTransit:
      Number.isFinite(estimate.businessDaysInTransit) && estimate.businessDaysInTransit > 0
        ? estimate.businessDaysInTransit
        : null,
    estimatedDeliveryDate: estimate.estimatedDeliveryDate,
    estimatedDeliveryTime: estimate.estimatedDeliveryTime,
    negotiated: false
  };
}

async function quoteUspsShippingOptions({ shipFrom, shippingDetails, packageSummary }) {
  const originZIPCode = requireZip5(
    shipFrom && shipFrom.address ? shipFrom.address.postalCode : "",
    "SHIP_FROM_ADDRESS.postalCode"
  );
  const destinationZIPCode = requireZip5(
    shippingDetails && shippingDetails.address ? shippingDetails.address.postalCode : "",
    "shippingDetails.address.postalCode"
  );
  const mailingDate = resolveMailingDate();
  const mailClasses = Array.isArray(env.uspsMailClasses)
    ? env.uspsMailClasses.filter((entry) => typeof entry === "string" && entry.trim())
    : [];

  if (mailClasses.length === 0) {
    throw withStatusError("USPS_MAIL_CLASSES must include at least one mail class", 500);
  }

  const quotedAt = new Date().toISOString();
  const results = await Promise.allSettled(
    mailClasses.map(async (mailClass) => {
      const [rateResult, estimateResult] = await Promise.allSettled([
        requestUspsBaseRate(
          buildUspsBaseRateRequest({
            originZIPCode,
            destinationZIPCode,
            packageSummary,
            mailClass,
            mailingDate
          })
        ),
        requestUspsServiceStandards({
          originZIPCode,
          destinationZIPCode,
          acceptanceDate: mailingDate,
          mailClass
        })
      ]);

      if (rateResult.status !== "fulfilled") {
        throw rateResult.reason;
      }

      const estimate =
        estimateResult.status === "fulfilled"
          ? parseUspsEstimate(estimateResult.value)
          : (
              console.warn("USPS service standards unavailable for quoted option", {
                mailClass,
                message:
                  estimateResult.reason instanceof Error
                    ? estimateResult.reason.message
                    : String(estimateResult.reason)
              }),
              {
                businessDaysInTransit: null,
                estimatedDeliveryDate: null,
                estimatedDeliveryTime: null
              }
            );

      const option = parseUspsBaseRateOption({
        mailClass,
        rateResponse: rateResult.value,
        estimate
      });

      return option ? decorateShippingOption(option, quotedAt) : null;
    })
  );

  const options = [];
  const errors = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      if (result.value) {
        options.push(result.value);
      }
      continue;
    }

    errors.push(result.reason);
  }

  if (options.length === 0) {
    if (errors[0]) {
      throw errors[0];
    }

    throw withStatusError("USPS did not return any valid shipping quotes", 502);
  }

  return sortOptionsByPrice(options);
}

async function quoteShippingOptions({ productsById, cartItems, shippingDetails }) {
  const packageSummary = buildPackageSummary(productsById, cartItems);
  if (!packageSummary) {
    return {
      shippingRequired: false,
      packageSummary: null,
      options: [],
      defaultOptionId: null,
      quote: null
    };
  }

  const shipFrom = parseShipFromAddressSecret();
  const providers = [
    {
      carrier: "UPS",
      quote: () =>
        quoteUpsShippingOptions({
          shipFrom,
          shippingDetails,
          packageSummary
        })
    },
    {
      carrier: "USPS",
      quote: () =>
        quoteUspsShippingOptions({
          shipFrom,
          shippingDetails,
          packageSummary
        })
    }
  ];
  const providerResults = await Promise.allSettled(
    providers.map((provider) => provider.quote())
  );

  const options = [];
  const errors = [];

  providerResults.forEach((result, index) => {
    const provider = providers[index];
    if (result.status === "fulfilled") {
      options.push(...result.value);
      return;
    }

    const providerError = summarizeProviderError(provider.carrier, result.reason);
    errors.push({
      ...providerError,
      error: result.reason
    });
    console.warn("Shipping provider unavailable while quoting", providerError);
  });

  if (options.length === 0) {
    if (errors[0]) {
      throw errors[0].error;
    }

    throw withStatusError("No shipping options were returned for this cart", 502);
  }

  const displayedOptions = sortOptionsForDisplay(options);
  const defaultOption = chooseDefaultOption(options);

  return {
    shippingRequired: true,
    packageSummary,
    options: displayedOptions,
    defaultOptionId: defaultOption ? defaultOption.optionId : null,
    quote: defaultOption,
    providerWarnings: errors.map(({ error, ...warning }) => warning)
  };
}

async function resolveSelectedShippingOption({
  productsById,
  cartItems,
  shippingDetails,
  selectedOptionId
}) {
  const quoteResult = await quoteShippingOptions({
    productsById,
    cartItems,
    shippingDetails
  });

  if (!quoteResult.shippingRequired) {
    return {
      ...quoteResult,
      selectedOption: null
    };
  }

  const selectedOption = quoteResult.options.find(
    (option) => option.optionId === selectedOptionId
  );

  if (!selectedOption) {
    const error = withStatusError(
      "Selected shipping option is no longer available. Refresh shipping options and try again.",
      422
    );
    error.details = {
      availableOptionIds: quoteResult.options.map((option) => option.optionId)
    };
    throw error;
  }

  return {
    ...quoteResult,
    selectedOption
  };
}

module.exports = {
  normalizeShippingDetailsInput,
  quoteShippingOptions,
  resolveSelectedShippingOption
};
