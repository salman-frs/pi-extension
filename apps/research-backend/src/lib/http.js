import { ResearchError, errorPayload } from "../errors.js";

export function json(res, status, body, headers = {}) {
	const payload = JSON.stringify(body, null, 2);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "content-type, authorization",
		...headers,
	});
	res.end(payload);
}

export async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (!raw) return {};
	return JSON.parse(raw);
}

export function notFound(res, headers) {
	json(res, 404, { error: "Not found" }, headers);
}

export function methodNotAllowed(res, allowed = ["GET", "POST", "OPTIONS"], headers) {
	json(res, 405, { error: `Method not allowed. Allowed: ${allowed.join(", ")}` }, headers);
}

export function unauthorized(res, headers) {
	json(res, 401, { error: "Unauthorized" }, headers);
}

export function errorResponse(res, error, headers) {
	const status = error instanceof ResearchError ? error.status : error instanceof SyntaxError ? 400 : 500;
	json(res, status, errorPayload(error), headers);
}
