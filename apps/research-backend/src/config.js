export function loadConfig() {
	return {
		port: parsePositiveInt(process.env.PORT) ?? 8787,
		host: process.env.HOST?.trim() || "0.0.0.0",
		requestTimeoutMs: parsePositiveInt(process.env.REQUEST_TIMEOUT_MS) ?? 30000,
		maxFetchedSources: parsePositiveInt(process.env.MAX_FETCHED_SOURCES) ?? 6,
		searxngUrl: trim(process.env.SEARXNG_URL),
		apiKey: trim(process.env.RESEARCH_API_KEY),
		githubToken: trim(process.env.GITHUB_TOKEN),
		userAgent: trim(process.env.USER_AGENT) || "pi-research-backend/0.5.0",
		browserMode: trim(process.env.BROWSER_MODE) || "auto",
		playwrightEnabled: parseBoolean(process.env.PLAYWRIGHT_ENABLED, false),
		structuredExtractionEnabled: parseBoolean(process.env.STRUCTURED_EXTRACTION_ENABLED, true),
		playwrightLaunchOptions: {
			headless: parseBoolean(process.env.PLAYWRIGHT_HEADLESS, true),
		},
		allowPrivateFetchHosts: splitCsv(process.env.ALLOW_PRIVATE_FETCH_HOSTS),
		cacheEnabled: parseBoolean(process.env.CACHE_ENABLED, true),
		searchCacheTtlMs: parsePositiveInt(process.env.SEARCH_CACHE_TTL_MS) ?? 300_000,
		fetchCacheTtlMs: parsePositiveInt(process.env.FETCH_CACHE_TTL_MS) ?? 900_000,
		renderedFetchCacheTtlMs: parsePositiveInt(process.env.RENDERED_FETCH_CACHE_TTL_MS) ?? 900_000,
		researchCacheTtlMs: parsePositiveInt(process.env.RESEARCH_CACHE_TTL_MS) ?? 300_000,
		analyzeCacheTtlMs: parsePositiveInt(process.env.ANALYZE_CACHE_TTL_MS) ?? 300_000,
		telemetryEnabled: parseBoolean(process.env.TELEMETRY_ENABLED, true),
		traceMode: trim(process.env.TRACE_MODE) || "standard",
		traceStoreLimit: parsePositiveInt(process.env.TRACE_STORE_LIMIT) ?? 100,
		providerCircuitBreakerEnabled: parseBoolean(process.env.PROVIDER_CIRCUIT_BREAKER_ENABLED, true),
		providerFailureThreshold: parsePositiveInt(process.env.PROVIDER_FAILURE_THRESHOLD) ?? 6,
		providerCooldownMs: parsePositiveInt(process.env.PROVIDER_COOLDOWN_MS) ?? 120000,
		researchProfile: trim(process.env.RESEARCH_PROFILE) || "stable",
		docsFetchRulesPath: trim(process.env.DOCS_FETCH_RULES_PATH),
	};
}

function trim(value) {
	const result = value?.trim();
	return result ? result : undefined;
}

function parsePositiveInt(value) {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoolean(value, defaultValue) {
	if (value == null) return defaultValue;
	const normalized = String(value).trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return defaultValue;
}

function splitCsv(value) {
	if (!value) return [];
	return String(value)
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
}
