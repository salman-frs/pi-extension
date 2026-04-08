import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { annotateBenchmarkCases, renderBenchmarkMappingSection, summarizeBenchmarkFamilies } from "./lib/benchmark-reporting.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const REPORT_DIR = resolve(PROJECT_ROOT, "qa", "reports");

const ports = {
	content: 8876,
	search: 8877,
	backend: 8878,
};

const contentBase = `http://127.0.0.1:${ports.content}`;
const searchBase = `http://127.0.0.1:${ports.search}`;
const backendBase = `http://127.0.0.1:${ports.backend}`;
const docsFetchRulesPath = resolve(PROJECT_ROOT, "qa", "tmp", "deterministic-docs-fetch-rules.json");

const pageFixtures = {
	"/react-cache-official": {
		title: "Official React caching guidance",
		canonicalUrl: "https://react.dev/reference/react/cache",
		body: `
		<article>
		<h1>Official React caching guidance</h1>
		<p>React cache supports per-request deduplication for server work and should be paired with explicit invalidation boundaries.</p>
		<p>Official guidance emphasizes freshness control, observability, and avoiding stale data leaks.</p>
		</article>
		`,
	},
	"/nextjs-cache-guide": {
		title: "Next.js caching guide",
		canonicalUrl: "https://nextjs.org/docs/app/guides/caching-without-cache-components",
		body: `
		<article>
		<h1>Next.js caching guide</h1>
		<p>Next.js guidance explains cache, revalidation, and data fetching tradeoffs for server rendering.</p>
		<p>Teams should document cache scope and revalidation behavior to preserve correctness.</p>
		</article>
		`,
	},
	"/nextjs-proxy-body-size-config": {
		title: "proxyClientMaxBodySize | next.config.js Options | Next.js",
		canonicalUrl: "https://nextjs.org/docs/app/api-reference/config/next-config-js/proxyClientMaxBodySize",
		body: `
		<article>
		<h1>proxyClientMaxBodySize</h1>
		<p>Use the proxyClientMaxBodySize option in next.config.js to raise or lower the maximum proxied request body size.</p>
		<p>This configuration reference explains defaults, exact option naming, and when it affects uploads routed through the Next.js proxy layer.</p>
		</article>
		`,
	},
	"/nextjs-telemetry-doc": {
		title: "Telemetry | Next.js",
		canonicalUrl: "https://nextjs.org/docs/app/building-your-application/optimizing/telemetry",
		body: `
		<article>
		<h1>Telemetry</h1>
		<p>Telemetry explains anonymous usage collection and opting out.</p>
		</article>
		`,
	},
	"/nextjs-codemods-doc": {
		title: "Codemods | Next.js",
		canonicalUrl: "https://nextjs.org/docs/app/guides/upgrading/codemods",
		body: `
		<article>
		<h1>Codemods</h1>
		<p>Codemods help automate source changes during upgrades.</p>
		</article>
		`,
	},
	"/react-19-upgrade-guide": {
		title: "Upgrade Guide (Version 19) | React",
		canonicalUrl: "https://react.dev/blog/2024/04/25/react-19-upgrade-guide",
		body: `
		<article>
		<h1>Upgrade Guide (Version 19)</h1>
		<p>The React 19 upgrade guide covers breaking changes, migration sequencing, and recommended validation before rollout.</p>
		<p>It highlights deprecated patterns, testing expectations, and the safest upgrade path for production apps.</p>
		</article>
		`,
	},
	"/react-19-blog": {
		title: "React 19 | React",
		canonicalUrl: "https://react.dev/blog/2024/12/05/react-19",
		body: `
		<article>
		<h1>React 19</h1>
		<p>The React 19 launch post introduces the release and links to deeper migration resources.</p>
		</article>
		`,
	},
	"/react-compiler-overview": {
		title: "React Compiler | React",
		canonicalUrl: "https://react.dev/learn/react-compiler",
		body: `
		<article>
		<h1>React Compiler</h1>
		<p>The compiler documentation explains optimization behavior, not the core React 19 upgrade path.</p>
		</article>
		`,
	},
	"/cachex-v2-release": {
		title: "CacheX v2 release notes",
		canonicalUrl: "https://cachex.dev/releases/v2",
		body: `
		<article>
		<h1>CacheX v2 release notes</h1>
		<p>CacheX v2 introduces breaking changes to invalidation hooks and removes the legacy sync adapter.</p>
		<p>The release notes recommend reviewing migration steps before upgrade and validating cache compatibility.</p>
		</article>
		`,
	},
	"/cachex-v2-migration": {
		title: "CacheX v2 migration guide",
		canonicalUrl: "https://docs.cachex.dev/migrate/v2",
		body: `
		<article>
		<h1>CacheX v2 migration guide</h1>
		<p>The migration guide recommends replacing sync adapters, updating invalidation hooks, and testing stale-read behavior.</p>
		<p>Teams should verify compatibility in staging before moving production workloads to v2.</p>
		</article>
		`,
	},
	"/cachex-github-issue": {
		title: "CacheX issue: migration pain points",
		canonicalUrl: "https://github.com/cachex/cachex/issues/42",
		body: `
		<article>
		<h1>CacheX issue: migration pain points</h1>
		<p>Users reported migration pain around renamed invalidation hooks and adapter compatibility.</p>
		<p>Maintainers clarified workarounds and noted that several edge cases required manual testing.</p>
		</article>
		`,
	},
	"/cachex-vendor-blog": {
		title: "CacheX engineering blog on v2 rollout",
		canonicalUrl: "https://blog.cachex.dev/cachex-v2-rollout",
		body: `
		<article>
		<h1>CacheX engineering blog on v2 rollout</h1>
		<p>The vendor blog frames v2 as a reliability improvement but acknowledges migration complexity and rollout tradeoffs.</p>
		<p>It recommends phased deployment, observability, and rollback readiness.</p>
		</article>
		`,
	},
	"/community-react-caching": {
		title: "Community React caching discussion",
		canonicalUrl: "https://community.example.dev/react-caching-discussion",
		body: `
		<article>
		<h1>Community React caching discussion</h1>
		<p>Community guidance stresses correctness-first invalidation, pragmatic TTLs, and documenting tradeoffs.</p>
		<p>Practitioners note that official docs may under-emphasize messy migration edge cases.</p>
		</article>
		`,
	},
	"/cf-agents/": {
		title: "Build Agents on Example Cloud",
		canonicalUrl: `${contentBase}/cf-agents/`,
		body: `
		<article>
		<h1>Build Agents on Example Cloud</h1>
		<p>HTML shell content that should be bypassed when markdown docs are available.</p>
		</article>
		`,
	},
	"/cf-agents/llms-full.txt": {
		title: "Build Agents on Example Cloud",
		canonicalUrl: `${contentBase}/cf-agents/`,
		contentType: "text/markdown; charset=utf-8",
		rawBody: `---\ntitle: Build Agents on Example Cloud\ndescription: Stateful agents and MCP servers on the edge.\n---\n# Build Agents on Example Cloud\n\nUse createMcpHandler() to expose a stateless MCP server.\n\n## Getting started\n\nInstall the agents package and deploy to the edge.\n`,
	},
	"/cf-agents/release-notes": {
		title: "Example Cloud Agents release notes",
		canonicalUrl: `${contentBase}/cf-agents/release-notes`,
		body: `
		<article>
		<h1>Example Cloud Agents release notes</h1>
		<p>The release notes document recent MCP support, createMcpHandler() updates, and stateless server guidance.</p>
		</article>
		`,
	},
	"/cf-agents/announcement": {
		title: "Introducing Example Cloud Agents",
		canonicalUrl: `${contentBase}/cf-agents/announcement`,
		body: `
		<article>
		<h1>Introducing Example Cloud Agents</h1>
		<p>Launch announcement for a newer niche edge runtime focused on stateful agents and stateless MCP tooling.</p>
		</article>
		`,
	},
	"/cf-agents/repo": {
		title: "examplecloud/agents",
		canonicalUrl: `${contentBase}/cf-agents/repo`,
		body: `
		<article>
		<h1>examplecloud/agents</h1>
		<p>Official repository for Example Cloud Agents with SDK code and examples.</p>
		</article>
		`,
	},
	"/mintlify/guide": {
		title: "Acme Runtime Guide",
		canonicalUrl: `${contentBase}/mintlify/guide`,
		body: `
		<div id="__mintlify-root">
			<nav>Docs nav</nav>
			<main>
				<h1>Acme Runtime Guide</h1>
				<p>Loading shell that should be replaced by markdown-aware docs candidates when available.</p>
			</main>
		</div>
		`,
	},
	"/mintlify/guide/llms-full.txt": {
		title: "Acme Runtime Guide",
		canonicalUrl: `${contentBase}/mintlify/guide`,
		contentType: "text/markdown; charset=utf-8",
		rawBody: `# Acme Runtime Guide\n\nAcme Runtime supports stateless MCP handlers and durable agents.\n\n## Quickstart\n\nUse createMcpHandler() and deploy with the edge runtime CLI.\n`,
	},
	"/vitepress/reference": {
		title: "Acme API Reference",
		canonicalUrl: `${contentBase}/vitepress/reference`,
		body: `
		<div class="vitepress app-shell">
			<header>Navigation</header>
			<main class="vp-doc">
				<article>
					<h1>Acme API Reference</h1>
					<p>The Acme runtime exposes a stateless handler API and queue-backed background tasks.</p>
					<div class="admonition warning"><p>Note: validate timeout budgets before production rollout.</p></div>
					<pre><code class="language-ts">export default createMcpHandler({ runtime: \"edge\" })</code></pre>
				</article>
			</main>
		</div>
		`,
	},
	"/partial-official-doc": {
		title: "Partial official docs",
		canonicalUrl: `${contentBase}/partial-official-doc`,
		body: `
		<article>
		<h1>Partial official docs</h1>
		<p>Official docs still explain the key runtime constraints and configuration model.</p>
		<p>Use rendered mode when the page shell hides most technical content.</p>
		</article>
		`,
	},
};

function createContentServer() {
	return http.createServer((req, res) => {
		const fixture = pageFixtures[req.url || ""];
		if (!fixture) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		if (fixture.rawBody) {
			res.writeHead(200, { "content-type": fixture.contentType || "text/plain; charset=utf-8" });
			res.end(fixture.rawBody);
			return;
		}
		res.writeHead(200, { "content-type": fixture.contentType || "text/html; charset=utf-8" });
		res.end(`<!doctype html><html><head><title>${fixture.title}</title><link rel="canonical" href="${fixture.canonicalUrl}" /></head><body>${fixture.body}</body></html>`);
	});
}

function createFakeSearchServer() {
	return http.createServer((req, res) => {
		const url = new URL(req.url || "/", searchBase);
		if (url.pathname !== "/search") {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}
		const q = (url.searchParams.get("q") || "").toLowerCase();
		let results = [];
		if (q.includes("proxyclientmaxbodysize") || q.includes("bodysizelimit")) {
			results = [
				searchItem("Telemetry | Next.js", "/nextjs-telemetry-doc", "Telemetry docs, unrelated to exact upload body size configuration.", "2026-04-05T08:00:00Z", "docs", "official-docs"),
				searchItem("Codemods | Next.js", "/nextjs-codemods-doc", "Codemod docs, unrelated to proxy body size configuration.", "2026-04-05T07:00:00Z", "docs", "official-docs"),
				searchItem("proxyClientMaxBodySize | next.config.js Options | Next.js", "/nextjs-proxy-body-size-config", "Exact config reference for proxied body size limits in Next.js.", "2026-04-06T11:00:00Z", "docs", "official-docs"),
			];
		} else if (q.includes("react 19") && (q.includes("upgrade") || q.includes("considerations") || q.includes("migration"))) {
			results = [
				searchItem("React 19 | React", "/react-19-blog", "Launch blog for React 19 with overview and links.", "2026-04-05T10:00:00Z", "docs", "official-docs"),
				searchItem("React Compiler | React", "/react-compiler-overview", "Compiler overview, not the canonical upgrade guide.", "2026-04-04T09:00:00Z", "docs", "official-docs"),
				searchItem("Upgrade Guide (Version 19) | React", "/react-19-upgrade-guide", "Canonical upgrade guide with migration and breaking changes.", "2026-04-06T12:00:00Z", "docs", "official-docs"),
			];
		} else if (q.includes("uncommon") || q.includes("niche") || (q.includes("mcp") && q.includes("agent"))) {
			results = [
				searchItem("MDN Web Docs: Fetch API", "/nextjs-telemetry-doc", "Generic fetch API docs, useful but not a novel platform candidate.", "2025-01-01T08:00:00Z", "docs", "official-docs"),
				{ title: "Build Agents on Example Cloud", url: `${contentBase}/cf-agents/`, content: "Stateful agents and stateless MCP servers on the edge.", publishedDate: "2026-04-06T10:00:00Z", sourceType: "docs", sourceCategory: "official-docs", resultType: "getting-started", engine: "fixture" },
				{ title: "Introducing Example Cloud Agents", url: `${contentBase}/cf-agents/announcement`, content: "Launch announcement for a new agent runtime and MCP support.", publishedDate: "2026-04-07T10:00:00Z", sourceType: "general", sourceCategory: "vendor-blog", resultType: "announcement", engine: "fixture" },
				{ title: "examplecloud/agents", url: `${contentBase}/cf-agents/repo`, content: "Official repository for Example Cloud Agents.", publishedDate: "2026-04-07T11:00:00Z", sourceType: "github", sourceCategory: "github-repo", resultType: "repository-home", engine: "fixture" },
				{ title: "examplecloud/agents releases", url: `${contentBase}/cf-agents/release-notes`, content: "Release notes for Example Cloud Agents.", publishedDate: "2026-04-07T12:00:00Z", sourceType: "github", sourceCategory: "release-notes", resultType: "github-releases", engine: "fixture" },
			];
		} else if (q.includes("partial") && q.includes("fallback")) {
			results = [
				searchItem("Partial official docs", "/partial-official-doc", "Official docs for the partial-result test case.", "2026-04-06T10:30:00Z", "docs", "official-docs"),
				{ title: "Broken source for partial fallback", url: `${contentBase}/missing-partial-doc`, content: "Broken source that should trigger a fetch failure.", publishedDate: "2026-04-06T09:30:00Z", sourceType: "docs", sourceCategory: "official-docs", resultType: "guide", engine: "fixture" },
			];
		} else if (q.includes("react") && q.includes("cach")) {
			results = [
				searchItem("Official React caching guidance", "/react-cache-official", "Official guidance on deduplication, invalidation, and freshness boundaries.", "2026-04-06T10:00:00Z", "docs", "official-docs"),
				searchItem("Next.js caching guide", "/nextjs-cache-guide", "Framework guidance on caching and revalidation tradeoffs.", "2026-04-05T09:00:00Z", "docs", "official-docs"),
				searchItem("CacheX engineering blog on v2 rollout", "/cachex-vendor-blog", "Vendor discussion of rollout, observability, and tradeoffs.", "2026-04-04T09:30:00Z", "general", "vendor-blog"),
				searchItem("Community React caching discussion", "/community-react-caching", "Community advice on TTLs, correctness, and invalidation edge cases.", "2026-04-03T07:30:00Z", "general", "forum-community"),
			];
		} else if ((q.includes("astral-sh") || q.includes("uv")) && q.includes("repo")) {
			results = [
				searchItem("astral-sh/uv issue: resolver edge case", "/cachex-github-issue", "Issue discussing a resolver edge case, not the canonical repo page.", "2026-04-03T10:00:00Z", "github", "github-issue"),
				{
					title: "astral-sh/uv",
					url: "https://github.com/astral-sh/uv",
					content: "An extremely fast Python package and project manager.",
					publishedDate: "2026-04-06T15:00:00Z",
					sourceType: "github",
					sourceCategory: "github-repo",
					resultType: "repository-home",
					engine: "fixture",
				},
				{
					title: "astral-sh/uv releases",
					url: "https://github.com/astral-sh/uv/releases",
					content: "Release history for uv.",
					publishedDate: "2026-04-06T16:00:00Z",
					sourceType: "github",
					sourceCategory: "release-notes",
					resultType: "github-releases",
					engine: "fixture",
				},
			];
		} else if (q.includes("cachex") || q.includes("upgrade") || q.includes("migration")) {
			results = [
				searchItem("CacheX v2 migration guide", "/cachex-v2-migration", "Official migration guidance for invalidation hooks and adapter changes.", "2026-04-06T12:00:00Z", "docs", "official-docs"),
				searchItem("CacheX v2 release notes", "/cachex-v2-release", "Release notes covering breaking changes and removed sync adapter.", "2026-04-06T11:00:00Z", "docs", "release-notes"),
				searchItem("CacheX issue: migration pain points", "/cachex-github-issue", "Community issue discussing edge cases and compatibility concerns.", "2026-04-05T13:00:00Z", "github", "github-issue"),
				searchItem("CacheX engineering blog on v2 rollout", "/cachex-vendor-blog", "Vendor perspective on staged rollout and rollback readiness.", "2026-04-04T09:30:00Z", "general", "vendor-blog"),
			];
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ results }));
	});
}

function searchItem(title, path, content, publishedDate, sourceType, sourceCategory) {
	return {
		title,
		url: `${contentBase}${path}`,
		content,
		publishedDate,
		sourceType,
		sourceCategory,
		engine: "fixture",
	};
}

function waitForServer(server, port) {
	return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function startBackend() {
	return spawn("node", [resolve(PROJECT_ROOT, "apps/research-backend/src/server.js")], {
		cwd: PROJECT_ROOT,
		env: {
			...process.env,
			PORT: String(ports.backend),
			HOST: "127.0.0.1",
			SEARXNG_URL: searchBase,
			PLAYWRIGHT_ENABLED: "false",
			ALLOW_PRIVATE_FETCH_HOSTS: "127.0.0.1,localhost",
			CACHE_ENABLED: "true",
			TELEMETRY_ENABLED: "false",
			DOCS_FETCH_RULES_PATH: docsFetchRulesPath,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function waitForHealth(url, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${url}/health`);
			if (res.ok) return await res.json();
		} catch {}
		await sleep(200);
	}
	throw new Error(`Timed out waiting for ${url}/health`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function makeCase(name, maxScore, checks, extra = {}) {
	const score = checks.filter((check) => check.pass).reduce((sum, check) => sum + check.points, 0);
	return { name, maxScore, score, checks, ...extra };
}

function check(name, pass, points, detail) {
	return { name, pass: Boolean(pass), points: pass ? points : 0, maxPoints: points, detail };
}

function hasCategory(sources, category) {
	return (sources || []).some((source) => source.sourceCategory === category);
}

function hasAnyCategory(sources, categories) {
	return (sources || []).some((source) => categories.includes(source.sourceCategory));
}

async function runBenchmarks() {
	const results = [];

	const search = await postJson(`${backendBase}/v1/search`, {
		query: "react server caching best practices",
		freshness: "month",
		maxResults: 4,
		sourceType: "docs",
	});
	results.push(makeCase("search-docs-ranking", 20, [
		check("returns at least 4 results", (search.results || []).length >= 4, 5, `count=${search.results?.length || 0}`),
		check("top result is official docs", search.results?.[0]?.sourceCategory === "official-docs", 5, search.results?.[0]?.sourceCategory),
		check("release notes candidate is present", hasCategory(search.results, "release-notes") || hasCategory(search.results, "vendor-blog"), 5, (search.results || []).map((item) => item.sourceCategory).join(", ")),
		check("ranking reasons are exposed", Array.isArray(search.results?.[0]?.ranking?.reasons) && search.results[0].ranking.reasons.length > 0, 5, JSON.stringify(search.results?.[0]?.ranking || {})),
	], {
		sample: search.results?.slice(0, 2),
	}));

	const novelDiscovery = await postJson(`${backendBase}/v1/search`, {
		query: "2026 uncommon stateless mcp edge agent runtime docs",
		freshness: "year",
		maxResults: 5,
		sourceType: "general",
	});
	results.push(makeCase("search-novel-tech-discovery", 15, [
		check("top 3 include an official docs or getting started page", (novelDiscovery.results || []).slice(0, 3).some((item) => item.sourceCategory === "official-docs" && ["getting-started", "guide", "announcement"].includes(item.resultType)), 5, JSON.stringify((novelDiscovery.results || []).slice(0, 3).map((item) => ({ title: item.title, resultType: item.resultType, category: item.sourceCategory })))),
		check("top 3 include a repo or release signal", (novelDiscovery.results || []).slice(0, 3).some((item) => ["repository-home", "github-releases"].includes(item.resultType)), 5, JSON.stringify((novelDiscovery.results || []).slice(0, 3).map((item) => ({ title: item.title, resultType: item.resultType })))),
		check("generic reference does not monopolize the top 2", (novelDiscovery.results || []).slice(0, 2).filter((item) => /MDN/i.test(item.title || "")).length < 2, 5, JSON.stringify((novelDiscovery.results || []).slice(0, 2).map((item) => item.title))),
	], {
		sample: novelDiscovery.results?.slice(0, 3),
	}));

	const exactConfig = await postJson(`${backendBase}/v1/search`, {
		query: "vercel next.js proxyClientMaxBodySize docs",
		freshness: "month",
		maxResults: 3,
		sourceType: "docs",
		preferredDomains: ["nextjs.org"],
	});
	results.push(makeCase("search-exact-config", 15, [
		check("top result is the exact config reference", /proxyClientMaxBodySize/i.test(exactConfig.results?.[0]?.title || ""), 5, exactConfig.results?.[0]?.title),
		check("top result is classified as configuration or api reference", ["configuration-reference", "api-reference"].includes(exactConfig.results?.[0]?.resultType), 5, exactConfig.results?.[0]?.resultType),
		check("misleading generic docs are not ranked first", !/Telemetry|Codemods/i.test(exactConfig.results?.[0]?.title || ""), 5, JSON.stringify((exactConfig.results || []).map((item) => item.title))),
	], {
		sample: exactConfig.results,
	}));

	const repoSearch = await postJson(`${backendBase}/v1/search`, {
		query: "astral-sh uv github repo official",
		freshness: "year",
		maxResults: 3,
		sourceType: "github",
	});
	results.push(makeCase("search-github-repo-canonical", 15, [
		check("top result is the canonical repo home", repoSearch.results?.[0]?.url === "https://github.com/astral-sh/uv", 5, repoSearch.results?.[0]?.url),
		check("top result is repository-home", repoSearch.results?.[0]?.resultType === "repository-home", 5, repoSearch.results?.[0]?.resultType),
		check("issue pages do not outrank repo home", !String(repoSearch.results?.[0]?.url || "").includes("/issues/"), 5, JSON.stringify((repoSearch.results || []).map((item) => item.url))),
	], {
		sample: repoSearch.results,
	}));

	const markdownFetch = await postJson(`${backendBase}/v1/fetch`, {
		url: `${contentBase}/cf-agents/`,
		mode: "auto",
		extractionProfile: "docs",
	});
	results.push(makeCase("fetch-docs-markdown-preference", 10, [
		check("prefers markdown-aware fetch strategy", markdownFetch.metadata?.strategy === "docs-markdown-fetch", 4, JSON.stringify(markdownFetch.metadata || {})),
		check("content includes markdown-derived docs text", /createMcpHandler|Getting started|agents package/i.test(markdownFetch.content || ""), 3, markdownFetch.content),
		check("html shell text is not dominant", !/HTML shell content that should be bypassed/i.test(markdownFetch.content || ""), 3, markdownFetch.content),
	], {
		sample: { title: markdownFetch.title, strategy: markdownFetch.metadata?.strategy, content: markdownFetch.content?.slice(0, 200) },
	}));

	const mintlifyFetch = await postJson(`${backendBase}/v1/fetch`, {
		url: `${contentBase}/mintlify/guide`,
		mode: "auto",
		extractionProfile: "docs",
	});
	results.push(makeCase("fetch-modern-docs-markdown-heuristics", 15, [
		check("heuristic docs markdown candidate is used", /markdown/i.test(String(mintlifyFetch.metadata?.strategy || "")), 5, JSON.stringify(mintlifyFetch.metadata || {})),
		check("content contains quickstart docs text", /createMcpHandler|Quickstart|stateless MCP/i.test(mintlifyFetch.content || ""), 5, mintlifyFetch.content),
		check("extraction confidence is medium or high", ["medium", "high"].includes(String(mintlifyFetch.metadata?.extractionConfidence || "")), 5, JSON.stringify(mintlifyFetch.metadata || {})),
	], {
		sample: { title: mintlifyFetch.title, strategy: mintlifyFetch.metadata?.strategy, content: mintlifyFetch.content?.slice(0, 200) },
	}));

	const structuredFetch = await postJson(`${backendBase}/v1/fetch`, {
		url: `${contentBase}/vitepress/reference`,
		mode: "auto",
		extractionProfile: "docs",
	});
	results.push(makeCase("fetch-structured-html-extractor", 15, [
		check("structured html extractor is used", /structured/i.test(String(structuredFetch.metadata?.strategy || "")), 5, JSON.stringify(structuredFetch.metadata || {})),
		check("code-aware headings are extracted", Array.isArray(structuredFetch.metadata?.codeAware?.headings) && structuredFetch.metadata.codeAware.headings.length > 0, 5, JSON.stringify(structuredFetch.metadata?.codeAware || {})),
		check("fallback guidance is present or content is strong", Array.isArray(structuredFetch.metadata?.fallbackRecommendations) || /stateless handler API|createMcpHandler/i.test(structuredFetch.content || ""), 5, JSON.stringify(structuredFetch.metadata || {})),
	], {
		sample: { title: structuredFetch.title, strategy: structuredFetch.metadata?.strategy, confidence: structuredFetch.metadata?.extractionConfidence },
	}));

	const docsSearchTrust = await postJson(`${backendBase}/v1/search`, {
		query: "react server caching best practices",
		freshness: "month",
		maxResults: 3,
		sourceType: "docs",
		preferredDomains: ["react.dev", "nextjs.org"],
	});
	results.push(makeCase("search-trust-signals", 10, [
		check("top result exposes trust signals", typeof docsSearchTrust.results?.[0]?.trustSignals?.authority === "string", 5, JSON.stringify(docsSearchTrust.results?.[0] || {})),
		check("top result is marked official or high authority", docsSearchTrust.results?.[0]?.trustSignals?.official === true || docsSearchTrust.results?.[0]?.trustSignals?.authority === "high", 5, JSON.stringify(docsSearchTrust.results?.[0]?.trustSignals || {})),
	], {
		sample: docsSearchTrust.results?.[0],
	}));

	const bestPractice = await postJson(`${backendBase}/v1/research`, {
		question: "What are current best practices for React server caching?",
		mode: "best-practice",
		freshness: "month",
		numberOfSources: 4,
		outputDepth: "standard",
	});
	results.push(makeCase("research-best-practice", 20, [
		check("answer is present", typeof bestPractice.answer === "string" && bestPractice.answer.length > 40, 4, bestPractice.answer),
		check("sources >= 3", (bestPractice.sources || []).length >= 3, 4, `count=${bestPractice.sources?.length || 0}`),
		check("contains official docs", hasCategory(bestPractice.sources, "official-docs"), 4, (bestPractice.sources || []).map((item) => item.sourceCategory).join(", ")),
		check("agreement signals exist", Array.isArray(bestPractice.agreements) && bestPractice.agreements.length > 0, 4, JSON.stringify(bestPractice.agreements || [])),
		check("confidence is medium or high", ["medium", "high"].includes(bestPractice.confidence), 4, bestPractice.confidence),
	], {
		sample: { answer: bestPractice.answer, categories: (bestPractice.sources || []).map((item) => item.sourceCategory) },
	}));

	const technical = await postJson(`${backendBase}/v1/research`, {
		question: "What is the impact of upgrading CacheX from v1 to v2?",
		mode: "technical",
		freshness: "month",
		numberOfSources: 4,
		outputDepth: "standard",
	});
	results.push(makeCase("research-technical-change", 20, [
		check("release notes are included", hasCategory(technical.sources, "release-notes"), 4, (technical.sources || []).map((item) => item.sourceCategory).join(", ")),
		check("official docs are included", hasCategory(technical.sources, "official-docs"), 4, (technical.sources || []).map((item) => item.sourceCategory).join(", ")),
		check("community/github evidence is included", hasAnyCategory(technical.sources, ["github-issue", "github-discussion", "vendor-blog"]), 4, (technical.sources || []).map((item) => item.sourceCategory).join(", ")),
		check("answer mentions migration or breaking changes", /migration|breaking|compatibility|upgrade/i.test(technical.answer || ""), 4, technical.answer),
		check("findings mention migration implications", (technical.findings || []).some((item) => /migration|compatibility|adapter|invalidation/i.test(item)), 4, JSON.stringify(technical.findings || [])),
	], {
		sample: { answer: technical.answer, categories: (technical.sources || []).map((item) => item.sourceCategory) },
	}));

	const instructionHeavyTechnical = await postJson(`${backendBase}/v1/research`, {
		question: "Use the research_query tool once in technical mode to assess the impact of upgrading CacheX from v1 to v2. Return exactly these sections: Risks, Migration steps, Citations. In Citations include source title and URL.",
		mode: "technical",
		freshness: "month",
		numberOfSources: 4,
		outputDepth: "brief",
	});
	results.push(makeCase("research-instruction-heavy-sanitization", 15, [
		check("canonical migration sources are still retrieved", hasCategory(instructionHeavyTechnical.sources, "official-docs") && hasCategory(instructionHeavyTechnical.sources, "release-notes"), 5, JSON.stringify((instructionHeavyTechnical.sources || []).map((item) => ({ title: item.title, category: item.sourceCategory })))),
		check("answer still references upgrade or migration", /upgrade|migration|breaking|adapter|invalidation/i.test(instructionHeavyTechnical.answer || ""), 5, instructionHeavyTechnical.answer),
		check("recommendation or findings mention adapter or invalidation specifics", /adapter|invalidation/i.test(JSON.stringify([instructionHeavyTechnical.recommendation, instructionHeavyTechnical.findings, instructionHeavyTechnical.risks])), 5, JSON.stringify({ recommendation: instructionHeavyTechnical.recommendation, findings: instructionHeavyTechnical.findings, risks: instructionHeavyTechnical.risks })),
	], {
		sample: { answer: instructionHeavyTechnical.answer, recommendation: instructionHeavyTechnical.recommendation, categories: (instructionHeavyTechnical.sources || []).map((item) => item.sourceCategory) },
	}));

	const partialResearch = await postJson(`${backendBase}/v1/research`, {
		question: "Partial fallback research query for docs reliability",
		mode: "technical",
		freshness: "month",
		numberOfSources: 2,
		outputDepth: "brief",
	});
	results.push(makeCase("research-partial-result-recovery", 15, [
		check("research returns partial success instead of total abort", ["partial_success", "success"].includes(String(partialResearch.status || "")), 5, JSON.stringify({ status: partialResearch.status, failures: partialResearch.failures })),
		check("research preserves at least one usable source", (partialResearch.sources || []).length >= 1, 5, JSON.stringify(partialResearch.sources || [])),
		check("failures or retry suggestions are exposed", (Array.isArray(partialResearch.failures) && partialResearch.failures.length > 0) || (Array.isArray(partialResearch.retrySuggestions) && partialResearch.retrySuggestions.length > 0), 5, JSON.stringify({ failures: partialResearch.failures, retrySuggestions: partialResearch.retrySuggestions })),
	], {
		sample: { status: partialResearch.status, failures: partialResearch.failures, retrySuggestions: partialResearch.retrySuggestions },
	}));

	const reactUpgrade = await postJson(`${backendBase}/v1/research`, {
		question: "React 19 official upgrade considerations",
		mode: "technical",
		freshness: "year",
		numberOfSources: 3,
		outputDepth: "brief",
		preferredDomains: ["react.dev"],
	});
	results.push(makeCase("research-canonical-upgrade-anchor", 15, [
		check("top source is the upgrade guide", /Upgrade Guide/i.test(reactUpgrade.sources?.[0]?.title || ""), 5, reactUpgrade.sources?.[0]?.title),
		check("top source is classified as migration guide or release notes", ["migration-guide", "release-notes"].includes(reactUpgrade.sources?.[0]?.resultType), 5, reactUpgrade.sources?.[0]?.resultType),
		check("answer references upgrade or migration", /upgrade|migration|breaking/i.test(reactUpgrade.answer || ""), 5, reactUpgrade.answer),
	], {
		sample: { titles: (reactUpgrade.sources || []).map((item) => item.title), resultTypes: (reactUpgrade.sources || []).map((item) => item.resultType) },
	}));

	const discovery = await postJson(`${backendBase}/v1/research`, {
		question: "Find a newer niche edge agent runtime for stateless MCP servers",
		mode: "technical",
		freshness: "year",
		numberOfSources: 3,
		outputDepth: "brief",
	});
	results.push(makeCase("research-novel-tech-discovery", 20, [
		check("returns at least 3 sources", (discovery.sources || []).length >= 3, 4, `count=${discovery.sources?.length || 0}`),
		check("includes official docs or getting started anchor", (discovery.sources || []).some((item) => item.sourceCategory === "official-docs" && ["getting-started", "guide"].includes(item.resultType)), 4, JSON.stringify((discovery.sources || []).map((item) => ({ title: item.title, type: item.resultType, category: item.sourceCategory })))),
		check("includes repo or release evidence", (discovery.sources || []).some((item) => ["repository-home", "github-releases"].includes(item.resultType)), 4, JSON.stringify((discovery.sources || []).map((item) => item.resultType))),
		check("answer references stateless MCP or agents", /stateless|mcp|agent|runtime/i.test(discovery.answer || ""), 4, discovery.answer),
		check("agreement or gap signals exist", (Array.isArray(discovery.agreements) && discovery.agreements.length > 0) || (Array.isArray(discovery.gaps) && discovery.gaps.length > 0), 4, JSON.stringify({ agreements: discovery.agreements, gaps: discovery.gaps })),
	], {
		sample: { answer: discovery.answer, categories: (discovery.sources || []).map((item) => item.sourceCategory), types: (discovery.sources || []).map((item) => item.resultType) },
	}));

	const analysis = await postJson(`${backendBase}/v1/analyze`, {
		question: "Compare official guidance vs community guidance for React caching.",
		comparisonMode: "official-vs-community",
		sources: [
			{ url: `${contentBase}/react-cache-official`, title: "Official React caching guidance" },
			{ url: `${contentBase}/community-react-caching`, title: "Community React caching discussion" },
		],
	});
	results.push(makeCase("analyze-official-vs-community", 15, [
		check("agreements exist", Array.isArray(analysis.agreements) && analysis.agreements.length > 0, 3, JSON.stringify(analysis.agreements || [])),
		check("disagreements exist", Array.isArray(analysis.disagreements) && analysis.disagreements.length > 0, 3, JSON.stringify(analysis.disagreements || [])),
		check("official source category is preserved", hasCategory(analysis.sources, "official-docs"), 3, (analysis.sources || []).map((item) => item.sourceCategory).join(", ")),
		check("strongest evidence is produced", Array.isArray(analysis.strongestEvidence) && analysis.strongestEvidence.length > 0, 3, JSON.stringify(analysis.strongestEvidence || [])),
		check("decision-support fields are present", typeof analysis.officialPosition === "string" && typeof analysis.recommendation === "string", 3, JSON.stringify({ officialPosition: analysis.officialPosition, recommendation: analysis.recommendation })),
	], {
		sample: { categories: (analysis.sources || []).map((item) => item.sourceCategory), recommendation: analysis.recommendation },
	}));

	const cacheWarm = await postJson(`${backendBase}/v1/research`, {
		question: "What are current best practices for React server caching?",
		mode: "best-practice",
		freshness: "month",
		numberOfSources: 4,
		outputDepth: "standard",
	});
	const cacheHit = await postJson(`${backendBase}/v1/research`, {
		question: "What are current best practices for React server caching?",
		mode: "best-practice",
		freshness: "month",
		numberOfSources: 4,
		outputDepth: "standard",
	});
	const health = await getJson(`${backendBase}/health`);
	results.push(makeCase("cache-effectiveness", 10, [
		check("second research call is served from cache", cacheHit.metadata?.cache?.hit === true, 5, JSON.stringify(cacheHit.metadata?.cache || {})),
		check("health exposes cache stats with hits", Number(health.cache?.research?.hits || 0) >= 1, 5, JSON.stringify(health.cache || {})),
	], {
		sample: { warm: cacheWarm.metadata?.cache, hit: cacheHit.metadata?.cache, healthCache: health.cache },
	}));

	return results;
}

async function main() {
	const contentServer = createContentServer();
	const searchServer = createFakeSearchServer();
	let backend;
	try {
		await waitForServer(contentServer, ports.content);
		await waitForServer(searchServer, ports.search);
		await mkdir(resolve(PROJECT_ROOT, "qa", "tmp"), { recursive: true });
		await writeFile(docsFetchRulesPath, JSON.stringify({ rules: [{ domain: "127.0.0.1", pathSuffixCandidates: ["llms-full.txt"], accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.5" }] }, null, 2));
		backend = startBackend();
		await waitForHealth(backendBase);
		const cases = annotateBenchmarkCases("deterministic", await runBenchmarks());
		const totalScore = cases.reduce((sum, item) => sum + item.score, 0);
		const totalMaxScore = cases.reduce((sum, item) => sum + item.maxScore, 0);
		const benchmarkFamilies = summarizeBenchmarkFamilies(cases);
		const percentage = Math.round((totalScore / totalMaxScore) * 100);
		const report = {
			ok: percentage >= 85,
			totalScore,
			totalMaxScore,
			percentage,
			generatedAt: new Date().toISOString(),
			benchmarkFamilies,
			cases,
		};

		await mkdir(REPORT_DIR, { recursive: true });
		await writeFile(resolve(REPORT_DIR, "research-quality-latest.json"), JSON.stringify(report, null, 2));
		await writeFile(resolve(REPORT_DIR, "research-quality-latest.md"), renderMarkdownReport(report));

		console.log(`QUALITY BENCHMARK: ${totalScore}/${totalMaxScore} (${percentage}%)`);
		for (const item of cases) {
			console.log(`- ${item.name}: ${item.score}/${item.maxScore}`);
		}
		console.log(`Report: ${resolve(REPORT_DIR, "research-quality-latest.json")}`);

		if (!report.ok) {
			throw new Error(`Quality benchmark below threshold: ${percentage}%`);
		}
	} finally {
		contentServer.close();
		searchServer.close();
		if (backend && !backend.killed) backend.kill();
	}
}

function renderMarkdownReport(report) {
	const lines = [
		"# Research quality benchmark report",
		"",
		`- Generated: ${report.generatedAt}`,
		`- Score: ${report.totalScore}/${report.totalMaxScore} (${report.percentage}%)`,
		`- Pass threshold: 85%`,
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
	console.error("QUALITY BENCHMARK FAIL:", error);
	process.exit(1);
});
