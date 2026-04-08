import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const EXTENSION_NAME = "web-research";
const STATUS_KEY = "web-research";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 8;
const DIRECT_FETCH_MAX_CHARS = 12_000;
const DEFAULT_LOCAL_RESEARCH_BASE_URL = "http://127.0.0.1:8787";
const PROJECT_CONFIG_PATH = join(process.cwd(), ".pi", "web-research.json");
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "web-research.json");

type Freshness = "any" | "day" | "week" | "month" | "year";
type SourceType = "general" | "news" | "docs" | "github";
type ResearchMode = "general" | "news" | "technical" | "best-practice";
type OutputDepth = "brief" | "standard" | "deep";
type FetchMode = "fast" | "rendered" | "auto";
type ExtractionProfile = "article" | "docs" | "release-note" | "generic";
type ComparisonMode = "agreement" | "difference" | "timeline" | "best-evidence" | "official-vs-community";

type ConfigScope = "project" | "global";
type ConfigSource = "env" | "project" | "global" | "auto-local" | "defaults";

interface StoredResearchConfig {
	baseUrl?: string;
	apiKey?: string;
	searxngUrl?: string;
	timeoutMs?: number;
	userAgent?: string;
	autoLocal?: boolean;
}

interface ResearchConfig {
	baseUrl?: string;
	apiKey?: string;
	searxngUrl?: string;
	timeoutMs: number;
	userAgent: string;
	autoLocal: boolean;
	source: ConfigSource;
	configPath?: string;
}

interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
	sourceType?: string;
	sourceCategory?: string;
	resultType?: string;
	domain?: string;
	publishedAt?: string;
	score?: number;
	ranking?: Record<string, unknown>;
}

interface FetchResult {
	url: string;
	canonicalUrl?: string;
	title?: string;
	content: string;
	extractionProfile?: string;
	fetchMode?: string;
	contentType?: string;
	status?: number;
	metadata?: Record<string, unknown>;
}

interface ResearchSource {
	title?: string;
	url?: string;
	snippet?: string;
	excerpt?: string;
	sourceType?: string;
	sourceCategory?: string;
	resultType?: string;
	publishedAt?: string;
	confidence?: string;
	score?: number;
	ranking?: Record<string, unknown>;
}

interface ResearchOutput {
	answer?: string;
	recommendation?: string;
	summary?: string;
	findings?: string[];
	bestPractices?: string[];
	tradeOffs?: string[];
	risks?: string[];
	mitigations?: string[];
	agreements?: string[];
	disagreements?: string[];
	sources?: ResearchSource[];
	confidence?: string;
	gaps?: string[];
	metadata?: Record<string, unknown>;
}

interface AnalyzeOutput {
	summary?: string;
	agreements?: string[];
	disagreements?: string[];
	strongestEvidence?: string[];
	gaps?: string[];
	sources?: ResearchSource[];
	metadata?: Record<string, unknown>;
}

const SearchWebParams = Type.Object({
	query: Type.String({ description: "What to search for on the public web" }),
	freshness: Type.Optional(StringEnum(["any", "day", "week", "month", "year"] as const, { description: "Freshness window" })),
	maxResults: Type.Optional(Type.Number({ description: "Maximum number of results to return", minimum: 1, maximum: 20 })),
	preferredDomains: Type.Optional(Type.Array(Type.String({ description: "Domains to prefer, e.g. docs.python.org" }))),
	blockedDomains: Type.Optional(Type.Array(Type.String({ description: "Domains to exclude" }))),
	sourceType: Type.Optional(
		StringEnum(["general", "news", "docs", "github"] as const, { description: "Preferred source class" }),
	),
});

const FetchUrlParams = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
	mode: Type.Optional(StringEnum(["fast", "rendered", "auto"] as const, { description: "Fetch mode" })),
	extractionProfile: Type.Optional(
		StringEnum(["article", "docs", "release-note", "generic"] as const, { description: "Extraction profile" }),
	),
});

const ResearchQueryParams = Type.Object({
	question: Type.String({ description: "Research question to answer" }),
	mode: Type.Optional(
		StringEnum(["general", "news", "technical", "best-practice"] as const, { description: "Research mode" }),
	),
	freshness: Type.Optional(StringEnum(["any", "day", "week", "month", "year"] as const)),
	numberOfSources: Type.Optional(Type.Number({ description: "How many sources to consider", minimum: 1, maximum: 12 })),
	sourcePolicy: Type.Optional(Type.String({ description: "Optional source-selection guidance" })),
	outputDepth: Type.Optional(StringEnum(["brief", "standard", "deep"] as const, { description: "Desired output depth" })),
	preferredDomains: Type.Optional(Type.Array(Type.String())),
	blockedDomains: Type.Optional(Type.Array(Type.String())),
});

const AnalyzeSourcesParams = Type.Object({
	question: Type.String({ description: "Question or evaluation criteria for the source set" }),
	sources: Type.Array(
		Type.Object({
			url: Type.Optional(Type.String({ description: "Source URL" })),
			title: Type.Optional(Type.String({ description: "Optional title for the source" })),
			content: Type.Optional(Type.String({ description: "Optional already-fetched source content" })),
		}),
	),
	comparisonMode: Type.Optional(
		StringEnum(["agreement", "difference", "timeline", "best-evidence", "official-vs-community"] as const),
	),
});

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const config = await getConfig();
		ctx.ui.setStatus(STATUS_KEY, statusText(config));
	});

	pi.registerCommand("web-research", {
		description: "Open the web-research menu",
		handler: async (args, ctx) => {
			await handleResearchCommand(args, ctx);
		},
	});

	pi.registerTool({
		name: "search_web",
		label: "Search Web",
		description:
			"Search the public web for relevant sources. Use this first for current events, best-practice questions, technical research, and when you need candidate URLs before fetching content.",
		promptSnippet: "Search the public web for relevant sources with optional freshness and domain filters.",
		promptGuidelines: [
			"Use this tool first when you need to discover candidate sources on the web.",
			"Prefer official docs, release notes, and authoritative reporting when available.",
			"After finding promising URLs, use fetch_url or research_query rather than guessing from snippets alone.",
		],
		parameters: SearchWebParams,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const config = await getConfig();
			const maxResults = Math.max(1, Math.min(20, Math.floor(params.maxResults ?? DEFAULT_MAX_RESULTS)));
			const results = await performSearch(config, {
				query: params.query,
				freshness: (params.freshness ?? "any") as Freshness,
				maxResults,
				preferredDomains: params.preferredDomains ?? [],
				blockedDomains: params.blockedDomains ?? [],
				sourceType: (params.sourceType ?? "general") as SourceType,
			}, signal);

			const text = renderSearchResults(params.query, results);
			const finalized = await finalizeTextOutput("search-web", text);
			return {
				content: [{ type: "text", text: finalized.text }],
				details: {
					query: params.query,
					resultCount: results.length,
					results,
					...finalized.details,
				},
			};
		},
	});

	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description:
			"Fetch and clean a specific page for research. Use after search_web when you need the actual page content, especially for docs, release notes, articles, or official guidance.",
		promptSnippet: "Fetch and clean a specific URL for grounded research.",
		promptGuidelines: [
			"Use this tool after search_web when snippets are insufficient.",
			"Prefer fetching the official or highest-authority page before summarizing.",
			"When content is large, inspect the cleaned output and cite the source rather than quoting raw HTML.",
		],
		parameters: FetchUrlParams,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const config = await getConfig();
			const fetched = await performFetch(config, {
				url: params.url,
				mode: (params.mode ?? "auto") as FetchMode,
				extractionProfile: (params.extractionProfile ?? "generic") as ExtractionProfile,
			}, signal);
			const text = renderFetchResult(fetched);
			const finalized = await finalizeTextOutput("fetch-url", text);
			return {
				content: [{ type: "text", text: finalized.text }],
				details: {
					fetch: fetched,
					...finalized.details,
				},
			};
		},
	});

	pi.registerTool({
		name: "research_query",
		label: "Research Query",
		description:
			"Perform grounded web research across multiple sources. Use for current events, technical/product change analysis, and best-practice questions where you need a sourced answer rather than isolated pages.",
		promptSnippet:
			"Run multi-source web research with citations and explicit confidence/gap notes.",
		promptGuidelines: [
			"Use this tool for multi-source research questions instead of ad hoc browsing when you need a grounded answer.",
			"Prefer this tool for current events, technical change analysis, and best-practice research.",
			"Base your answer and citations on the sources returned by this tool; do not invent or substitute citations.",
			"If the evidence is weak or conflicting, call that out rather than overclaiming certainty.",
		],
		parameters: ResearchQueryParams,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const config = await getConfig();
			const result = await performResearchQuery(
				config,
				{
					question: params.question,
					mode: (params.mode ?? "general") as ResearchMode,
					freshness: (params.freshness ?? "any") as Freshness,
					numberOfSources: Math.max(1, Math.min(12, Math.floor(params.numberOfSources ?? 5))),
					sourcePolicy: params.sourcePolicy,
					outputDepth: (params.outputDepth ?? "standard") as OutputDepth,
					preferredDomains: params.preferredDomains ?? [],
					blockedDomains: params.blockedDomains ?? [],
				},
				signal,
			);
			const text = renderResearchOutput(params.question, result);
			const finalized = await finalizeTextOutput("research-query", text);
			return {
				content: [{ type: "text", text: finalized.text }],
				details: {
					research: result,
					...finalized.details,
				},
			};
		},
	});

	pi.registerTool({
		name: "analyze_sources",
		label: "Analyze Sources",
		description:
			"Compare and structure evidence across multiple URLs or provided source documents. Use when you already have sources and need agreement, difference, timeline, strongest-evidence, or official-vs-community analysis.",
		promptSnippet:
			"Compare and structure evidence across a known set of web sources with citations.",
		promptGuidelines: [
			"Use this tool when you already know the relevant sources and need structured comparison.",
			"Prefer this tool for agreement, difference, timeline, and official-vs-community analysis.",
			"Base your comparison and citations on the sources returned or supplied here; do not invent consensus or substitute outside citations.",
			"Do not invent consensus; report conflicts explicitly when sources diverge.",
		],
		parameters: AnalyzeSourcesParams,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const config = await getConfig();
			const result = await performAnalyzeSources(
				config,
				{
					question: params.question,
					sources: params.sources,
					comparisonMode: (params.comparisonMode ?? "best-evidence") as ComparisonMode,
				},
				signal,
			);
			const text = renderAnalyzeOutput(params.question, params.comparisonMode ?? "best-evidence", result);
			const finalized = await finalizeTextOutput("analyze-sources", text);
			return {
				content: [{ type: "text", text: finalized.text }],
				details: {
					analysis: result,
					...finalized.details,
				},
			};
		},
	});
}

async function getConfig(): Promise<ResearchConfig> {
	const projectConfig = await readStoredConfig(PROJECT_CONFIG_PATH);
	const globalConfig = projectConfig ? undefined : await readStoredConfig(GLOBAL_CONFIG_PATH);
	const storedConfig = projectConfig ?? globalConfig ?? {};
	const envConfigured = [
		process.env.PI_RESEARCH_BASE_URL,
		process.env.PI_RESEARCH_API_KEY,
		process.env.PI_RESEARCH_SEARXNG_URL,
		process.env.PI_RESEARCH_TIMEOUT_MS,
		process.env.PI_RESEARCH_USER_AGENT,
		process.env.PI_RESEARCH_AUTO_LOCAL,
	].some((value) => trimToUndefined(value) != null);
	const autoLocal = parseBoolean(process.env.PI_RESEARCH_AUTO_LOCAL, storedConfig.autoLocal ?? true);
	const configuredBaseUrl = trimToUndefined(process.env.PI_RESEARCH_BASE_URL) ?? trimToUndefined(storedConfig.baseUrl);
	const baseUrl = configuredBaseUrl ?? (autoLocal ? DEFAULT_LOCAL_RESEARCH_BASE_URL : undefined);
	const apiKey = trimToUndefined(process.env.PI_RESEARCH_API_KEY) ?? trimToUndefined(storedConfig.apiKey);
	const searxngUrl = trimToUndefined(process.env.PI_RESEARCH_SEARXNG_URL) ?? trimToUndefined(storedConfig.searxngUrl);
	const timeoutMs = parsePositiveInt(process.env.PI_RESEARCH_TIMEOUT_MS) ?? storedConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const userAgent = trimToUndefined(process.env.PI_RESEARCH_USER_AGENT) ?? trimToUndefined(storedConfig.userAgent) ?? `${EXTENSION_NAME}/0.1`;
	const source: ConfigSource = envConfigured
		? "env"
		: projectConfig
			? "project"
			: globalConfig
				? "global"
				: baseUrl === DEFAULT_LOCAL_RESEARCH_BASE_URL && autoLocal
					? "auto-local"
					: "defaults";
	const configPath = source === "project" ? PROJECT_CONFIG_PATH : source === "global" ? GLOBAL_CONFIG_PATH : undefined;
	return { baseUrl, apiKey, searxngUrl, timeoutMs, userAgent, autoLocal, source, configPath };
}

async function readStoredConfig(path: string): Promise<StoredResearchConfig | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return undefined;
		return {
			baseUrl: trimToUndefined(parsed.baseUrl),
			apiKey: trimToUndefined(parsed.apiKey),
			searxngUrl: trimToUndefined(parsed.searxngUrl),
			timeoutMs: typeof parsed.timeoutMs === "number" && Number.isFinite(parsed.timeoutMs) && parsed.timeoutMs > 0 ? parsed.timeoutMs : undefined,
			userAgent: trimToUndefined(parsed.userAgent),
			autoLocal: typeof parsed.autoLocal === "boolean" ? parsed.autoLocal : undefined,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		return undefined;
	}
}

async function writeStoredConfig(scope: ConfigScope, patch: Partial<StoredResearchConfig>) {
	const path = scope === "project" ? PROJECT_CONFIG_PATH : GLOBAL_CONFIG_PATH;
	const current = (await readStoredConfig(path)) ?? {};
	const next: StoredResearchConfig = {
		...current,
		...patch,
	};
	for (const key of Object.keys(next) as Array<keyof StoredResearchConfig>) {
		if (next[key] == null || next[key] === "") delete next[key];
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return path;
}

async function removeStoredConfig(scope: ConfigScope) {
	const path = scope === "project" ? PROJECT_CONFIG_PATH : GLOBAL_CONFIG_PATH;
	try {
		await unlink(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
		throw error;
	}
}

async function chooseConfigScope(ctx): Promise<ConfigScope | undefined> {
	const choice = await ctx.ui.select("Save web-research settings", [
		`Project (${PROJECT_CONFIG_PATH})`,
		`Global (${GLOBAL_CONFIG_PATH})`,
	]);
	if (!choice) return undefined;
	return choice.startsWith("Project") ? "project" : "global";
}

async function refreshResearchStatus(ctx) {
	const config = await getConfig();
	ctx.ui.setStatus(STATUS_KEY, statusText(config));
	return config;
}

async function showResearchHealth(ctx) {
	const config = await refreshResearchStatus(ctx);
	const result = await healthCheck(config);
	ctx.ui.notify(result.ok ? `Research health OK: ${result.message}` : `Research health FAILED: ${result.message}`, result.ok ? "info" : "error");
}

async function showResearchStatus(ctx) {
	const config = await refreshResearchStatus(ctx);
	const health = await healthCheck(config);
	ctx.ui.notify([
		configSummary(config),
		`health: ${health.ok ? "ok" : "failed"}`,
		`healthDetail: ${health.message}`,
	].join("\n"), health.ok ? "info" : "error");
}

async function configureBackendUrl(ctx) {
	const scope = await chooseConfigScope(ctx);
	if (!scope) return;
	const current = await readStoredConfig(scope === "project" ? PROJECT_CONFIG_PATH : GLOBAL_CONFIG_PATH);
	const value = await ctx.ui.input("Research backend URL", current?.baseUrl ?? DEFAULT_LOCAL_RESEARCH_BASE_URL);
	if (value == null) return;
	const path = await writeStoredConfig(scope, { baseUrl: trimToUndefined(value) });
	await refreshResearchStatus(ctx);
	ctx.ui.notify(`Saved backend URL to ${path}`, "info");
}

async function configureApiKey(ctx) {
	const scope = await chooseConfigScope(ctx);
	if (!scope) return;
	const current = await readStoredConfig(scope === "project" ? PROJECT_CONFIG_PATH : GLOBAL_CONFIG_PATH);
	const value = await ctx.ui.input("Research API key", current?.apiKey ? "set (enter a new value or leave blank to clear)" : "");
	if (value == null) return;
	const path = await writeStoredConfig(scope, { apiKey: trimToUndefined(value) });
	await refreshResearchStatus(ctx);
	ctx.ui.notify(`Saved API key to ${path}`, "info");
}

async function configureSearxngUrl(ctx) {
	const scope = await chooseConfigScope(ctx);
	if (!scope) return;
	const current = await readStoredConfig(scope === "project" ? PROJECT_CONFIG_PATH : GLOBAL_CONFIG_PATH);
	const value = await ctx.ui.input("Direct-search fallback URL", current?.searxngUrl ?? "http://127.0.0.1:8080");
	if (value == null) return;
	const path = await writeStoredConfig(scope, { searxngUrl: trimToUndefined(value) });
	await refreshResearchStatus(ctx);
	ctx.ui.notify(`Saved direct-search fallback URL to ${path}`, "info");
}

async function configureAdvancedSettings(ctx) {
	const scope = await chooseConfigScope(ctx);
	if (!scope) return;
	const path = scope === "project" ? PROJECT_CONFIG_PATH : GLOBAL_CONFIG_PATH;
	const current = (await readStoredConfig(path)) ?? {};
	const timeoutInput = await ctx.ui.input("Request timeout (ms)", String(current.timeoutMs ?? DEFAULT_TIMEOUT_MS));
	if (timeoutInput == null) return;
	const userAgentInput = await ctx.ui.input("User agent", current.userAgent ?? `${EXTENSION_NAME}/0.1`);
	if (userAgentInput == null) return;
	const autoLocalChoice = await ctx.ui.select("Auto-connect to local backend if no backend URL is saved?", [
		current.autoLocal === false ? "Keep disabled" : "Keep enabled",
		"Enable",
		"Disable",
	]);
	if (!autoLocalChoice) return;
	const autoLocal = autoLocalChoice === "Disable" ? false : autoLocalChoice === "Enable" ? true : (current.autoLocal ?? true);
	const timeoutMs = parsePositiveInt(timeoutInput) ?? DEFAULT_TIMEOUT_MS;
	const savedPath = await writeStoredConfig(scope, {
		timeoutMs,
		userAgent: trimToUndefined(userAgentInput) ?? `${EXTENSION_NAME}/0.1`,
		autoLocal,
	});
	await refreshResearchStatus(ctx);
	ctx.ui.notify(`Saved advanced settings to ${savedPath}`, "info");
}

async function clearSavedConfig(ctx) {
	const scope = await chooseConfigScope(ctx);
	if (!scope) return;
	const path = scope === "project" ? PROJECT_CONFIG_PATH : GLOBAL_CONFIG_PATH;
	const ok = await ctx.ui.confirm("Clear saved settings?", `Remove ${path}?`);
	if (!ok) return;
	const removed = await removeStoredConfig(scope);
	await refreshResearchStatus(ctx);
	ctx.ui.notify(removed ? `Removed ${path}` : `No saved config at ${path}`, "info");
}

async function handleResearchCommand(args: string | undefined, ctx) {
	const normalized = String(args ?? "").trim().toLowerCase();
	if (normalized === "status" || normalized === "show" || normalized === "config") {
		await showResearchStatus(ctx);
		return;
	}
	if (normalized === "health") {
		await showResearchHealth(ctx);
		return;
	}
	if (normalized === "setup" || normalized === "configure") {
		await configureBackendUrl(ctx);
		return;
	}
	while (true) {
		const config = await getConfig();
		const choice = await ctx.ui.select("web-research", [
			`Show status (${config.source})`,
			"Configure backend URL",
			`${config.apiKey ? "Update" : "Set"} API key`,
			"Configure direct-search fallback",
			"Advanced settings",
			"Clear saved config",
		]);
		if (!choice) return;
		if (choice.startsWith("Show status")) await showResearchStatus(ctx);
		else if (choice === "Configure backend URL") await configureBackendUrl(ctx);
		else if (choice.endsWith("API key")) await configureApiKey(ctx);
		else if (choice === "Configure direct-search fallback") await configureSearxngUrl(ctx);
		else if (choice === "Advanced settings") await configureAdvancedSettings(ctx);
		else if (choice === "Clear saved config") await clearSavedConfig(ctx);
	}
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
	if (value == null) return defaultValue;
	const normalized = String(value).trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return defaultValue;
}

function statusText(config: ResearchConfig): string {
	if (config.baseUrl) return "research: backend";
	if (config.searxngUrl) return "research: direct";
	return "research: fetch-only";
}

function configSummary(config: ResearchConfig): string {
	return [
		`mode: ${config.baseUrl ? "backend" : config.searxngUrl ? "direct" : "fetch-only"}`,
		`source: ${config.source}${config.configPath ? ` (${config.configPath})` : ""}`,
		`backend: ${config.baseUrl ?? "not set"}`,
		`searxng: ${config.searxngUrl ?? "not set"}`,
		`timeoutMs: ${config.timeoutMs}`,
		`autoLocal: ${config.autoLocal ? "enabled" : "disabled"}`,
		`apiKey: ${config.apiKey ? "set" : "not set"}`,
	].join(" | ");
}

async function healthCheck(config: ResearchConfig): Promise<{ ok: boolean; message: string }> {
	try {
		if (config.baseUrl) {
			const res = await fetchWithTimeout(joinUrl(config.baseUrl, "/health"), {
				method: "GET",
				headers: buildHeaders(config),
			}, config.timeoutMs);
			if (!res.ok) {
				return { ok: false, message: `backend HTTP ${res.status}` };
			}
			const data = await res.json().catch(() => ({} as any));
			if (data?.config?.searxngConfigured === false) {
				return { ok: true, message: `backend ${config.baseUrl} (fetch available, search disabled: backend SEARXNG_URL not configured)` };
			}
			return { ok: true, message: `backend ${config.baseUrl}` };
		}
		if (config.searxngUrl) {
			const url = new URL(joinUrl(config.searxngUrl, "/search"));
			url.searchParams.set("q", "pi web research health");
			url.searchParams.set("format", "json");
			const res = await fetchWithTimeout(url.toString(), {
				method: "GET",
				headers: buildHeaders(config),
			}, config.timeoutMs);
			if (!res.ok) {
				return { ok: false, message: `searxng HTTP ${res.status}` };
			}
			return { ok: true, message: `searxng ${config.searxngUrl}` };
		}
		return { ok: true, message: "direct fetch fallback only; no backend configured" };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

function buildHeaders(config: ResearchConfig, extra?: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = {
		"user-agent": config.userAgent,
		accept: "application/json, text/html, text/plain;q=0.9, */*;q=0.8",
		...extra,
	};
	if (config.apiKey) {
		headers.authorization = `Bearer ${config.apiKey}`;
	}
	return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const combined = mergeSignals(signal, controller.signal);
	try {
		return await fetch(url, { ...init, signal: combined });
	} finally {
		clearTimeout(timeout);
	}
}

function mergeSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
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

function joinUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

async function postJson<T>(config: ResearchConfig, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
	if (!config.baseUrl) {
		throw new Error("PI_RESEARCH_BASE_URL is not configured");
	}
	const response = await fetchWithTimeout(
		joinUrl(config.baseUrl, path),
		{
			method: "POST",
			headers: buildHeaders(config, { "content-type": "application/json" }),
			body: JSON.stringify(body),
		},
		config.timeoutMs,
		signal,
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(formatBackendError(path, response.status, text, config));
	}
	return (await response.json()) as T;
}

async function performSearch(
	config: ResearchConfig,
	params: {
		query: string;
		freshness: Freshness;
		maxResults: number;
		preferredDomains: string[];
		blockedDomains: string[];
		sourceType: SourceType;
	},
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	let backendError: unknown;
	if (config.baseUrl) {
		try {
			const raw = await postJson<any>(config, "/v1/search", params, signal);
			return normalizeSearchResults(raw).slice(0, params.maxResults);
		} catch (error) {
			backendError = error;
			if (!config.searxngUrl) throw error;
		}
	}
	if (!config.searxngUrl) {
		throw backendError instanceof Error ? backendError : new Error("No research backend configured. Set PI_RESEARCH_BASE_URL or PI_RESEARCH_SEARXNG_URL.");
	}
	return await searchViaSearxng(config, params, signal);
}

async function searchViaSearxng(
	config: ResearchConfig,
	params: {
		query: string;
		freshness: Freshness;
		maxResults: number;
		preferredDomains: string[];
		blockedDomains: string[];
		sourceType: SourceType;
	},
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const url = new URL(joinUrl(config.searxngUrl!, "/search"));
	url.searchParams.set("q", params.query);
	url.searchParams.set("format", "json");
	url.searchParams.set("safesearch", "0");
	const category = sourceTypeToSearxngCategory(params.sourceType);
	if (category) url.searchParams.set("categories", category);
	const timeRange = freshnessToSearxng(params.freshness);
	if (timeRange) url.searchParams.set("time_range", timeRange);

	const response = await fetchWithTimeout(
		url.toString(),
		{ method: "GET", headers: buildHeaders(config) },
		config.timeoutMs,
		signal,
	);
	if (!response.ok) {
		throw new Error(`SearXNG search failed: HTTP ${response.status}`);
	}
	const raw = await response.json();
	let results = normalizeSearchResults(raw);
	results = applyDomainFilters(results, params.preferredDomains, params.blockedDomains);
	return results.slice(0, params.maxResults);
}

function formatBackendError(path: string, status: number, text: string, config: ResearchConfig): string {
	if (text.includes("SEARXNG_URL is required for search workflow")) {
		return [
			`Research backend search is disabled for ${path}.`,
			`The backend is running, but discovery is not configured (missing SEARXNG_URL).`,
			config.searxngUrl
				? `Set SEARXNG_URL on the backend or keep PI_RESEARCH_SEARXNG_URL=${config.searxngUrl} so direct search fallback can be used.`
				: "Start the full research stack (for example: npm run dev:research-stack:up) or set PI_RESEARCH_SEARXNG_URL for direct-mode search.",
		].join(" ");
	}
	return `Research backend ${path} failed: HTTP ${status} ${text}`;
}

function sourceTypeToSearxngCategory(sourceType: SourceType): string | undefined {
	switch (sourceType) {
		case "news":
			return "news";
		case "github":
			return "it";
		default:
			return undefined;
	}
}

function freshnessToSearxng(freshness: Freshness): string | undefined {
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

function applyDomainFilters(results: SearchResult[], preferredDomains: string[], blockedDomains: string[]): SearchResult[] {
	const preferred = preferredDomains.map(normalizeDomain).filter(Boolean) as string[];
	const blocked = blockedDomains.map(normalizeDomain).filter(Boolean) as string[];
	let filtered = results.filter((result) => {
		const domain = normalizeDomain(result.domain ?? hostnameFromUrl(result.url));
		if (!domain) return true;
		return !blocked.some((blockedDomain) => domain === blockedDomain || domain.endsWith(`.${blockedDomain}`));
	});
	if (preferred.length === 0) return filtered;
	return filtered.sort((a, b) => {
		const aPreferred = matchesPreferred(a, preferred) ? 1 : 0;
		const bPreferred = matchesPreferred(b, preferred) ? 1 : 0;
		return bPreferred - aPreferred;
	});
}

function matchesPreferred(result: SearchResult, preferred: string[]): boolean {
	const domain = normalizeDomain(result.domain ?? hostnameFromUrl(result.url));
	if (!domain) return false;
	return preferred.some((preferredDomain) => domain === preferredDomain || domain.endsWith(`.${preferredDomain}`));
}

function normalizeDomain(domain: string | undefined): string | undefined {
	const value = domain?.trim().toLowerCase();
	if (!value) return undefined;
	return value.replace(/^www\./, "");
}

function hostnameFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

function normalizeSearchResults(raw: any): SearchResult[] {
	const candidates = Array.isArray(raw?.results)
		? raw.results
		: Array.isArray(raw?.items)
			? raw.items
			: Array.isArray(raw?.sources)
				? raw.sources
				: [];
	return candidates
		.map((item: any) => ({
			title: stringify(item.title) ?? stringify(item.name) ?? stringify(item.url) ?? "Untitled",
			url: stringify(item.url) ?? stringify(item.link) ?? stringify(item.href) ?? "",
			snippet: stringify(item.snippet) ?? stringify(item.content) ?? stringify(item.description),
			sourceType: stringify(item.sourceType) ?? classifyUrl(stringify(item.url) ?? stringify(item.link) ?? ""),
			sourceCategory: stringify(item.sourceCategory) ?? stringify(item.category),
			resultType: stringify(item.resultType),
			domain: stringify(item.domain) ?? hostnameFromUrl(stringify(item.url) ?? stringify(item.link) ?? ""),
			publishedAt: stringify(item.publishedAt) ?? stringify(item.publishedDate) ?? stringify(item.date),
			score: numberOrUndefined(item.score),
			ranking: isRecord(item.ranking) ? item.ranking : undefined,
		}))
		.filter((item: SearchResult) => Boolean(item.url));
}

function stringify(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function classifyUrl(url: string): string {
	const host = hostnameFromUrl(url)?.toLowerCase() ?? "";
	const value = url.toLowerCase();
	if (host.includes("github.com")) return "github";
	if (host.includes("docs.") || /\/docs\/|\/reference\/|\/guide\//.test(value)) return "docs";
	return "general";
}

function classifySourceCategory(url?: string, title?: string): string | undefined {
	const host = hostnameFromUrl(url)?.toLowerCase() ?? "";
	const value = (url ?? "").toLowerCase();
	const lowerTitle = (title ?? "").toLowerCase();
	if (host.includes("github.com")) {
		if (value.includes("/pull/")) return "github-pr";
		if (value.includes("/issues/")) return "github-issue";
		if (value.includes("/discussions/")) return "github-discussion";
		return "github-repo";
	}
	if (host.includes("docs.") || /\/docs\/|\/reference\/|\/guide\//.test(value)) return "official-docs";
	if (/release|changelog|release-notes/.test(`${value} ${lowerTitle}`)) return "release-notes";
	if (/reddit\.com$|stackoverflow\.com$|news\.ycombinator\.com$/.test(host) || host.startsWith("community.")) return "forum-community";
	if (host.startsWith("blog." ) || /\/blog\//.test(value)) return "vendor-blog";
	return undefined;
}

async function performFetch(
	config: ResearchConfig,
	params: { url: string; mode: FetchMode; extractionProfile: ExtractionProfile },
	signal?: AbortSignal,
): Promise<FetchResult> {
	if (config.baseUrl) {
		try {
			const raw = await postJson<any>(config, "/v1/fetch", params, signal);
			return normalizeFetchResult(raw, params.url, params.mode, params.extractionProfile);
		} catch {
			// Fall through to direct fetch.
		}
	}
	return await directFetch(config, params.url, params.mode, params.extractionProfile, signal);
}

async function directFetch(
	config: ResearchConfig,
	url: string,
	mode: FetchMode,
	extractionProfile: ExtractionProfile,
	signal?: AbortSignal,
): Promise<FetchResult> {
	const response = await fetchWithTimeout(
		url,
		{ method: "GET", headers: buildHeaders(config, { accept: "text/html, text/plain, application/xhtml+xml;q=0.9, */*;q=0.8" }) },
		config.timeoutMs,
		signal,
	);
	if (!response.ok) {
		throw new Error(`Direct fetch failed: HTTP ${response.status}`);
	}
	const contentType = response.headers.get("content-type") ?? undefined;
	const body = await response.text();
	const title = extractTitle(body);
	const canonicalUrl = extractCanonicalUrl(body) ?? url;
	const content = isHtmlContent(contentType, body) ? htmlToText(body).slice(0, DIRECT_FETCH_MAX_CHARS) : body.slice(0, DIRECT_FETCH_MAX_CHARS);
	return {
		url,
		canonicalUrl,
		title,
		content,
		extractionProfile,
		fetchMode: mode,
		contentType,
		status: response.status,
		metadata: {
			strategy: "direct-fetch",
			truncatedAtChars: DIRECT_FETCH_MAX_CHARS,
		},
	};
}

function normalizeFetchResult(raw: any, fallbackUrl: string, mode: string, extractionProfile: string): FetchResult {
	return {
		url: stringify(raw?.url) ?? fallbackUrl,
		canonicalUrl: stringify(raw?.canonicalUrl) ?? stringify(raw?.canonical_url),
		title: stringify(raw?.title),
		content: stringify(raw?.content) ?? stringify(raw?.markdown) ?? stringify(raw?.text) ?? stringify(raw?.body) ?? "",
		extractionProfile: stringify(raw?.extractionProfile) ?? stringify(raw?.profile) ?? extractionProfile,
		fetchMode: stringify(raw?.fetchMode) ?? stringify(raw?.mode) ?? mode,
		contentType: stringify(raw?.contentType),
		status: numberOrUndefined(raw?.status),
		metadata: isRecord(raw?.metadata) ? raw.metadata : undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHtmlContent(contentType: string | undefined, body: string): boolean {
	return (contentType?.includes("html") ?? false) || /<html|<body|<article|<main/i.test(body);
}

function extractTitle(html: string): string | undefined {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? cleanupWhitespace(decodeEntities(match[1])) : undefined;
}

function extractCanonicalUrl(html: string): string | undefined {
	const match = html.match(/<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i);
	return match?.[1];
}

function htmlToText(html: string): string {
	const withoutScripts = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
	const withBreaks = withoutScripts
		.replace(/<(br|hr)\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|main|aside|header|footer|li|ul|ol|h1|h2|h3|h4|h5|h6)>/gi, "\n");
	const stripped = withBreaks.replace(/<[^>]+>/g, " ");
	return cleanupWhitespace(decodeEntities(stripped));
}

function cleanupWhitespace(text: string): string {
	return text
		.replace(/\r/g, "")
		.replace(/\t/g, " ")
		.replace(/[ \u00A0]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line, index, arr) => line.length > 0 || (index > 0 && arr[index - 1].length > 0))
		.join("\n")
		.trim();
}

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

async function performResearchQuery(
	config: ResearchConfig,
	params: {
		question: string;
		mode: ResearchMode;
		freshness: Freshness;
		numberOfSources: number;
		sourcePolicy?: string;
		outputDepth: OutputDepth;
		preferredDomains: string[];
		blockedDomains: string[];
	},
	signal?: AbortSignal,
): Promise<ResearchOutput> {
	let backendError: unknown;
	if (config.baseUrl) {
		try {
			const raw = await postJson<any>(config, "/v1/research", params, signal);
			return normalizeResearchOutput(raw);
		} catch (error) {
			backendError = error;
			// Fall back to direct bundle generation below.
		}
	}
	if (!config.searxngUrl) {
		throw backendError instanceof Error
			? backendError
			: new Error("research_query requires PI_RESEARCH_BASE_URL or PI_RESEARCH_SEARXNG_URL.");
	}
	const searchResults = await searchViaSearxng(
		config,
		{
			query: params.question,
			freshness: params.freshness,
			maxResults: params.numberOfSources,
			preferredDomains: params.preferredDomains,
			blockedDomains: params.blockedDomains,
			sourceType: modeToSourceType(params.mode),
		},
		signal,
	);
	const selected = searchResults.slice(0, params.numberOfSources);
	const fetched = await Promise.all(
		selected.map(async (result) => {
			try {
				const page = await directFetch(config, result.url, "auto", mapModeToProfile(params.mode), signal);
				return {
					title: page.title ?? result.title,
					url: page.canonicalUrl ?? result.url,
					snippet: result.snippet,
					excerpt: page.content.slice(0, excerptLength(params.outputDepth)),
					sourceType: result.sourceType,
					sourceCategory: classifySourceCategory(page.canonicalUrl ?? result.url, page.title ?? result.title),
					publishedAt: result.publishedAt,
				};
			} catch {
				return {
					title: result.title,
					url: result.url,
					snippet: result.snippet,
					sourceType: result.sourceType,
					sourceCategory: classifySourceCategory(result.url, result.title),
					publishedAt: result.publishedAt,
				};
			}
		}),
	);
	const agreements = [
		fetched.length > 0 ? `Fallback mode assembled ${fetched.length} grounded source packet(s).` : undefined,
		fetched.some((source) => source.sourceCategory === "official-docs") ? `At least one source looks like official documentation.` : undefined,
	].filter(Boolean) as string[];
	const disagreements = [
		"Fallback mode does not compute backend-side disagreement heuristics with the same depth as the research backend.",
	];
	return {
		answer: `Fallback mode assembled grounded source evidence for: ${params.question}`,
		recommendation: fetched[0]?.title ? `Start from ${fetched[0].title} and validate against the remaining sources before acting.` : undefined,
		summary: `Research bundle assembled from ${fetched.length} source(s). This fallback mode compiles grounded evidence for Pi to synthesize into a final answer.`,
		findings: [
			`Question: ${params.question}`,
			`Mode: ${params.mode}`,
			params.sourcePolicy ? `Source policy: ${params.sourcePolicy}` : undefined,
			params.freshness !== "any" ? `Freshness filter: ${params.freshness}` : undefined,
		].filter(Boolean) as string[],
		bestPractices: [
			fetched.some((source) => source.sourceCategory === "official-docs") ? "Use official documentation as the starting point when available." : undefined,
		].filter(Boolean) as string[],
		tradeOffs: ["Fallback mode preserves grounded evidence but does not perform the full backend ranking and synthesis workflow."],
		risks: ["Fallback mode may miss disagreement signals or exact canonical source selection that the backend would normally compute."],
		mitigations: ["If precision matters, rerun with a configured research backend for stronger ranking and synthesis."],
		agreements,
		disagreements,
		sources: fetched,
		confidence: fetched.length >= 3 ? "medium" : "low",
		gaps: [
			"Fallback mode does not perform backend-side ranking, deduplication, or synthesis beyond assembling grounded source packets.",
		],
		metadata: { strategy: "direct-research-bundle", retrievedSources: fetched.length },
	};
}

function normalizeResearchOutput(raw: any): ResearchOutput {
	return {
		answer: stringify(raw?.answer),
		recommendation: stringify(raw?.recommendation),
		summary: stringify(raw?.summary),
		findings: arrayOfStrings(raw?.findings),
		bestPractices: arrayOfStrings(raw?.bestPractices) ?? arrayOfStrings(raw?.best_practices),
		tradeOffs: arrayOfStrings(raw?.tradeOffs) ?? arrayOfStrings(raw?.trade_offs),
		risks: arrayOfStrings(raw?.risks),
		mitigations: arrayOfStrings(raw?.mitigations),
		agreements: arrayOfStrings(raw?.agreements),
		disagreements: arrayOfStrings(raw?.disagreements),
		sources: normalizeResearchSources(raw?.sources ?? raw?.citations),
		confidence: stringify(raw?.confidence),
		gaps: arrayOfStrings(raw?.gaps),
		metadata: isRecord(raw?.metadata) ? raw.metadata : undefined,
	};
}

function normalizeResearchSources(value: unknown): ResearchSource[] {
	if (!Array.isArray(value)) return [];
	return value.map((item: any) => ({
		title: stringify(item?.title),
		url: stringify(item?.url) ?? stringify(item?.link),
		snippet: stringify(item?.snippet),
		excerpt: stringify(item?.excerpt) ?? stringify(item?.content),
		sourceType: stringify(item?.sourceType) ?? stringify(item?.type),
		sourceCategory: stringify(item?.sourceCategory) ?? stringify(item?.category),
		resultType: stringify(item?.resultType),
		publishedAt: stringify(item?.publishedAt) ?? stringify(item?.date),
		confidence: stringify(item?.confidence),
		score: numberOrUndefined(item?.score),
		ranking: isRecord(item?.ranking) ? item.ranking : undefined,
	})).filter((item) => Boolean(item.url || item.excerpt || item.title));
}

function arrayOfStrings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return strings.length > 0 ? strings : undefined;
}

function modeToSourceType(mode: ResearchMode): SourceType {
	switch (mode) {
		case "news":
			return "news";
		case "technical":
		case "best-practice":
			return "docs";
		default:
			return "general";
	}
}

function mapModeToProfile(mode: ResearchMode): ExtractionProfile {
	switch (mode) {
		case "best-practice":
		case "technical":
			return "docs";
		case "news":
			return "article";
		default:
			return "generic";
	}
}

function excerptLength(depth: OutputDepth): number {
	switch (depth) {
		case "brief":
			return 500;
		case "deep":
			return 2500;
		default:
			return 1200;
	}
}

async function performAnalyzeSources(
	config: ResearchConfig,
	params: { question: string; sources: Array<{ url?: string; title?: string; content?: string }>; comparisonMode: ComparisonMode },
	signal?: AbortSignal,
): Promise<AnalyzeOutput> {
	if (config.baseUrl) {
		try {
			const raw = await postJson<any>(config, "/v1/analyze", params, signal);
			return normalizeAnalyzeOutput(raw);
		} catch {
			// Fall through to direct bundle generation.
		}
	}
	const normalizedSources = await Promise.all(
		params.sources.map(async (source) => {
			if (source.content) {
				return {
					title: source.title,
					url: source.url,
					excerpt: cleanupWhitespace(source.content).slice(0, 1800),
					sourceType: classifyUrl(source.url ?? ""),
					sourceCategory: classifySourceCategory(source.url, source.title),
				};
			}
			if (source.url) {
				try {
					const fetched = await directFetch(config, source.url, "auto", "generic", signal);
					return {
						title: source.title ?? fetched.title,
						url: fetched.canonicalUrl ?? source.url,
						excerpt: fetched.content.slice(0, 1800),
						sourceType: classifyUrl(source.url),
						sourceCategory: classifySourceCategory(fetched.canonicalUrl ?? source.url, source.title ?? fetched.title),
					};
				} catch {
					return {
						title: source.title,
						url: source.url,
						sourceType: classifyUrl(source.url),
						sourceCategory: classifySourceCategory(source.url, source.title),
					};
				}
			}
			return { title: source.title };
		}),
	);
	return {
		summary: `Source analysis bundle prepared in fallback mode for ${normalizedSources.length} source(s). Use the excerpts and citations below to complete the requested comparison.`,
		agreements: normalizedSources.length > 1 ? [`Fallback mode preserved ${normalizedSources.length} source packets for comparison.`] : undefined,
		disagreements: [
			"Fallback mode does not compute semantic agreement/disagreement beyond assembling source evidence.",
		],
		strongestEvidence: normalizedSources
			.filter((source) => source.excerpt)
			.slice(0, 5)
			.map((source) => `${source.title ?? source.url ?? "Untitled source"}: ${source.excerpt?.slice(0, 280)}`),
		gaps: [
			"Fallback mode does not compute semantic agreement/disagreement beyond assembling source evidence.",
		],
		sources: normalizedSources,
		metadata: {
			strategy: "direct-analysis-bundle",
			comparisonMode: params.comparisonMode,
			sourceCount: normalizedSources.length,
		},
	};
}

function normalizeAnalyzeOutput(raw: any): AnalyzeOutput {
	return {
		summary: stringify(raw?.summary) ?? stringify(raw?.analysis),
		agreements: arrayOfStrings(raw?.agreements),
		disagreements: arrayOfStrings(raw?.disagreements),
		strongestEvidence: arrayOfStrings(raw?.strongestEvidence) ?? arrayOfStrings(raw?.strongest_evidence),
		gaps: arrayOfStrings(raw?.gaps),
		sources: normalizeResearchSources(raw?.sources ?? raw?.citations),
		metadata: isRecord(raw?.metadata) ? raw.metadata : undefined,
	};
}

function renderSearchResults(query: string, results: SearchResult[]): string {
	if (results.length === 0) {
		return `No web results found for: ${query}`;
	}
	const lines: string[] = [`Web search results for: ${query}`, ""];
	results.forEach((result, index) => {
		lines.push(`${index + 1}. ${result.title}`);
		lines.push(`   URL: ${result.url}`);
		if (result.domain) lines.push(`   Domain: ${result.domain}`);
		if (result.sourceType) lines.push(`   Type: ${result.sourceType}`);
		if (result.sourceCategory) lines.push(`   Category: ${result.sourceCategory}`);
		if (result.resultType) lines.push(`   Result type: ${result.resultType}`);
		if (typeof result.score === "number") lines.push(`   Score: ${result.score}`);
		if (result.publishedAt) lines.push(`   Published: ${result.publishedAt}`);
		if (result.snippet) lines.push(`   Snippet: ${result.snippet}`);
		lines.push("");
	});
	return lines.join("\n").trim();
}

function renderFetchResult(result: FetchResult): string {
	const codeAware = result.metadata?.codeAware as Record<string, unknown> | undefined;
	const headings = Array.isArray(codeAware?.headings) ? codeAware.headings as string[] : [];
	const codeSnippets = Array.isArray(codeAware?.codeSnippets) ? codeAware.codeSnippets as string[] : [];
	const callouts = Array.isArray(codeAware?.callouts) ? codeAware.callouts as string[] : [];
	const lines = [
		`Fetched URL: ${result.url}`,
		result.canonicalUrl ? `Canonical URL: ${result.canonicalUrl}` : undefined,
		result.title ? `Title: ${result.title}` : undefined,
		result.contentType ? `Content-Type: ${result.contentType}` : undefined,
		result.fetchMode ? `Fetch mode: ${result.fetchMode}` : undefined,
		result.extractionProfile ? `Extraction profile: ${result.extractionProfile}` : undefined,
		headings.length ? `Headings: ${headings.join(" | ")}` : undefined,
		callouts.length ? `Important notes: ${callouts.join(" | ")}` : undefined,
		codeSnippets.length ? `Code snippets:\n${codeSnippets.map((item, index) => `${index + 1}. ${item}`).join("\n")}` : undefined,
		"",
		result.content || "",
	].filter(Boolean) as string[];
	return lines.join("\n").trim();
}

function renderResearchOutput(question: string, result: ResearchOutput): string {
	const lines: string[] = [`Research query: ${question}`, ""];
	if (result.answer) {
		lines.push("Answer:");
		lines.push(result.answer);
		lines.push("");
	}
	if (result.recommendation) {
		lines.push("Recommendation:");
		lines.push(result.recommendation);
		lines.push("");
	}
	if (result.summary) {
		lines.push("Summary:");
		lines.push(result.summary);
		lines.push("");
	}
	if (result.findings?.length) {
		lines.push("Key findings:");
		for (const finding of result.findings) lines.push(`- ${finding}`);
		lines.push("");
	}
	if (result.bestPractices?.length) {
		lines.push("Best practices:");
		for (const item of result.bestPractices) lines.push(`- ${item}`);
		lines.push("");
	}
	if (result.tradeOffs?.length) {
		lines.push("Trade-offs:");
		for (const item of result.tradeOffs) lines.push(`- ${item}`);
		lines.push("");
	}
	if (result.risks?.length) {
		lines.push("Risks:");
		for (const item of result.risks) lines.push(`- ${item}`);
		lines.push("");
	}
	if (result.mitigations?.length) {
		lines.push("Mitigations:");
		for (const item of result.mitigations) lines.push(`- ${item}`);
		lines.push("");
	}
	if (result.agreements?.length) {
		lines.push("Agreement signals:");
		for (const item of result.agreements) lines.push(`- ${item}`);
		lines.push("");
	}
	if (result.disagreements?.length) {
		lines.push("Disagreement / caveat signals:");
		for (const item of result.disagreements) lines.push(`- ${item}`);
		lines.push("");
	}
	if (result.sources?.length) {
		lines.push("Citation candidates:");
		for (const source of result.sources.slice(0, 5)) {
			lines.push(`- ${source.title ?? source.url ?? "Untitled source"}${source.url ? ` — ${source.url}` : ""}`);
		}
		lines.push("");
		lines.push("Sources:");
		result.sources.forEach((source, index) => {
			lines.push(`${index + 1}. ${source.title ?? source.url ?? "Untitled source"}`);
			if (source.url) lines.push(`   URL: ${source.url}`);
			if (source.sourceType) lines.push(`   Type: ${source.sourceType}`);
			if (source.sourceCategory) lines.push(`   Category: ${source.sourceCategory}`);
			if (source.resultType) lines.push(`   Result type: ${source.resultType}`);
			if (typeof source.score === "number") lines.push(`   Score: ${source.score}`);
			if (source.publishedAt) lines.push(`   Published: ${source.publishedAt}`);
			if (source.snippet) lines.push(`   Snippet: ${source.snippet}`);
			if (source.excerpt) lines.push(`   Excerpt: ${source.excerpt}`);
		});
		lines.push("");
	}
	if (result.confidence) {
		lines.push(`Confidence: ${result.confidence}`);
		lines.push("");
	}
	if (result.gaps?.length) {
		lines.push("Gaps / caveats:");
		for (const gap of result.gaps) lines.push(`- ${gap}`);
	}
	return lines.join("\n").trim();
}

function renderAnalyzeOutput(question: string, comparisonMode: string, result: AnalyzeOutput): string {
	const lines: string[] = [`Source analysis for: ${question}`, `Comparison mode: ${comparisonMode}`, ""];
	if (result.summary) {
		lines.push("Summary:");
		lines.push(result.summary);
		lines.push("");
	}
	if (result.agreements?.length) {
		lines.push("Agreements:");
		for (const item of result.agreements) lines.push(`- ${item}`);
		lines.push("");
	}
	if (result.disagreements?.length) {
		lines.push("Disagreements:");
		for (const item of result.disagreements) lines.push(`- ${item}`);
		lines.push("");
	}
	if (result.strongestEvidence?.length) {
		lines.push("Strongest evidence:");
		for (const item of result.strongestEvidence) lines.push(`- ${item}`);
		lines.push("");
	}
	if (result.sources?.length) {
		lines.push("Citation candidates:");
		for (const source of result.sources.slice(0, 5)) {
			lines.push(`- ${source.title ?? source.url ?? "Untitled source"}${source.url ? ` — ${source.url}` : ""}`);
		}
		lines.push("");
		lines.push("Sources:");
		result.sources.forEach((source, index) => {
			lines.push(`${index + 1}. ${source.title ?? source.url ?? "Untitled source"}`);
			if (source.url) lines.push(`   URL: ${source.url}`);
			if (source.sourceType) lines.push(`   Type: ${source.sourceType}`);
			if (source.sourceCategory) lines.push(`   Category: ${source.sourceCategory}`);
			if (source.resultType) lines.push(`   Result type: ${source.resultType}`);
			if (typeof source.score === "number") lines.push(`   Score: ${source.score}`);
			if (source.excerpt) lines.push(`   Excerpt: ${source.excerpt}`);
		});
		lines.push("");
	}
	if (result.gaps?.length) {
		lines.push("Gaps / caveats:");
		for (const gap of result.gaps) lines.push(`- ${gap}`);
	}
	return lines.join("\n").trim();
}

async function finalizeTextOutput(prefix: string, text: string): Promise<{ text: string; details?: { truncated?: boolean; fullOutputPath?: string } }> {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return { text: truncation.content };
	}
	const tempDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
	const fullOutputPath = join(tempDir, "full-output.txt");
	await withFileMutationQueue(fullOutputPath, async () => {
		await writeFile(fullOutputPath, text, "utf8");
	});
	const notice = [
		"",
		`[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`,
	].join("\n");
	return {
		text: truncation.content + notice,
		details: { truncated: true, fullOutputPath },
	};
}
