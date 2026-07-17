"use strict";

const { getSiteContent, listSiteContent } = require("../models/siteContentModel");

function extractSlug(req) {
  const raw = req.path || req.url || "/";
  const pathOnly = String(raw).split("?")[0] || "/";
  const match = pathOnly.match(/^(?:\/api)?\/site-content\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function createSiteContentHandler({ getPool }) {
  return async function siteContentHandler(req, res) {
    if (req.method !== "GET") {
      res.set("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const slug = extractSlug(req);

    try {
      const pool = getPool();

      if (!slug) {
        const sections = await listSiteContent(pool);
        return res.status(200).json({ sections });
      }

      const content = await getSiteContent(pool, slug);

      if (!content) {
        return res.status(404).json({ error: "Content not found" });
      }

      return res.status(200).json({ content });
    } catch (error) {
      console.error("Failed to fetch site content", {
        method: req.method,
        path: req.path || req.url,
        slug,
        message: error.message,
      });
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

module.exports = { createSiteContentHandler };
