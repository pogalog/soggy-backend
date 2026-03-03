"use strict";

const { env } = require("../config/env");

let stripeClient;

function getStripeClient() {
  if (stripeClient) {
    return stripeClient;
  }

  if (!env.stripeSecretKey) {
    throw new Error("Missing required environment variable: STRIPE_SECRET_KEY");
  }

  // Lazy require so non-Stripe routes can still start even before `npm install`.
  const Stripe = require("stripe");
  stripeClient = new Stripe(env.stripeSecretKey);
  return stripeClient;
}

module.exports = {
  getStripeClient
};
