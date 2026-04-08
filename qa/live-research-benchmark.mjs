import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { annotateBenchmarkCases, renderBenchmarkMappingSection, summarizeBenchmarkFamilies } from "./lib/benchmark-reporting.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const REPORT_DIR = resolve(PROJECT_ROOT, "qa", "reports");
const COMPOSE_FILE = resolve(PROJECT_ROOT, "infra", "docker-compose.research.yml");
const COMPOSE_ENV_FILE = resolve(PROJECT_ROOT, ".env");
const backendBase = "http://127.0.0.1:8787";
const PROFILE = String(process.env.LIVE_BENCHMARK_PROFILE || "quick").trim().toLowerCase();

async function main() {
	let stackStarted = false;
	try {
		const existingHealth = await tryGetHealth();
		if (!existingHealth?.ok) {
			await compose(["up", "-d", "--quiet-pull"]);
			stackStarted = true;
		}
		await waitForHealth();

		const cases = [];
		for (const benchmarkCase of selectCasesForProfile()) {
			cases.push(await benchmarkCase());
		}
		const annotatedCases = annotateBenchmarkCases("live", cases);
		const totalScore = annotatedCases.reduce((sum, item) => sum + item.score, 0);
		const totalMaxScore = annotatedCases.reduce((sum, item) => sum + item.maxScore, 0);
		const benchmarkFamilies = summarizeBenchmarkFamilies(annotatedCases);
		const percentage = Math.round((totalScore / totalMaxScore) * 100);
		const report = {
			ok: percentage >= 70,
			totalScore,
			totalMaxScore,
			percentage,
			generatedAt: new Date().toISOString(),
			mode: "live",
			profile: PROFILE,
			benchmarkFamilies,
			cases: annotatedCases,
		};

		await mkdir(REPORT_DIR, { recursive: true });
		await writeFile(resolve(REPORT_DIR, "live-research-benchmark-latest.json"), JSON.stringify(report, null, 2));
		await writeFile(resolve(REPORT_DIR, "live-research-benchmark-latest.md"), renderMarkdownReport(report));

		console.log(`LIVE BENCHMARK: ${totalScore}/${totalMaxScore} (${percentage}%) [profile=${PROFILE}]`);
		for (const item of cases) {
			console.log(`- ${item.name}: ${item.score}/${item.maxScore}`);
		}
		console.log(`Report: ${resolve(REPORT_DIR, "live-research-benchmark-latest.json")}`);

		if (!report.ok) {
			throw new Error(`Live benchmark below threshold: ${percentage}%`);
		}
	} finally {
		if (stackStarted) {
			await compose(["down", "-v"]).catch(() => {});
		}
	}
}

function selectCasesForProfile() {
	const quick = [
		caseSearchDocs,
		caseSearchExactConfig,
		caseGitHubOfficialEntityResolution,
		caseFetchDocsMarkdownPreferred,
		caseResearchCanonicalUpgrade,
		caseCacheEffectiveness,
	];
	if (PROFILE === "full") {
		return [
			caseSearchDocs,
			caseSearchExactConfig,
			caseGitHubSearch,
			caseGitHubOfficialEntityResolution,
			caseFetchDocs,
			caseFetchDocsMarkdownPreferred,
			caseResearchBestPractice,
			caseResearchCanonicalUpgrade,
			caseResearchArchitecture,
			caseResearchDiscovery,
			caseCacheEffectiveness,
		];
	}
	return quick;
}

async function caseSearchDocs() {
	const payload = {
		query: "react server caching best practices",
		freshness: "month",
		maxResults: 5,
		sourceType: "docs",
		preferredDomains: ["react.dev", "nextjs.org", "vercel.com"],
	};
	const result = await postJsonWithRetries("/v1/search", payload);
	const preferredMatches = (result.results || []).filter((item) => ["react.dev", "nextjs.org", "vercel.com"].includes(item.domain)).length;
	return makeCase("live-search-docs", 20, [
		check("returns at least 3 results", (result.results || []).length >= 3, 5, `count=${result.results?.length || 0}`),
		check("top result is official docs or release notes", ["official-docs", "release-notes"].includes(result.results?.[0]?.sourceCategory), 5, result.results?.[0]?.sourceCategory),
		check("at least 2 preferred-domain results are present", preferredMatches >= 2, 5, `preferredMatches=${preferredMatches}`),
		check("ranking reasons are visible", Array.isArray(result.results?.[0]?.ranking?.reasons) && result.results[0].ranking.reasons.length > 0, 5, JSON.stringify(result.results?.[0]?.ranking || {})),
	], {
		sample: result.results?.slice(0, 3),
	});
}

async function caseSearchExactConfig() {
	const result = await postJsonWithRetries("/v1/search", {
		query: "vercel next.js proxyClientMaxBodySize docs",
		freshness: "year",
		maxResults: 5,
		sourceType: "docs",
		preferredDomains: ["nextjs.org"],
	});
	return makeCase("live-search-exact-config", 15, [
		check("top 2 include exact config page", (result.results || []).slice(0, 2).some((item) => /proxyclientmaxbodysize/i.test(item.url || item.title || "")), 5, JSON.stringify((result.results || []).slice(0, 3).map((item) => ({ title: item.title, url: item.url })))),
		check("top result is nextjs official docs", /nextjs\.org$/.test(result.results?.[0]?.domain || "") && result.results?.[0]?.sourceCategory === "official-docs", 5, JSON.stringify(result.results?.[0] || {})),
		check("a configuration/api reference is in top 2", (result.results || []).slice(0, 2).some((item) => ["configuration-reference", "api-reference"].includes(item.resultType)), 5, JSON.stringify((result.results || []).slice(0, 2).map((item) => item.resultType))),
	], {
		sample: result.results?.slice(0, 3),
	});
}

async function caseGitHubSearch() {
	const result = await postJsonWithRetries("/v1/search", {
		query: "next.js server actions formData github issue",
		freshness: "year",
		maxResults: 5,
		sourceType: "github",
	});
	const githubCount = (result.results || []).filter((item) => item.sourceType === "github").length;
	return makeCase("live-search-github", 15, [
		check("returns github results", githubCount >= 3, 5, `githubCount=${githubCount}`),
		check("includes issue or discussion result types", (result.results || []).some((item) => ["github-issue", "github-discussion", "github-releases", "repository-home"].includes(item.resultType)), 5, JSON.stringify((result.results || []).map((item) => item.resultType))),
		check("includes vercel/next.js or similarly relevant repo evidence", (result.results || []).some((item) => /next\.js|vercel/i.test(item.title || "")), 5, JSON.stringify((result.results || []).map((item) => item.title))),
	], {
		sample: result.results?.slice(0, 3),
	});
}

async function caseGitHubOfficialEntityResolution() {
	const releaseResult = await postJsonWithRetries("/v1/search", {
		query: "vercel next.js releases github",
		freshness: "year",
		maxResults: 5,
		sourceType: "github",
	});
	const repoResult = await postJsonWithRetries("/v1/search", {
		query: "facebook react compiler github repo official",
		freshness: "year",
		maxResults: 5,
		sourceType: "github",
	});
	return makeCase("live-search-github-official-entity", 15, [
		check("release query returns official vercel/next.js releases in top 2", (releaseResult.results || []).slice(0, 2).some((item) => item.url === "https://github.com/vercel/next.js/releases"), 5, JSON.stringify((releaseResult.results || []).slice(0, 3).map((item) => item.url))),
		check("release query top result is a github release page", (releaseResult.results || [])[0]?.resultType === "github-releases", 5, JSON.stringify((releaseResult.results || [])[0] || {})),
		check("repo query returns facebook/react in top 2", (repoResult.results || []).slice(0, 2).some((item) => item.url === "https://github.com/facebook/react"), 5, JSON.stringify((repoResult.results || []).slice(0, 3).map((item) => item.url))),
	], {
		sample: {
			releaseTop: (releaseResult.results || []).slice(0, 3).map((item) => ({ title: item.title, url: item.url, resultType: item.resultType })),
			repoTop: (repoResult.results || []).slice(0, 3).map((item) => ({ title: item.title, url: item.url, resultType: item.resultType })),
		},
	});
}

async function caseFetchDocs() {
	const result = await postJsonWithRetries("/v1/fetch", {
		url: "https://nextjs.org/docs/app/guides/caching-without-cache-components",
		mode: "auto",
		extractionProfile: "docs",
	});
	return makeCase("live-fetch-docs", 15, [
		check("title is extracted", typeof result.title === "string" && result.title.length > 5, 5, result.title),
		check("content is substantial", typeof result.content === "string" && result.content.length > 1200, 5, `contentLength=${result.content?.length || 0}`),
		check("metadata includes strategy and request id", typeof result.metadata?.strategy === "string" && typeof result.metadata?.requestId === "string", 5, JSON.stringify(result.metadata || {})),
	], {
		sample: { title: result.title, fetchMode: result.fetchMode, strategy: result.metadata?.strategy },
	});
}

async function caseFetchDocsMarkdownPreferred() {
	const result = await postJsonWithRetries("/v1/fetch", {
		url: "https://developers.cloudflare.com/agents/",
		mode: "auto",
		extractionProfile: "docs",
	});
	return makeCase("live-fetch-docs-markdown-preferred", 15, [
		check("uses markdown-aware fetch strategy", result.metadata?.strategy === "docs-markdown-fetch", 5, JSON.stringify(result.metadata || {})),
		check("content contains docs-specific text", /Build Agents on Cloudflare|createMcpHandler|stateless MCP server/i.test(result.content || ""), 5, result.content?.slice(0, 400)),
		check("content is not raw html", !/^<!doctype html>/i.test(result.content || ""), 5, result.content?.slice(0, 120)),
	], {
		sample: { title: result.title, strategy: result.metadata?.strategy, contentType: result.contentType },
	});
}

async function caseResearchBestPractice() {
	const result = await postJsonWithRetries("/v1/research", {
		question: "What are current best practices for React server caching?",
		mode: "best-practice",
		freshness: "month",
		numberOfSources: 4,
		outputDepth: "brief",
		preferredDomains: ["react.dev", "nextjs.org", "vercel.com"],
	});
	return makeCase("live-research-best-practice", 25, [
		check("answer is present", typeof result.answer === "string" && result.answer.length > 40, 5, result.answer),
		check("sources >= 3", (result.sources || []).length >= 3, 5, `count=${result.sources?.length || 0}`),
		check("official docs are included", (result.sources || []).some((item) => item.sourceCategory === "official-docs"), 5, (result.sources || []).map((item) => item.sourceCategory).join(", ")),
		check("agreement and disagreement signals exist", Array.isArray(result.agreements) && result.agreements.length > 0 && Array.isArray(result.disagreements) && result.disagreements.length > 0, 5, JSON.stringify({ agreements: result.agreements, disagreements: result.disagreements })),
		check("confidence is medium or high", ["medium", "high"].includes(result.confidence), 5, result.confidence),
	], {
		sample: { answer: result.answer, categories: (result.sources || []).map((item) => item.sourceCategory) },
	});
}

async function caseResearchCanonicalUpgrade() {
	const result = await postJsonWithRetries("/v1/research", {
		question: "React 19 official upgrade considerations",
		mode: "technical",
		freshness: "year",
		numberOfSources: 4,
		outputDepth: "brief",
		preferredDomains: ["react.dev"],
	});
	return makeCase("live-research-canonical-upgrade", 15, [
		check("top source looks like upgrade guide or release notes", /upgrade|release/i.test(result.sources?.[0]?.title || "") || ["migration-guide", "release-notes"].includes(result.sources?.[0]?.resultType), 5, JSON.stringify(result.sources?.[0] || {})),
		check("top source is react.dev official docs", result.sources?.[0]?.domain === "react.dev" && result.sources?.[0]?.sourceCategory === "official-docs", 5, JSON.stringify(result.sources?.[0] || {})),
		check("answer mentions upgrade or migration", /upgrade|migration|breaking/i.test(result.answer || ""), 5, result.answer),
	], {
		sample: { titles: (result.sources || []).map((item) => item.title), resultTypes: (result.sources || []).map((item) => item.resultType) },
	});
}

async function caseResearchArchitecture() {
	const result = await postJsonWithRetries("/v1/research", {
		question: "SQS vs EventBridge architecture trade-offs AWS official guidance",
		mode: "technical",
		freshness: "year",
		numberOfSources: 5,
		outputDepth: "brief",
		preferredDomains: ["docs.aws.amazon.com", "aws.amazon.com"],
	});
	const awsCount = (result.sources || []).filter((item) => /aws\.amazon\.com|docs\.aws\.amazon\.com/.test(item.domain || "")).length;
	return makeCase("live-research-architecture", 15, [
		check("returns at least 3 sources", (result.sources || []).length >= 3, 5, `count=${result.sources?.length || 0}`),
		check("AWS official sources dominate", awsCount >= 3, 5, `awsCount=${awsCount}`),
		check("answer mentions trade-offs or architecture", /trade-?off|architecture|event|queue|bus/i.test(result.answer || ""), 5, result.answer),
	], {
		sample: { categories: (result.sources || []).map((item) => item.sourceCategory), titles: (result.sources || []).map((item) => item.title) },
	});
}

async function caseResearchDiscovery() {
	const result = await postJsonWithRetries("/v1/research", {
		question: "Find a newer niche edge runtime for stateless MCP servers",
		mode: "technical",
		freshness: "year",
		numberOfSources: 3,
		outputDepth: "brief",
		preferredDomains: ["developers.cloudflare.com", "github.com"],
	});
	const officialDocsCount = (result.sources || []).filter((item) => item.sourceCategory === "official-docs").length;
	const repoOrReleaseCount = (result.sources || []).filter((item) => ["repository-home", "github-releases", "release-notes"].includes(item.resultType)).length;
	return makeCase("live-research-discovery", 25, [
		check("returns at least 2 sources", (result.sources || []).length >= 2, 5, `count=${result.sources?.length || 0}`),
		check("includes at least one official docs source", officialDocsCount >= 1, 5, `officialDocsCount=${officialDocsCount}`),
		check("includes repo or release evidence", repoOrReleaseCount >= 1, 5, `repoOrReleaseCount=${repoOrReleaseCount}`),
		check("answer mentions agents, MCP, runtime, or stateless server", /agent|mcp|runtime|stateless|server/i.test(result.answer || ""), 5, result.answer),
		check("agreement or gap signals are present", (Array.isArray(result.agreements) && result.agreements.length > 0) || (Array.isArray(result.gaps) && result.gaps.length > 0), 5, JSON.stringify({ agreements: result.agreements, gaps: result.gaps })),
	], {
		sample: { categories: (result.sources || []).map((item) => item.sourceCategory), types: (result.sources || []).map((item) => item.resultType), domains: (result.sources || []).map((item) => item.domain) },
	});
}

async function caseCacheEffectiveness() {
	await postJsonWithRetries("/v1/search", {
		query: "react server caching best practices",
		freshness: "month",
		maxResults: 3,
		sourceType: "docs",
		preferredDomains: ["react.dev", "nextjs.org", "vercel.com"],
	});
	const cached = await postJsonWithRetries("/v1/research", {
		question: "What are current best practices for React server caching?",
		mode: "best-practice",
		freshness: "month",
		numberOfSources: 4,
		outputDepth: "brief",
		preferredDomains: ["react.dev", "nextjs.org", "vercel.com"],
	});
	const cachedAgain = await postJsonWithRetries("/v1/research", {
		question: "What are current best practices for React server caching?",
		mode: "best-practice",
		freshness: "month",
		numberOfSources: 4,
		outputDepth: "brief",
		preferredDomains: ["react.dev", "nextjs.org", "vercel.com"],
	});
	const health = await getJson(`${backendBase}/health`);
	return makeCase("live-cache-effectiveness", 15, [
		check("second research call hits cache", cachedAgain.metadata?.cache?.hit === true, 10, JSON.stringify(cachedAgain.metadata?.cache || {})),
		check("health shows cache hits", Number(health.cache?.research?.hits || 0) >= 1, 5, JSON.stringify(health.cache || {})),
	], {
		sample: { first: cached.metadata?.cache, second: cachedAgain.metadata?.cache, healthCache: health.cache },
	});
}

function check(name, pass, maxPoints, detail) {
	return { name, pass: Boolean(pass), points: pass ? maxPoints : 0, maxPoints, detail };
}

function makeCase(name, maxScore, checks, extra = {}) {
	const score = checks.reduce((sum, item) => sum + item.points, 0);
	return { name, maxScore, score, checks, ...extra };
}

async function waitForHealth(timeoutMs = 120000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const health = await tryGetHealth();
		if (health?.ok) return health;
		await sleep(1500);
	}
	throw new Error("Timed out waiting for live backend health");
}

async function tryGetHealth() {
	try {
		return await getJson(`${backendBase}/health`);
	} catch {
		return undefined;
	}
}

async function postJsonWithRetries(path, body, attempts = 3) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await postJson(`${backendBase}${path}`, body);
		} catch (error) {
			lastError = error;
			await sleep(750 * attempt);
		}
	}
	throw lastError;
}

async function postJson(url, body) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`Expected JSON from ${url}, got: ${text}`);
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(parsed)}`);
	return parsed;
}

async function getJson(url) {
	const res = await fetch(url);
	const text = await res.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`Expected JSON from ${url}, got: ${text}`);
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(parsed)}`);
	return parsed;
}

async function compose(args) {
	await execFileAsync("docker", ["compose", "--env-file", COMPOSE_ENV_FILE, "-f", COMPOSE_FILE, ...args], { cwd: PROJECT_ROOT, maxBuffer: 1024 * 1024 * 10 });
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderMarkdownReport(report) {
	const lines = [
		"# Live research benchmark report",
		"",
		`- Generated: ${report.generatedAt}`,
		`- Profile: ${report.profile}`,
		`- Score: ${report.totalScore}/${report.totalMaxScore} (${report.percentage}%)`,
		`- Pass threshold: 70%`,
		`- Status: ${report.ok ? "PASS" : "FAIL"}`,
		"",
		"## Cases",
		"",
	];
	lines.push(renderBenchmarkMappingSection(report));
	for (const item of report.cases) {
		lines.push(`### ${item.name}`);
		lines.push(`- Score: ${item.score}/${item.maxScore}`);
		if (item.benchmarkStyle) {
			lines.push(`- Benchmark family: ${item.benchmarkStyle.family}`);
			lines.push(`- Public styles: ${item.benchmarkStyle.publicStyles.join(", ")}`);
		}
		for (const rule of item.checks) {
			lines.push(`- [${rule.pass ? "x" : " "}] ${rule.name} (${rule.points}/${rule.maxPoints})`);
			if (rule.detail) lines.push(`  - Detail: ${rule.detail}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

main().catch((error) => {
	console.error("LIVE BENCHMARK FAIL:", error);
	process.exit(1);
});
