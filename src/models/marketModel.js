"use strict";

const MARKETS_SQL = `
  SELECT
    street_address,
    city,
    state,
    start_time,
    end_time,
    title,
    description,
    link
  FROM markets
  ORDER BY start_time ASC, title ASC
`;

function mapMarketRow(row) {
  return {
    streetAddress: row.street_address,
    city: row.city,
    state: row.state,
    startTime: new Date(row.start_time).toISOString(),
    endTime: row.end_time ? new Date(row.end_time).toISOString() : null,
    title: row.title,
    description: row.description,
    link: row.link
  };
}

async function getMarkets(pool) {
  const result = await pool.query(MARKETS_SQL);
  return result.rows.map(mapMarketRow);
}

module.exports = {
  getMarkets
};
