import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const REPORT_DIR = resolve(PROJECT_ROOT, "qa", "reports");
const EXTENSION_ENTRY = resolve(PROJECT_ROOT, "extensions", "web-research", "src", "index.ts");

const ports = {
	content: 8881,
	search: 8882,
	backend: 8883,
};

const contentBase = `http://127.0.0.1:${ports.content}`;
const searchBase = `http://127.0.0.1:${ports.search}`;
const backendBase = `http://127.0.0.1:${ports.backend}`;

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
	"/cf-agents-docs": {
		title: "Build Agents on Example Cloud",
		canonicalUrl: "https://developers.examplecloud.dev/agents",
		body: `
		<article>
		<h1>Build Agents on Example Cloud</h1>
		<p>Example Cloud Agents provides a newer edge runtime for stateful agents and stateless MCP servers.</p>
		<p>The docs highlight createMcpHandler and stateless server guidance.</p>
		</article>
		`,
	},
	"/cf-agents-release": {
		title: "Example Cloud Agents release notes",
		canonicalUrl: "https://developers.examplecloud.dev/agents/release-notes",
		body: `
		<article>
		<h1>Example Cloud Agents release notes</h1>
		<p>Release notes cover newer MCP support, package updates, and stateless runtime changes.</p>
		</article>
		`,
	},
	"/cf-agents-repo": {
		title: "examplecloud/agents",
		canonicalUrl: "https://github.com/examplecloud/agents",
		body: `
		<article>
		<h1>examplecloud/agents</h1>
		<p>Official repository for Example Cloud Agents with SDK code and examples.</p>
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
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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
		if (q.includes("react") && q.includes("cach")) {
			results = [
				searchItem("Official React caching guidance", "/react-cache-official", "Official guidance on deduplication, invalidation, and freshness boundaries.", "2026-04-06T10:00:00Z", "docs", "official-docs"),
				searchItem("Next.js caching guide", "/nextjs-cache-guide", "Framework guidance on caching and revalidation tradeoffs.", "2026-04-05T09:00:00Z", "docs", "official-docs"),
				searchItem("Community React caching discussion", "/community-react-caching", "Community advice on TTLs, correctness, and invalidation edge cases.", "2026-04-03T07:30:00Z", "general", "forum-community"),
			];
		} else if (q.includes("cachex") || q.includes("upgrade") || q.includes("migration")) {
			results = [
				searchItem("CacheX v2 migration guide", "/cachex-v2-migration", "Official migration guidance for invalidation hooks and adapter changes.", "2026-04-06T12:00:00Z", "docs", "official-docs"),
				searchItem("CacheX v2 release notes", "/cachex-v2-release", "Release notes covering breaking changes and removed sync adapter.", "2026-04-06T11:00:00Z", "docs", "release-notes"),
				searchItem("CacheX issue: migration pain points", "/cachex-github-issue", "Community issue discussing edge cases and compatibility concerns.", "2026-04-05T13:00:00Z", "github", "github-issue"),
				searchItem("CacheX engineering blog on v2 rollout", "/cachex-vendor-blog", "Vendor perspective on staged rollout and rollback readiness.", "2026-04-04T09:30:00Z", "general", "vendor-blog"),
			];
		} else if (q.includes("agent") || q.includes("mcp") || q.includes("edge runtime") || q.includes("niche")) {
			results = [
				searchItem("Build Agents on Example Cloud", "/cf-agents-docs", "A newer edge runtime for stateful agents and stateless MCP servers.", "2026-04-07T09:20:00Z", "docs", "official-docs"),
				searchItem("Example Cloud Agents release notes", "/cf-agents-release", "Release notes for MCP support and stateless runtime updates.", "2026-04-07T08:50:00Z", "docs", "release-notes"),
				searchItem("examplecloud/agents", "/cf-agents-repo", "Official repository for Example Cloud Agents.", "2026-04-07T08:10:00Z", "github", "github-repo"),
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

async function runAgentTask(task) {
	const env = { ...process.env, PI_RESEARCH_BASE_URL: backendBase };
	const proc = spawn("pi", ["--mode", "rpc", "--no-session", "-e", EXTENSION_ENTRY], {
		cwd: PROJECT_ROOT,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	let buffer = "";
	const pending = new Map();

	proc.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	proc.stdout.on("data", (chunk) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (parsed.type === "response" && parsed.id && pending.has(parsed.id)) {
				const entry = pending.get(parsed.id);
				clearTimeout(entry.timeout);
				pending.delete(parsed.id);
				entry.resolve(parsed);
			}
		}
	});

	const rpc = (message, timeoutMs = 240000) => new Promise((resolve, reject) => {
		const id = message.id;
		const timeout = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`RPC timeout waiting for ${id}`));
		}, timeoutMs);
		pending.set(id, { resolve, reject, timeout });
		proc.stdin.write(JSON.stringify(message) + "\n");
	});

	try {
		await rpc({ id: "prompt-1", type: "prompt", message: task.prompt }, 60000);

		let ready = false;
		for (let i = 0; i < 300; i++) {
			const state = await rpc({ id: `state-${i}`, type: "get_state" }, 30000);
			const data = state.data || {};
			if (!data.isStreaming && !data.isCompacting && (data.pendingMessageCount || 0) === 0 && (data.messageCount || 0) >= 2) {
				ready = true;
				break;
			}
			await sleep(1000);
		}
		if (!ready) {
			throw new Error(`Agent task did not finish in time. stderr=${stderr}`);
		}

		const messagesResponse = await rpc({ id: "messages-1", type: "get_messages" }, 60000);
		const messages = messagesResponse.data?.messages || [];
		const assistantMessages = messages.filter((item) => item.role === "assistant");
		const finalAssistant = assistantMessages[assistantMessages.length - 1];
		const finalText = extractAssistantText(finalAssistant);
		const toolNames = messages.filter((item) => item.role === "toolResult").map((item) => item.toolName);
		return {
			prompt: task.prompt,
			finalText,
			toolNames,
			messages,
			stderr,
		};
	} finally {
		for (const entry of pending.values()) clearTimeout(entry.timeout);
		proc.kill();
	}
}

function extractAssistantText(message) {
	const parts = (message?.content || []).filter((item) => item.type === "text").map((item) => item.text);
	return parts.join("\n").trim();
}

function countUrls(text) {
	const matches = String(text || "").match(/https?:\/\/\S+/g);
	return matches ? matches.length : 0;
}

function hasTool(toolNames, expected) {
	return expected.some((name) => toolNames.includes(name));
}

function check(name, pass, maxPoints, detail) {
	return { name, pass: Boolean(pass), points: pass ? maxPoints : 0, maxPoints, detail };
}

function makeCase(name, maxScore, checks, extra = {}) {
	const score = checks.reduce((sum, item) => sum + item.points, 0);
	return { name, maxScore, score, checks, ...extra };
}

async function main() {
	const contentServer = createContentServer();
	const searchServer = createFakeSearchServer();
	let backend;
	try {
		await waitForServer(contentServer, ports.content);
		await waitForServer(searchServer, ports.search);
		backend = startBackend();
		await waitForHealth(backendBase);

		const tasks = [
			{
				name: "agent-best-practice-task",
				maxScore: 25,
				prompt: "Use the research_query tool once in best-practice mode to answer this engineering task: What are current best practices for React server caching? Return exactly these sections: Findings, Actions, Citations. In Citations include source title and URL.",
				evaluate(output) {
					return [
						check("used research tools", hasTool(output.toolNames, ["research_query", "search_web", "fetch_url"]), 5, output.toolNames.join(", ")),
						check("response has required sections", /Findings/i.test(output.finalText) && /Actions/i.test(output.finalText) && /Citations/i.test(output.finalText), 5, output.finalText),
						check("mentions core caching guidance", /dedup|invalidation|freshness|stale|revalidation/i.test(output.finalText), 5, output.finalText),
						check("includes at least 2 citations", countUrls(output.finalText) >= 2, 5, `urlCount=${countUrls(output.finalText)}`),
						check("final answer is non-trivial", output.finalText.length > 180, 5, `length=${output.finalText.length}`),
					];
				},
			},
			{
				name: "agent-technical-impact-task",
				maxScore: 25,
				prompt: "Use the research_query tool once in technical mode to assess the impact of upgrading CacheX from v1 to v2. Return exactly these sections: Risks, Migration steps, Citations. In Citations include source title and URL.",
				evaluate(output) {
					return [
						check("used research tools", hasTool(output.toolNames, ["research_query", "search_web", "fetch_url"]), 5, output.toolNames.join(", ")),
						check("response has required sections", /Risks/i.test(output.finalText) && /Migration steps/i.test(output.finalText) && /Citations/i.test(output.finalText), 5, output.finalText),
						check("mentions migration or breaking changes", /migration|breaking|compatibility|upgrade/i.test(output.finalText), 5, output.finalText),
						check("mentions sync adapter or invalidation hooks", /sync adapter|invalidation hook|stale-read|adapter/i.test(output.finalText), 5, output.finalText),
						check("includes at least 2 citations", countUrls(output.finalText) >= 2, 5, `urlCount=${countUrls(output.finalText)}`),
					];
				},
			},
			{
				name: "agent-discovery-task",
				maxScore: 25,
				prompt: "Use the research_query tool once in technical mode to identify a promising newer niche edge runtime for stateless MCP servers. Return exactly these sections: Candidate, Why it matters, Citations. In Citations include source title and URL.",
				evaluate(output) {
					return [
						check("used research tools", hasTool(output.toolNames, ["research_query", "search_web", "fetch_url"]), 5, output.toolNames.join(", ")),
						check("response has required sections", /Candidate/i.test(output.finalText) && /Why it matters/i.test(output.finalText) && /Citations/i.test(output.finalText), 5, output.finalText),
						check("mentions agents or MCP or stateless runtime", /agent|mcp|stateless|runtime|createMcpHandler/i.test(output.finalText), 5, output.finalText),
						check("mentions why the stack is useful or notable", /why|useful|notable|new|edge|stateful|niche/i.test(output.finalText), 5, output.finalText),
						check("includes at least 2 citations", countUrls(output.finalText) >= 2, 5, `urlCount=${countUrls(output.finalText)}`),
					];
				},
			},
			{
				name: "agent-official-vs-community-task",
				maxScore: 25,
				prompt: "Use the research_query tool once, and if needed one analyze_sources call, to compare official guidance vs community guidance for React caching. Return exactly these sections: Official, Community, Bottom line, Citations. In Citations include source title and URL.",
				evaluate(output) {
					return [
						check("used research tools", hasTool(output.toolNames, ["analyze_sources", "research_query", "search_web", "fetch_url"]), 5, output.toolNames.join(", ")),
						check("response has required sections", /Official/i.test(output.finalText) && /Community/i.test(output.finalText) && /Bottom line/i.test(output.finalText) && /Citations/i.test(output.finalText), 5, output.finalText),
						check("distinguishes official and community guidance", /official/i.test(output.finalText) && /community/i.test(output.finalText), 5, output.finalText),
						check("mentions tradeoffs or edge cases", /tradeoff|edge case|correctness|revalidation|invalidation/i.test(output.finalText), 5, output.finalText),
						check("includes at least 2 citations", countUrls(output.finalText) >= 2, 5, `urlCount=${countUrls(output.finalText)}`),
					];
				},
			},
		];

		const cases = [];
		for (const task of tasks) {
			console.log(`Running agent task benchmark: ${task.name}`);
			const output = await runAgentTask(task);
			const checks = task.evaluate(output);
			cases.push(makeCase(task.name, task.maxScore, checks, {
				toolNames: output.toolNames,
				finalText: output.finalText,
			}));
		}

		const totalScore = cases.reduce((sum, item) => sum + item.score, 0);
		const totalMaxScore = cases.reduce((sum, item) => sum + item.maxScore, 0);
		const percentage = Math.round((totalScore / totalMaxScore) * 100);
		const report = {
			ok: percentage >= 85,
			totalScore,
			totalMaxScore,
			percentage,
			generatedAt: new Date().toISOString(),
			mode: "pi-agent-task",
			cases,
		};

		await mkdir(REPORT_DIR, { recursive: true });
		await writeFile(resolve(REPORT_DIR, "pi-agent-task-benchmark-latest.json"), JSON.stringify(report, null, 2));
		await writeFile(resolve(REPORT_DIR, "pi-agent-task-benchmark-latest.md"), renderMarkdownReport(report));

		console.log(`PI AGENT BENCHMARK: ${totalScore}/${totalMaxScore} (${percentage}%)`);
		for (const item of cases) {
			console.log(`- ${item.name}: ${item.score}/${item.maxScore}`);
		}
		console.log(`Report: ${resolve(REPORT_DIR, "pi-agent-task-benchmark-latest.json")}`);

		if (!report.ok) {
			throw new Error(`Pi agent benchmark below threshold: ${percentage}%`);
		}
	} finally {
		contentServer.close();
		searchServer.close();
		if (backend && !backend.killed) backend.kill();
	}
}

function renderMarkdownReport(report) {
	const lines = [
		"# Pi agent task benchmark report",
		"",
		`- Generated: ${report.generatedAt}`,
		`- Score: ${report.totalScore}/${report.totalMaxScore} (${report.percentage}%)`,
		`- Pass threshold: 85%`,
		`- Status: ${report.ok ? "PASS" : "FAIL"}`,
		"",
		"## Cases",
		"",
	];
	for (const item of report.cases) {
		lines.push(`### ${item.name}`);
		lines.push(`- Score: ${item.score}/${item.maxScore}`);
		lines.push(`- Tools used: ${item.toolNames.join(", ")}`);
		for (const rule of item.checks) {
			lines.push(`- [${rule.pass ? "x" : " "}] ${rule.name} (${rule.points}/${rule.maxPoints})`);
			if (rule.detail) lines.push(`  - Detail: ${rule.detail}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

main().catch((error) => {
	console.error("PI AGENT BENCHMARK FAIL:", error);
	process.exit(1);
});
