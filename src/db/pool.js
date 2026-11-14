"use strict";

const { Connector } = require("@google-cloud/cloud-sql-connector");
const { Pool } = require("pg");
const { env } = require("../config/env");

let pool;
let poolPromise;
let connector;

function required(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function buildPasswordConnectionConfig() {
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

async function buildIamConnectionConfig() {
  required("DB_IAM_USER", env.dbIamUser);
  required("DB_NAME", env.dbName);
  required("INSTANCE_CONNECTION_NAME", env.instanceConnectionName);

  if (!connector) {
    connector = new Connector();
  }

  const connectorOptions = await connector.getOptions({
    instanceConnectionName: env.instanceConnectionName,
    ipType: "PRIVATE",
    authType: "IAM"
  });

  return {
    ...connectorOptions,
    user: env.dbIamUser,
    database: env.dbName,
    max: env.dbPoolMax,
    idleTimeoutMillis: env.dbIdleTimeoutMs,
    connectionTimeoutMillis: env.dbConnectionTimeoutMs
  };
}

function createPool() {
  return (env.dbIamAuth
    ? buildIamConnectionConfig()
    : Promise.resolve(buildPasswordConnectionConfig())
  ).then((config) => new Pool(config));
}

function getPoolPromise() {
  if (!poolPromise) {
    poolPromise = createPool().catch((error) => {
      poolPromise = undefined;
      throw error;
    });
  }

  return poolPromise;
}

function getPool() {
  if (!pool) {
    // Existing handlers expect a synchronous Pool-shaped object. This facade
    // keeps that contract while the IAM connector resolves credentials lazily.
    pool = {
      query: (...args) => getPoolPromise().then((client) => client.query(...args)),
      connect: (...args) =>
        getPoolPromise().then((client) => client.connect(...args)),
      end: (...args) =>
        getPoolPromise()
          .then((client) => client.end(...args))
          .finally(() => {
            pool = undefined;
            poolPromise = undefined;
            if (connector) {
              connector.close();
              connector = undefined;
            }
          })
    };
  }

  return pool;
}

module.exports = {
  getPool
};
