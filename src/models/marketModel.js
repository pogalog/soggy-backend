"use strict";

const MARKETS_SQL = `
  SELECT
    market_id,
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
    id: row.market_id,
    marketId: row.market_id,
    streetAddress: row.street_address,
    address: row.street_address,
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

async function getUpcomingMarketByPickupDetails(
  pool,
  { marketId, streetAddress, city, state, startTime }
) {
  if (marketId) {
    const result = await pool.query(
      `
        SELECT
          market_id,
          street_address,
          city,
          state,
          start_time,
          end_time,
          title,
          description,
          link
        FROM markets
        WHERE market_id = $1
          AND start_time >= NOW()
        ORDER BY start_time ASC
        LIMIT 1
      `,
      [marketId]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapMarketRow(result.rows[0]);
  }

  const result = await pool.query(
    `
      SELECT
        market_id,
        street_address,
        city,
        state,
        start_time,
        end_time,
        title,
        description,
        link
      FROM markets
      WHERE street_address = $1
        AND city = $2
        AND state = $3
        AND start_time = $4
        AND start_time >= NOW()
      ORDER BY start_time ASC
      LIMIT 1
    `,
    [streetAddress, city, state, startTime]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapMarketRow(result.rows[0]);
}

module.exports = {
  getMarkets,
  getUpcomingMarketByPickupDetails
};
