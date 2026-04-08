import { hostnameFromUrl } from "../../lib/utils.js";
import { classifyUpstreamSearchError } from "../../errors.js";
import { inferSourceType } from "../../source-quality.js";

export async function searchSearxng(config, params, plan, fetchWithTimeout, logger, requestId) {
	if (!config.searxngUrl) {
		throw new Error("SEARXNG_URL is not configured");
	}
	const queries = buildProviderQueries(plan, params.preferredDomains || []);
	const diagnostics = {
		originalQuery: plan.originalQuery,
		normalizedQuery: plan.normalizedQuery,
		language: plan.language,
		intent: plan.intent,
		entities: plan.entities,
		queryRewrites: queries,
		provider: "searxng",
	};
	const collected = [];
	const errors = [];

	for (const query of queries) {
		try {
			const results = await runQueryWithRetry(config, params, query, fetchWithTimeout, logger, requestId);
			collected.push(...results);
		} catch (error) {
			const typed = classifyUpstreamSearchError(error, { provider: "searxng", query });
			errors.push({ code: typed.code, message: typed.message, retryable: typed.retryable, details: typed.details });
			logger?.warn("search.provider_failed", { requestId, provider: "searxng", query, error: typed });
		}
	}

	const results = dedupe(collected);
	const status = results.length > 0 ? (errors.length > 0 ? "partial_success" : "success") : "failure";
	if (results.length === 0 && errors.length === 0) {
		return {
			status: "no_results",
			results: [],
			errors: [],
			diagnostics,
		};
	}
	return { status, results, errors, diagnostics };
}

async function runQueryWithRetry(config, params, query, fetchWithTimeout, logger, requestId) {
	let lastError;
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			return await runQuery(config, params, query, fetchWithTimeout);
		} catch (error) {
			lastError = error;
			const typed = classifyUpstreamSearchError(error, { provider: "searxng", query });
			if (!typed.retryable || attempt === 2) break;
			logger?.warn("search.retrying", { requestId, provider: "searxng", query, attempt, code: typed.code });
			await sleep(250 * attempt + Math.floor(Math.random() * 150));
		}
	}
	throw lastError;
}

async function runQuery(config, params, query, fetchWithTimeout) {
	const url = new URL(joinUrl(config.searxngUrl, "/search"));
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("safesearch", "0");
	const category = sourceTypeToSearxngCategory(params.sourceType);
	if (category) url.searchParams.set("categories", category);
	const timeRange = freshnessToSearxng(params.freshness);
	if (timeRange) url.searchParams.set("time_range", timeRange);

	const response = await fetchWithTimeout(
		url.toString(),
		{
			method: "GET",
			headers: {
				"user-agent": config.userAgent,
				accept: "application/json",
			},
		},
		config.requestTimeoutMs,
		params.signal,
	);
	if (!response.ok) {
		throw new Error(`SearXNG search failed: HTTP ${response.status}`);
	}
	const raw = await response.json();
	const candidates = Array.isArray(raw?.results) ? raw.results : [];
	return candidates.map((item) => ({
		title: stringValue(item.title) ?? stringValue(item.url) ?? "Untitled",
		url: stringValue(item.url) ?? "",
		snippet: stringValue(item.content),
		domain: hostnameFromUrl(stringValue(item.url) ?? ""),
		sourceType: stringValue(item.sourceType) ?? inferSourceType(stringValue(item.url) ?? "", "general"),
		sourceCategory: stringValue(item.sourceCategory),
		resultType: stringValue(item.resultType),
		publishedAt: stringValue(item.publishedDate) ?? stringValue(item.date),
		engine: stringValue(item.engine),
		providerQuery: query,
	})).filter((item) => item.url);
}

function buildProviderQueries(plan, preferredDomains) {
	const queries = [...plan.variants];
	for (const domain of preferredDomains.slice(0, 3)) {
		queries.push(`${plan.normalizedQuery} site:${domain}`);
	}
	queries.push(plan.normalizedQuery.replace(/\bsite:[^\s]+/g, "").trim());
	return [...new Set(queries.filter(Boolean))].slice(0, 8);
}

function dedupe(results) {
	const seen = new Set();
	const output = [];
	for (const item of results) {
		if (seen.has(item.url)) continue;
		seen.add(item.url);
		output.push(item);
	}
	return output;
}

function joinUrl(base, path) {
	return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function stringValue(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sourceTypeToSearxngCategory(sourceType) {
	switch (sourceType) {
		case "news":
			return "news";
		case "github":
			return "it";
		default:
			return undefined;
	}
}

function freshnessToSearxng(freshness) {
	switch (freshness) {
		case "day":
			return "day";
		case "week":
			return "week";
		case "month":
			return "month";
		case "year":
			return "year";
		default:
			return undefined;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
