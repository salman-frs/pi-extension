import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const REPORT_DIR = resolve(PROJECT_ROOT, "qa", "reports");
const backendBase = process.env.RESEARCH_COMPARISON_BASE_URL || "http://127.0.0.1:8787";
const COMPOSE_FILE = resolve(PROJECT_ROOT, "infra", "docker-compose.research.yml");
const COMPOSE_ENV_FILE = resolve(PROJECT_ROOT, ".env");

loadRootEnvFile(COMPOSE_ENV_FILE);

async function main() {
	let stackStarted = false;
	try {
		const health = await tryGetHealth();
		if (!health?.ok && !process.env.RESEARCH_COMPARISON_BASE_URL) {
			await compose(["up", "-d", "--quiet-pull"]);
			stackStarted = true;
		}
		await ensureHealthyBackend();
		const providers = buildProviders();
	const cases = [
		{
			name: "best-practice-react-caching",
			question: "What are current best practices for React server caching?",
			mode: "best-practice",
			preferredDomains: ["react.dev", "nextjs.org", "vercel.com"],
			evaluate(result) {
				return scoreChecks([
					check("answer present", typeof result.answer === "string" && result.answer.length > 40, 3),
					check("at least one source present", Array.isArray(result.sources) && result.sources.length >= 1, 2),
					check("recommendation present", typeof result.recommendation === "string" && result.recommendation.length > 20, 2),
					check("best-practice signal present", Array.isArray(result.bestPractices) && result.bestPractices.length >= 1, 1),
					check("risk or mitigation present", (Array.isArray(result.risks) && result.risks.length >= 1) || (Array.isArray(result.mitigations) && result.mitigations.length >= 1), 2),
				]);
			},
		},
		{
			name: "exact-config-nextjs",
			question: "vercel next.js proxyClientMaxBodySize docs",
			mode: "technical",
			preferredDomains: ["nextjs.org", "vercel.com"],
			evaluate(result) {
				const top = result.sources?.[0];
				return scoreChecks([
					check("answer present", typeof result.answer === "string" && result.answer.length > 20, 2),
					check("canonical config source near top", /proxyclientmaxbodysize/i.test(top?.title || top?.url || ""), 4),
					check("source metadata includes resultType", typeof top?.resultType === "string" && top.resultType.length > 0, 2),
					check("recommendation present", typeof result.recommendation === "string" && result.recommendation.length > 10, 2),
				]);
			},
		},
	];

	const providerResults = [];
	for (const provider of providers) {
		const providerCases = [];
		for (const benchmarkCase of cases) {
			const result = provider.enabled ? await provider.run(benchmarkCase) : { skipped: true };
			const evaluation = provider.enabled ? benchmarkCase.evaluate(result) : { score: 0, maxScore: 0, checks: [] };
			providerCases.push({
				name: benchmarkCase.name,
				provider: provider.name,
				enabled: provider.enabled,
				score: evaluation.score,
				maxScore: evaluation.maxScore,
				checks: evaluation.checks,
				sample: provider.enabled ? summarizeResult(result) : undefined,
				note: provider.enabled ? undefined : provider.skipReason,
			});
		}
		providerResults.push({
			provider: provider.name,
			enabled: provider.enabled,
			skipReason: provider.skipReason,
			totalScore: providerCases.reduce((sum, item) => sum + item.score, 0),
			totalMaxScore: providerCases.reduce((sum, item) => sum + item.maxScore, 0),
			cases: providerCases,
		});
	}

	const report = {
		generatedAt: new Date().toISOString(),
		baseUrl: backendBase,
		comparisonPurpose: "Compare the default web-research stack against simpler or external baselines without changing the main product contract.",
		providers: providerResults,
	};

	await mkdir(REPORT_DIR, { recursive: true });
	await writeFile(resolve(REPORT_DIR, "research-comparison-benchmark-latest.json"), JSON.stringify(report, null, 2));
	await writeFile(resolve(REPORT_DIR, "research-comparison-benchmark-latest.md"), renderMarkdownReport(report));

	console.log(`COMPARISON BENCHMARK written to ${resolve(REPORT_DIR, "research-comparison-benchmark-latest.json")}`);
	for (const provider of providerResults) {
		console.log(`- ${provider.provider}: ${provider.enabled ? `${provider.totalScore}/${provider.totalMaxScore}` : `SKIPPED (${provider.skipReason})`}`);
	}
	} finally {
		if (stackStarted) {
			await compose(["down", "-v"]).catch(() => {});
		}
	}
}

function buildProviders() {
	return [
		{
			name: "default-web-research",
			enabled: true,
			run: async (benchmarkCase) => postJson(`${backendBase}/v1/research`, {
				question: benchmarkCase.question,
				mode: benchmarkCase.mode,
				freshness: "year",
				numberOfSources: 4,
				outputDepth: "brief",
				preferredDomains: benchmarkCase.preferredDomains || [],
			}),
		},
		{
			name: "simple-search-baseline",
			enabled: true,
			run: async (benchmarkCase) => runSimpleBaseline(benchmarkCase),
		},
		{
			name: "tavily-baseline",
			enabled: Boolean(process.env.TAVILY_API_KEY),
			skipReason: process.env.TAVILY_API_KEY ? undefined : "set TAVILY_API_KEY to enable the Tavily comparison baseline",
			run: async (benchmarkCase) => runTavilyBaseline(benchmarkCase),
		},
		{
			name: "external-compare-adapter",
			enabled: Boolean(process.env.RESEARCH_COMPARISON_EXTERNAL_URL),
			skipReason: process.env.RESEARCH_COMPARISON_EXTERNAL_URL ? undefined : "set RESEARCH_COMPARISON_EXTERNAL_URL to enable a custom external comparison adapter",
			run: async (benchmarkCase) => postJson(process.env.RESEARCH_COMPARISON_EXTERNAL_URL, {
				question: benchmarkCase.question,
				mode: benchmarkCase.mode,
			}),
		},
	];
}

async function runTavilyBaseline(benchmarkCase) {
	const response = await postJson(process.env.TAVILY_BASE_URL || "https://api.tavily.com/search", {
		api_key: process.env.TAVILY_API_KEY,
		query: benchmarkCase.question,
		search_depth: process.env.TAVILY_SEARCH_DEPTH || "advanced",
		max_results: Number(process.env.TAVILY_MAX_RESULTS || 4),
		include_raw_content: true,
	});
	const results = Array.isArray(response?.results) ? response.results : [];
	const top = results[0];
	return {
		answer: top ? `Tavily baseline selected ${top.title || top.url} as the strongest source for ${benchmarkCase.question}.` : `Tavily baseline found no strong source for ${benchmarkCase.question}.`,
		recommendation: top?.title ? `Start with ${top.title}, then validate the remaining sources.` : undefined,
		bestPractices: extractBullets([top?.raw_content, top?.content].filter(Boolean).join("\n"), /(should|recommend|best practice|prefer|validate)/i, 2),
		risks: extractBullets([top?.raw_content, top?.content].filter(Boolean).join("\n"), /(risk|warning|breaking|limitation|caveat)/i, 2),
		mitigations: extractBullets([top?.raw_content, top?.content].filter(Boolean).join("\n"), /(mitigat|test|verify|rollback|staging|monitor)/i, 2),
		sources: results.slice(0, 4).map((item) => ({
			title: item.title,
			url: item.url,
			excerpt: item.raw_content || item.content,
			sourceType: item.source_type,
		})),
	};
}

async function runSimpleBaseline(benchmarkCase) {
	const search = await postJson(`${backendBase}/v1/search`, {
		query: benchmarkCase.question,
		freshness: "year",
		maxResults: 3,
		sourceType: benchmarkCase.mode === "best-practice" ? "docs" : "general",
		preferredDomains: benchmarkCase.preferredDomains || [],
	});
	const top = search.results?.[0];
	let fetched;
	if (top?.url) {
		try {
			fetched = await postJson(`${backendBase}/v1/fetch`, {
				url: top.url,
				mode: "auto",
				extractionProfile: benchmarkCase.mode === "best-practice" ? "docs" : "generic",
			});
		} catch {}
	}
	const answer = top ? `Baseline selected ${top.title} as the top source for ${benchmarkCase.question}.` : `Baseline found no strong source for ${benchmarkCase.question}.`;
	return {
		answer,
		recommendation: top?.title ? `Start with ${top.title}, then manually validate other sources.` : undefined,
		bestPractices: fetched?.content ? extractBullets(fetched.content, /(should|recommend|best practice|prefer|validate)/i, 2) : [],
		risks: fetched?.content ? extractBullets(fetched.content, /(risk|warning|breaking|limitation|caveat)/i, 2) : [],
		mitigations: fetched?.content ? extractBullets(fetched.content, /(mitigat|test|verify|rollback|staging|monitor)/i, 2) : [],
		sources: top ? [{
			title: top.title,
			url: top.url,
			resultType: top.resultType,
			sourceCategory: top.sourceCategory,
			sourceType: top.sourceType,
			excerpt: fetched?.content?.slice(0, 400),
		}] : [],
	};
}

function extractBullets(text, pattern, limit) {
	return String(text || "")
		.split(/(?<=[.!?])\s+/)
		.map((item) => item.trim())
		.filter((item) => item && pattern.test(item))
		.slice(0, limit);
}

function summarizeResult(result) {
	return {
		answer: result.answer,
		recommendation: result.recommendation,
		sourceTitles: Array.isArray(result.sources) ? result.sources.slice(0, 3).map((item) => item.title || item.url) : [],
	};
}

function check(name, pass, maxPoints) {
	return { name, pass: Boolean(pass), points: pass ? maxPoints : 0, maxPoints };
}

function scoreChecks(checks) {
	return {
		checks,
		score: checks.reduce((sum, item) => sum + item.points, 0),
		maxScore: checks.reduce((sum, item) => sum + item.maxPoints, 0),
	};
}

async function ensureHealthyBackend() {
	const health = await waitForHealth();
	if (!health?.ok) {
		throw new Error(`Backend is not healthy at ${backendBase}. Start the stack first or set RESEARCH_COMPARISON_BASE_URL.`);
	}
}

async function waitForHealth(timeoutMs = 120000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const health = await tryGetHealth();
		if (health?.ok) return health;
		await sleep(1500);
	}
	throw new Error(`Timed out waiting for backend health at ${backendBase}`);
}

async function tryGetHealth() {
	try {
		return await getJson(`${backendBase}/health`);
	} catch {
		return undefined;
	}
}

async function compose(args) {
	await execFileAsync("docker", ["compose", "--env-file", COMPOSE_ENV_FILE, "-f", COMPOSE_FILE, ...args], { cwd: PROJECT_ROOT });
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadRootEnvFile(path) {
	if (!existsSync(path)) return;
	const raw = readFileSync(path, "utf8");
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) continue;
		const [, key, value] = match;
		if (process.env[key] != null && process.env[key] !== "") continue;
		process.env[key] = stripEnvQuotes(value);
	}
}

function stripEnvQuotes(value) {
	const trimmed = String(value || "").trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
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

function renderMarkdownReport(report) {
	const lines = [
		"# Research comparison benchmark report",
		"",
		`- Generated: ${report.generatedAt}`,
		`- Backend base URL: ${report.baseUrl}`,
		`- Purpose: ${report.comparisonPurpose}`,
		"",
		"## Providers",
		"",
	];
	for (const provider of report.providers) {
		lines.push(`### ${provider.provider}`);
		lines.push(provider.enabled ? `- Score: ${provider.totalScore}/${provider.totalMaxScore}` : `- Status: SKIPPED (${provider.skipReason})`);
		for (const item of provider.cases) {
			lines.push(`- ${item.name}: ${item.enabled ? `${item.score}/${item.maxScore}` : `SKIPPED (${item.note})`}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

main().catch((error) => {
	console.error("COMPARISON BENCHMARK FAIL:", error);
	process.exit(1);
});
