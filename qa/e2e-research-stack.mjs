import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const EXTENSION_ENTRY = resolve(PROJECT_ROOT, "extensions", "web-research", "src", "index.ts");

const ports = {
	content: 8861,
	search: 8862,
	backend: 8863,
};

const contentBase = `http://127.0.0.1:${ports.content}`;
const searchBase = `http://127.0.0.1:${ports.search}`;
const backendBase = `http://127.0.0.1:${ports.backend}`;

const pageFixtures = {
	"/official-react-caching": {
		title: "Official React caching guidance",
		body: `
		<article>
		<h1>Official React caching guidance</h1>
		<p>Official guidance recommends explicit cache invalidation and careful freshness boundaries.</p>
		<p>Server caching should reduce repeated work while avoiding stale data leaks.</p>
		<p>Framework-level caching should be documented and observable.</p>
		</article>
		`,
	},
	"/community-react-caching": {
		title: "Community guide to React caching",
		body: `
		<article>
		<h1>Community guide to React caching</h1>
		<p>Community guidance emphasizes pragmatic cache invalidation, source-aware TTLs, and explicit revalidation.</p>
		<p>Developers should prefer correctness first and optimize latency second.</p>
		</article>
		`,
	},
	"/edge-agent-runtime-1": {
		title: "Edge agent runtime guide one",
		body: `
		<article>
		<h1>Edge agent runtime guide one</h1>
		<p>Recent docs describe a newer edge runtime for stateless MCP servers and agent orchestration.</p>
		<p>Guidance emphasizes explicit setup steps and runtime constraints.</p>
		</article>
		`,
	},
	"/edge-agent-runtime-2": {
		title: "Edge agent runtime guide two",
		body: `
		<article>
		<h1>Edge agent runtime guide two</h1>
		<p>Additional guidance highlights deployment notes, runtime tradeoffs, and implementation caveats.</p>
		<p>Examples show how to structure handlers and expose MCP endpoints.</p>
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
		res.end(`<!doctype html><html><head><title>${fixture.title}</title><link rel="canonical" href="${contentBase}${req.url}" /></head><body>${fixture.body}</body></html>`);
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
		let results;
		if (q.includes("react") || q.includes("caching")) {
			results = [
				{
					title: "Official React caching guidance",
					url: `${contentBase}/official-react-caching`,
					content: "Official guidance on invalidation, freshness, and observability.",
					publishedDate: "2026-04-06T10:00:00Z",
					engine: "fixture",
				},
				{
					title: "Community guide to React caching",
					url: `${contentBase}/community-react-caching`,
					content: "Community perspective on TTLs, revalidation, and correctness-first caching.",
					publishedDate: "2026-04-05T09:00:00Z",
					engine: "fixture",
				},
			];
		} else {
			results = [
				{
					title: "Edge agent runtime guide one",
					url: `${contentBase}/edge-agent-runtime-1`,
					content: "Recent docs describe a newer edge runtime for stateless MCP servers.",
					publishedDate: "2026-04-07T08:00:00Z",
					engine: "fixture",
				},
				{
					title: "Edge agent runtime guide two",
					url: `${contentBase}/edge-agent-runtime-2`,
					content: "Guidance highlights runtime tradeoffs and MCP endpoint structure.",
					publishedDate: "2026-04-07T07:30:00Z",
					engine: "fixture",
				},
			];
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ results }));
	});
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

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function rpcRoundtrip(message, env = {}) {
	const proc = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "-e", EXTENSION_ENTRY], {
		cwd: PROJECT_ROOT,
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	return await new Promise((resolve, reject) => {
		let stderr = "";
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		proc.stdout.on("data", (chunk) => {
			for (const line of chunk.toString().split("\n")) {
				if (!line.trim()) continue;
				let parsed;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue;
				}
				if (parsed.type === "response") {
					proc.kill();
					resolve({ response: parsed, stderr });
					return;
				}
			}
		});
		proc.on("error", reject);
		proc.stdin.write(JSON.stringify(message) + "\n");
		proc.stdin.end();
		setTimeout(() => {
			proc.kill();
			reject(new Error(`RPC timeout. stderr=${stderr}`));
		}, 10000);
	});
}

async function main() {
	const contentServer = createContentServer();
	const searchServer = createFakeSearchServer();
	const isolatedHome = await mkdtemp(resolve(tmpdir(), "pi-e2e-home-"));
	let backend;
	try {
		await waitForServer(contentServer, ports.content);
		await waitForServer(searchServer, ports.search);
		backend = startBackend();
		const health = await waitForHealth(backendBase);
		assert(health.ok === true, "backend health should be ok");

		const search = await postJson(`${backendBase}/v1/search`, {
			query: "react caching best practices",
			freshness: "week",
			maxResults: 5,
			sourceType: "docs",
		});
		assert(Array.isArray(search.results), "search results should be an array");
		assert(search.results.length >= 2, "search should return at least two results");
		assert(search.results[0].title.includes("React"), "top search result should mention React");
		assert(typeof search.results[0].sourceCategory === "string", "search should classify source categories");
		assert(Array.isArray(search.results[0].ranking?.reasons), "search should expose ranking reasons");

		const fetched = await postJson(`${backendBase}/v1/fetch`, {
			url: `${contentBase}/official-react-caching`,
			mode: "auto",
			extractionProfile: "docs",
		});
		assert(fetched.title === "Official React caching guidance", "fetch should extract title");
		assert(String(fetched.content).includes("cache invalidation"), "fetch should extract cleaned content");
		assert(typeof fetched.metadata?.requestId === "string", "fetch should expose request id metadata");

		const research = await postJson(`${backendBase}/v1/research`, {
			question: "What are current best practices for React server caching?",
			mode: "best-practice",
			freshness: "month",
			numberOfSources: 2,
			outputDepth: "standard",
		});
		assert(typeof research.answer === "string" && research.answer.length > 0, "research should produce answer");
		assert(typeof research.summary === "string" && research.summary.length > 0, "research should produce summary");
		assert(Array.isArray(research.findings) && research.findings.length > 0, "research should produce findings");
		assert(Array.isArray(research.agreements), "research should produce agreements");
		assert(Array.isArray(research.disagreements), "research should produce disagreements");
		assert(Array.isArray(research.sources) && research.sources.length >= 2, "research should produce sources");
		assert(typeof research.sources[0].sourceCategory === "string", "research sources should expose categories");
		assert(typeof research.confidence === "string", "research should produce confidence");

		const analyze = await postJson(`${backendBase}/v1/analyze`, {
			question: "Compare these caching recommendations",
			comparisonMode: "agreement",
			sources: [
				{ title: "Source A", content: "Caching improves latency and requires explicit invalidation." },
				{ title: "Source B", content: "Caching improves latency but stale data risks require clear invalidation policies." },
			],
		});
		assert(typeof analyze.summary === "string" && analyze.summary.length > 0, "analyze should produce summary");
		assert(Array.isArray(analyze.agreements), "analyze should produce agreements array");
		assert(Array.isArray(analyze.sources) && analyze.sources.length === 2, "analyze should preserve both sources");
		assert(typeof analyze.sources[0].sourceCategory === "string", "analyze should classify source categories");

		const invalidate = await postJson(`${backendBase}/v1/cache/invalidate`, { namespace: "research" });
		assert(invalidate.ok === true, "cache invalidation endpoint should work");

		const commands = await rpcRoundtrip({ type: "get_commands" }, { PI_RESEARCH_BASE_URL: backendBase, HOME: isolatedHome, USERPROFILE: isolatedHome });
		assert(commands.response.success === true, "RPC get_commands should succeed");
		const names = (commands.response.data?.commands || []).map((command) => command.name);
		assert(names.includes("web-research"), "extension should register /web-research");
		assert(!names.includes("research"), "extension should not register legacy /research");
		assert(!names.includes("research-config"), "extension should not register legacy /research-config");
		assert(!names.includes("research-health"), "extension should not register legacy /research-health");

		const commandExec = await rpcRoundtrip({ type: "prompt", message: "/web-research status" }, { PI_RESEARCH_BASE_URL: backendBase, HOME: isolatedHome, USERPROFILE: isolatedHome });
		assert(commandExec.response.success === true, "extension command /web-research status should execute successfully");

		console.log("QA PASS: backend and extension basic E2E flow is working.");
	} finally {
		contentServer.close();
		searchServer.close();
		if (backend && !backend.killed) backend.kill();
	}
}

main().catch((error) => {
	console.error("QA FAIL:", error);
	process.exit(1);
});
