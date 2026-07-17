"use strict";

function mapRow(row) {
  return {
    slug: row.slug,
    content: row.content,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function getSiteContent(pool, slug) {
  const result = await pool.query(
    `SELECT slug, content, updated_at FROM site_content WHERE slug = $1`,
    [slug]
  );

  return result.rowCount > 0 ? mapRow(result.rows[0]) : null;
}

async function listSiteContent(pool) {
  const result = await pool.query(
    `SELECT slug, content, updated_at FROM site_content ORDER BY slug ASC`
  );
  return result.rows.map(mapRow);
}

module.exports = { getSiteContent, listSiteContent };
