"use strict";

const { randomUUID } = require("node:crypto");
const { env } = require("../config/env");
const { requestUpsShopRates } = require("./upsClient");

const UPS_SERVICE_NAME_BY_CODE = {
  "01": "UPS Next Day Air",
  "02": "UPS 2nd Day Air",
  "03": "UPS Ground",
  "12": "UPS 3 Day Select",
  "13": "UPS Next Day Air Saver",
  "14": "UPS Next Day Air Early",
  "59": "UPS 2nd Day Air A.M."
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
    throw withStatusError("UPS checkout quotes currently support US destinations only", 422);
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
    if (!product || isCommissionProduct(product)) {
      continue;
    }

    const shipping = product.shipping || null;
    if (
      !shipping ||
      !toPositiveNumber(shipping.weightLbs) ||
      !shipping.dimensionsIn ||
      !toPositiveNumber(shipping.dimensionsIn.length) ||
      !toPositiveNumber(shipping.dimensionsIn.width) ||
      !toPositiveNumber(shipping.dimensionsIn.height)
    ) {
      missingShippingData.push(product.id);
      continue;
    }

    const sortedDimensions = [
      Number(shipping.dimensionsIn.length),
      Number(shipping.dimensionsIn.width),
      Number(shipping.dimensionsIn.height)
    ].sort((left, right) => right - left);

    for (let index = 0; index < cartItem.quantity; index += 1) {
      shippableUnits.push({
        productId: product.id,
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
        ShipmentRatingOptions: {
          NegotiatedRatesIndicator: ""
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
    serviceName: resolveServiceName(shipment),
    amountCents: charge.amountCents,
    currency: charge.currency,
    businessDaysInTransit:
      Number.isFinite(transit.businessDaysInTransit) && transit.businessDaysInTransit > 0
        ? transit.businessDaysInTransit
        : null,
    estimatedDeliveryDate: transit.estimatedDeliveryDate,
    estimatedDeliveryTime: transit.estimatedDeliveryTime,
    negotiated: charge.negotiated
  };
}

function chooseCheapestQuote(options) {
  const sorted = options
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

  return sorted[0] || null;
}

async function quoteCheapestShipping({ productsById, cartItems, shippingDetails }) {
  const packageSummary = buildPackageSummary(productsById, cartItems);
  if (!packageSummary) {
    return {
      shippingRequired: false,
      packageSummary: null,
      quote: null
    };
  }

  const shipFrom = parseShipFromAddressSecret();
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

  const quote = chooseCheapestQuote(ratedShipments.map(parseRatedShipmentOption));
  if (!quote) {
    const error = withStatusError("UPS did not return any valid shipping quotes", 502);
    error.details = response;
    throw error;
  }

  return {
    shippingRequired: true,
    packageSummary,
    quote: {
      ...quote,
      amountDisplay: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: quote.currency
      }).format(quote.amountCents / 100),
      quotedAt: new Date().toISOString()
    }
  };
}

module.exports = {
  normalizeShippingDetailsInput,
  quoteCheapestShipping
};
