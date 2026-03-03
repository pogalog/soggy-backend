"use strict";

const { env } = require("../config/env");

let transporter;

function required(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function normalizeService(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase();
}

function isGmailAddress(value) {
  return typeof value === "string" && value.trim().toLowerCase().endsWith("@gmail.com");
}

function getTransporter() {
  if (transporter) {
    return transporter;
  }

  required("SMTP_USER", env.smtpUser);
  required("SMTP_PASS", env.smtpPass);

  const nodemailer = require("nodemailer");
  const service = normalizeService(env.smtpService);

  if (service === "gmail" || (!env.smtpHost && isGmailAddress(env.smtpUser))) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: env.smtpUser,
        pass: env.smtpPass
      }
    });

    return transporter;
  }

  required("SMTP_HOST", env.smtpHost);
  transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpSecure,
    auth: {
      user: env.smtpUser,
      pass: env.smtpPass
    }
  });

  return transporter;
}

async function sendMail(message) {
  const transport = getTransporter();
  return transport.sendMail(message);
}

module.exports = {
  sendMail
};
