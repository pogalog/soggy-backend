"use strict";

const { Pool } = require("pg");
const { env } = require("../config/env");

let pool;

function required(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function buildConnectionConfig() {
  required("DB_USER", env.dbUser);
  required("DB_NAME", env.dbName);
  required("DB_PASS", env.dbPassword);

  const config = {
    user: env.dbUser,
    password: env.dbPassword,
    database: env.dbName,
    max: env.dbPoolMax,
    idleTimeoutMillis: env.dbIdleTimeoutMs,
    connectionTimeoutMillis: env.dbConnectionTimeoutMs
  };

  if (env.instanceConnectionName) {
    config.host = `${env.dbSocketPath}/${env.instanceConnectionName}`;
  } else {
    config.host = env.dbHost || "127.0.0.1";
    config.port = env.dbPort;
  }

  if (env.dbSsl) {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

function getPool() {
  if (!pool) {
    pool = new Pool(buildConnectionConfig());
  }

  return pool;
}

module.exports = {
  getPool
};
