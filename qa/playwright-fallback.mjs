import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const port = 8871;
const backendPort = 8872;
const pageUrl = `http://127.0.0.1:${port}/dynamic`;
const backendUrl = `http://127.0.0.1:${backendPort}`;

const server = http.createServer((req, res) => {
	if (req.url !== "/dynamic") {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
		return;
	}
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(`<!doctype html>
<html>
  <head><title>Dynamic page</title></head>
  <body>
    <div id="app">Loading…</div>
    <script>
      document.getElementById('app').textContent = 'Rendered content from JavaScript for Playwright fallback verification.';
    </script>
  </body>
</html>`);
});

function waitForServer(server, port) {
	return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function startBackend() {
	return spawn("node", [resolve(PROJECT_ROOT, "apps/research-backend/src/server.js")], {
		cwd: PROJECT_ROOT,
		env: {
			...process.env,
			PORT: String(backendPort),
			HOST: "127.0.0.1",
			PLAYWRIGHT_ENABLED: "true",
			BROWSER_MODE: "auto",
			ALLOW_PRIVATE_FETCH_HOSTS: "127.0.0.1,localhost",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
	for (let i = 0; i < 50; i++) {
		try {
			const res = await fetch(`${backendUrl}/health`);
			if (res.ok) return;
		} catch {}
		await sleep(200);
	}
	throw new Error("backend health timeout");
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function post(path, body) {
	const res = await fetch(`${backendUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = await res.json();
	if (!res.ok) throw new Error(JSON.stringify(json));
	return json;
}

async function main() {
	let backend;
	try {
		await waitForServer(server, port);
		backend = startBackend();
		await waitForHealth();

		const fast = await post("/v1/fetch", {
			url: pageUrl,
			mode: "fast",
			extractionProfile: "generic",
		});
		const rendered = await post("/v1/fetch", {
			url: pageUrl,
			mode: "rendered",
			extractionProfile: "generic",
		});

		assert(!String(fast.content).includes("Rendered content from JavaScript"), "fast mode should not rely on JS rendering");
		assert(String(rendered.content).includes("Rendered content from JavaScript for Playwright fallback verification."), "rendered mode should capture JS-rendered content");
		assert(rendered.fetchMode === "rendered", "rendered mode should report rendered fetch mode");

		console.log("QA PASS: Playwright fallback is working.");
	} finally {
		server.close();
		if (backend && !backend.killed) backend.kill();
	}
}

main().catch((error) => {
	console.error("QA FAIL:", error);
	process.exit(1);
});
