import http from "node:http";
import { loadConfig } from "./config.js";
import { decorateMetadata, buildAnalyzeResponseSections, buildResearchResponseSections } from "./contracts.js";
import { createCacheStore } from "./lib/cache.js";
import { errorResponse, json, methodNotAllowed, notFound, readJsonBody, unauthorized } from "./lib/http.js";
import { createLogger, nextRequestId } from "./lib/logger.js";
import { nowIso } from "./lib/utils.js";
import { analyzeWorkflow } from "./pipeline/analyze.js";
import { fetchWorkflow, researchWorkflow, searchWorkflow } from "./pipeline/research.js";

const config = loadConfig();
const cache = createCacheStore(config);
const logger = createLogger(config);

const server = http.createServer(async (req, res) => {
	const requestId = nextRequestId();
	const requestStartedAt = Date.now();
	const baseHeaders = { "x-request-id": requestId };
	try {
		if (!req.url) return notFound(res, baseHeaders);
		if (req.method === "OPTIONS") return json(res, 200, { ok: true }, baseHeaders);

		const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		logger.info("request.started", {
			requestId,
			method: req.method,
			path: url.pathname,
		});

		if (req.method === "GET" && url.pathname === "/health") {
			return json(res, 200, {
				ok: true,
				service: "pi-research-backend",
				time: nowIso(),
				config: {
					searxngConfigured: Boolean(config.searxngUrl),
					playwrightEnabled: config.playwrightEnabled,
					browserMode: config.browserMode,
					maxFetchedSources: config.maxFetchedSources,
					cacheEnabled: config.cacheEnabled,
					telemetryEnabled: config.telemetryEnabled,
				},
				cache: cache.stats(),
			}, baseHeaders);
		}

		if (url.pathname !== "/health" && !isAuthorized(config, req)) {
			logger.warn("request.unauthorized", { requestId, path: url.pathname });
			return unauthorized(res, baseHeaders);
		}

		if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST", "OPTIONS"], baseHeaders);
		const body = await readJsonBody(req);
		const helpers = { fetchWithTimeout, cache, logger, requestId };

		if (url.pathname === "/v1/search") {
			const result = await searchWorkflow(config, {
				query: body.query || "",
				freshness: body.freshness || "any",
				maxResults: body.maxResults || 8,
				preferredDomains: body.preferredDomains || [],
				blockedDomains: body.blockedDomains || [],
				sourceType: body.sourceType || "general",
				signal: undefined,
			}, helpers);
			return json(res, 200, {
				status: result.status,
				results: result.results,
				errors: result.errors,
				metadata: decorateMetadata("search", result.metadata || {}, {
					diagnostics: result.diagnostics,
					requestId,
					durationMs: Date.now() - requestStartedAt,
				}),
			}, baseHeaders);
		}

		if (url.pathname === "/v1/fetch") {
			const result = await fetchWorkflow(config, {
				url: body.url,
				mode: body.mode || "auto",
				extractionProfile: body.extractionProfile || "generic",
				signal: undefined,
			}, helpers);
			return json(res, 200, {
				...result,
				metadata: decorateMetadata("fetch", result.metadata || {}, {
					requestId,
					durationMs: Date.now() - requestStartedAt,
				}),
			}, baseHeaders);
		}

		if (url.pathname === "/v1/research") {
			const result = await researchWorkflow(config, {
				question: body.question || "",
				mode: body.mode || "general",
				freshness: body.freshness || "any",
				numberOfSources: body.numberOfSources || 5,
				sourcePolicy: body.sourcePolicy,
				outputDepth: body.outputDepth || "standard",
				preferredDomains: body.preferredDomains || [],
				blockedDomains: body.blockedDomains || [],
				signal: undefined,
			}, helpers);
			return json(res, 200, {
				...result,
				metadata: decorateMetadata("research", result.metadata || {}, {
					responseSections: buildResearchResponseSections(result),
					requestId,
					durationMs: Date.now() - requestStartedAt,
				}),
			}, baseHeaders);
		}

		if (url.pathname === "/v1/analyze") {
			const result = await analyzeWorkflow(config, {
				question: body.question || "",
				sources: Array.isArray(body.sources) ? body.sources : [],
				comparisonMode: body.comparisonMode || "best-evidence",
				signal: undefined,
			}, helpers);
			return json(res, 200, {
				...result,
				metadata: decorateMetadata("analyze", result.metadata || {}, {
					responseSections: buildAnalyzeResponseSections(result),
					requestId,
					durationMs: Date.now() - requestStartedAt,
				}),
			}, baseHeaders);
		}

		if (url.pathname === "/v1/cache/invalidate") {
			cache.clear(body.namespace);
			logger.info("cache.invalidated", { requestId, namespace: body.namespace || "all" });
			return json(res, 200, { ok: true, namespace: body.namespace || "all", cache: cache.stats() }, baseHeaders);
		}

		return notFound(res, baseHeaders);
	} catch (error) {
		logger.error("request.failed", {
			requestId,
			error,
			durationMs: Date.now() - requestStartedAt,
		});
		return errorResponse(res, error, baseHeaders);
	} finally {
		logger.info("request.finished", {
			requestId,
			durationMs: Date.now() - requestStartedAt,
		});
	}
});

server.listen(config.port, config.host, () => {
	console.log(`pi-research-backend listening on http://${config.host}:${config.port}`);
});

async function fetchWithTimeout(url, init, timeoutMs, signal) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const combined = mergeSignals(signal, controller.signal);
	try {
		return await fetch(url, { ...init, signal: combined });
	} finally {
		clearTimeout(timeout);
	}
}

function mergeSignals(a, b) {
	if (!a) return b;
	if (!b) return a;
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (a.aborted || b.aborted) {
		controller.abort();
		return controller.signal;
	}
	a.addEventListener("abort", abort, { once: true });
	b.addEventListener("abort", abort, { once: true });
	return controller.signal;
}

function isAuthorized(config, req) {
	if (!config.apiKey) return true;
	const header = String(req.headers.authorization || "");
	return header === `Bearer ${config.apiKey}`;
}
