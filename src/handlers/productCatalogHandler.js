"use strict";

const {
  getFeaturedCategories,
  getProductFilters,
  getTags,
  searchProducts
} = require("../models/productModel");

function normalizePath(req) {
  const raw = req.path || req.url || "/";
  return String(raw).split("?")[0] || "/";
}

function firstQueryValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function listQueryValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function buildSearchCriteria(query = {}) {
  return {
    query: firstQueryValue(query.q) || firstQueryValue(query.query) || firstQueryValue(query.search),
    categories: listQueryValue(query.categories, query.categoryIds, query.category, query.categoryId),
    tags: listQueryValue(query.tags, query.tagIds, query.tag, query.tagId),
    minPriceCents: firstQueryValue(query.minPriceCents),
    maxPriceCents: firstQueryValue(query.maxPriceCents),
    leadTimeMaxDays: firstQueryValue(query.leadTimeMaxDays),
    sort: firstQueryValue(query.sort),
    cursor: firstQueryValue(query.cursor),
    limit: firstQueryValue(query.limit)
  };
}

function isSearchPath(path) {
  return path === "/products/search" || path === "/api/products/search";
}

function isFiltersPath(path) {
  return path === "/products/filters" || path === "/api/products/filters";
}

function isFeaturedCategoriesPath(path) {
  return (
    path === "/products/featured-categories" ||
    path === "/api/products/featured-categories"
  );
}

function isTagsPath(path) {
  return path === "/tags" || path === "/tags/" || path === "/api/tags" || path === "/api/tags/";
}

function createProductCatalogHandler({ getPool }) {
  return async function productCatalog(req, res) {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const path = normalizePath(req);

    try {
      const pool = getPool();

      if (isSearchPath(path)) {
        const result = await searchProducts(pool, buildSearchCriteria(req.query));
        return res.status(200).json(result);
      }

      if (isFiltersPath(path)) {
        const result = await getProductFilters(pool);
        return res.status(200).json(result);
      }

      if (isFeaturedCategoriesPath(path)) {
        const result = await getFeaturedCategories(pool, {
          limit: firstQueryValue(req.query?.limit)
        });
        return res.status(200).json(result);
      }

      if (isTagsPath(path)) {
        const result = await getTags(pool);
        return res.status(200).json(result);
      }

      return res.status(404).json({ error: "Catalog route not found" });
    } catch (error) {
      console.error("Failed to fetch product catalog", {
        path,
        message: error.message
      });
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

module.exports = {
  createProductCatalogHandler
};
