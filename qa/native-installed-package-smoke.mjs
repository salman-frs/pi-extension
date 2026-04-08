import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");

const ports = {
	content: 8891,
	search: 8892,
	backend: 8893,
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

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function extractAssistantText(message) {
	const parts = (message?.content || []).filter((item) => item.type === "text").map((item) => item.text);
	return parts.join("\n").trim();
}

function createRpcClient(env = {}) {
	const proc = spawn("pi", ["--mode", "rpc", "--no-session"], {
		cwd: PROJECT_ROOT,
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	let buffer = "";
	const pending = new Map();
	const events = [];

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
			} else {
				events.push(parsed);
			}
		}
	});

	const rpc = (message, timeoutMs = 60000) => new Promise((resolve, reject) => {
		const id = message.id;
		const timeout = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`RPC timeout waiting for ${id}. stderr=${stderr}`));
		}, timeoutMs);
		pending.set(id, { resolve, reject, timeout });
		proc.stdin.write(JSON.stringify(message) + "\n");
	});

	return {
		proc,
		rpc,
		events,
		getStderr: () => stderr,
		close() {
			for (const entry of pending.values()) clearTimeout(entry.timeout);
			proc.kill();
		},
	};
}

async function waitUntilIdle(client, minMessageCount = 2, timeoutMs = 120000) {
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;
	while (Date.now() < deadline) {
		const state = await client.rpc({ id: `state-${++attempt}`, type: "get_state" }, 30000);
		const data = state.data || {};
		if (!data.isStreaming && !data.isCompacting && (data.pendingMessageCount || 0) === 0 && (data.messageCount || 0) >= minMessageCount) {
			return data;
		}
		await sleep(500);
	}
	throw new Error(`Agent did not become idle. stderr=${client.getStderr()}`);
}

async function runPromptCase(client, name, prompt, expectedToolName, validate) {
	const eventStartIndex = client.events.length;
	await client.rpc({ id: `prompt-${name}`, type: "prompt", message: prompt }, 30000);
	await waitUntilIdle(client, 2, 120000);
	const messagesResponse = await client.rpc({ id: `messages-${name}`, type: "get_messages" }, 30000);
	const messages = messagesResponse.data?.messages || [];
	const assistantMessages = messages.filter((item) => item.role === "assistant");
	const finalAssistant = assistantMessages[assistantMessages.length - 1];
	const finalText = extractAssistantText(finalAssistant);
	const toolNames = messages.filter((item) => item.role === "toolResult").map((item) => item.toolName);
	const newEvents = client.events.slice(eventStartIndex);
	const eventToolNames = newEvents.filter((item) => item.type === "tool_execution_start").map((item) => item.toolName);
	assert(toolNames.includes(expectedToolName) || eventToolNames.includes(expectedToolName), `${name}: expected tool ${expectedToolName}, got messages=${toolNames.join(",")} events=${eventToolNames.join(",")}`);
	validate(finalText, { toolNames, eventToolNames, messages, events: newEvents });
	return { name, finalText, toolNames, eventToolNames, caseTools: [...new Set(eventToolNames)] };
}

async function main() {
	const contentServer = createContentServer();
	const searchServer = createFakeSearchServer();
	let backend;
	let client;
	try {
		await waitForServer(contentServer, ports.content);
		await waitForServer(searchServer, ports.search);
		backend = startBackend();
		await waitForHealth(backendBase);

		client = createRpcClient({ PI_RESEARCH_BASE_URL: backendBase, PI_RESEARCH_AUTO_LOCAL: "false" });

		const commands = await client.rpc({ id: "commands-1", type: "get_commands" }, 15000);
		assert(commands.success === true, "get_commands should succeed");
		const command = (commands.data?.commands || []).find((item) => item.name === "web-research");
		assert(command, "installed package should register /web-research");
		console.log(`Installed command OK: /web-research (${command.path || "unknown path"})`);

		const statusEventStart = client.events.length;
		const statusResponse = await client.rpc({ id: "prompt-status", type: "prompt", message: "/web-research status" }, 15000);
		assert(statusResponse.success === true, "/web-research status should succeed");
		await sleep(250);
		const statusEvents = client.events.slice(statusEventStart);
		assert(statusEvents.some((item) => item.type === "extension_ui_request"), "status command should emit extension UI request in RPC mode");
		console.log("Command smoke OK: /web-research status");

		const cases = [];
		cases.push(await runPromptCase(
			client,
			"search_web",
			"Use the search_web tool exactly once for React caching best practices. Return only the top result title and URL.",
			"search_web",
			(finalText) => {
				assert(/React|react/i.test(finalText), `search_web: unexpected text ${finalText}`);
				assert(/https?:\/\//.test(finalText), `search_web: missing URL ${finalText}`);
			},
		));
		cases.push(await runPromptCase(
			client,
			"fetch_url",
			`Use the fetch_url tool exactly once on ${contentBase}/react-cache-official with docs profile. Return only the page title.`,
			"fetch_url",
			(finalText) => {
				assert(/Official React caching guidance/i.test(finalText), `fetch_url: unexpected text ${finalText}`);
			},
		));
		cases.push(await runPromptCase(
			client,
			"research_query",
			"You must use only the research_query tool exactly once in best-practice mode for React server caching best practices. Do not use search_web or fetch_url. Return exactly one bullet and one citation URL.",
			"research_query",
			(finalText) => {
				assert(/- /.test(finalText), `research_query: expected a bullet ${finalText}`);
				assert(/https?:\/\//.test(finalText), `research_query: missing citation URL ${finalText}`);
			},
		));

		console.log("\nNATIVE PACKAGE SMOKE PASS");
		for (const item of cases) {
			console.log(`- ${item.name}: tool=${item.caseTools.join(",")} | output=${item.finalText}`);
		}
	} finally {
		client?.close();
		contentServer.close();
		searchServer.close();
		if (backend && !backend.killed) backend.kill();
	}
}

main().catch((error) => {
	console.error("NATIVE PACKAGE SMOKE FAIL:", error);
	process.exit(1);
});
