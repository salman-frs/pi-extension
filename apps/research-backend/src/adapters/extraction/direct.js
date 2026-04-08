import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractCanonicalUrl, extractMarkdownTitle, extractTitle, htmlToText, markdownToText } from "../../lib/text.js";

export async function fetchDirect(config, url, extractionProfile, fetchWithTimeout, signal) {
	assertSafeOutboundUrl(url, config);
	const candidates = buildFetchCandidates(url, extractionProfile, config);
	let lastError;
	for (const candidate of candidates) {
		try {
			const response = await fetchWithTimeout(
				candidate.url,
				{
					method: "GET",
					headers: {
						"user-agent": config.userAgent,
						accept: candidate.accept,
					},
				},
				config.requestTimeoutMs,
				signal,
			);
			if (!response.ok) {
				lastError = new Error(`Direct fetch failed: HTTP ${response.status}`);
				continue;
			}
			const contentType = response.headers.get("content-type") ?? undefined;
			const body = await response.text();
			const markdown = looksLikeMarkdownContent(contentType, body) ? body : undefined;
			const html = !markdown && isHtml(contentType, body) ? body : undefined;
			const text = markdown ? markdownToText(markdown) : html ? htmlToText(html) : body.trim();
			return {
				url,
				resolvedUrl: response.url || candidate.url,
				canonicalUrl: html ? extractCanonicalUrl(html) ?? url : response.url || candidate.url || url,
				title: markdown ? extractMarkdownTitle(markdown) : html ? extractTitle(html) : undefined,
				html,
				markdown,
				text,
				contentType,
				status: response.status,
				variant: candidate.variant,
			};
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Direct fetch failed");
}

function buildFetchCandidates(url, extractionProfile, config) {
	const baseAccept = "text/html, text/plain, application/xhtml+xml;q=0.9, */*;q=0.8";
	const candidates = [{ url, accept: baseAccept, variant: "html" }];
	if (!["docs", "release-note", "generic"].includes(String(extractionProfile || ""))) return candidates;
	const rules = loadDocsFetchRules(config?.docsFetchRulesPath);
	const matchedRule = matchDocsFetchRule(url, rules);
	if (!matchedRule) return candidates;
	const parsed = new URL(url);
	const preferred = [];
	for (const suffix of matchedRule.pathSuffixCandidates || []) {
		preferred.push({
			url: joinDocCandidate(parsed, suffix),
			accept: matchedRule.accept || "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.5",
			variant: "docs-markdown",
		});
	}
	for (const rootPath of matchedRule.rootCandidates || []) {
		preferred.push({
			url: `${parsed.origin}${rootPath}`,
			accept: matchedRule.accept || "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.5",
			variant: "docs-markdown-root",
		});
	}
	return dedupeCandidates([...preferred, ...candidates]);
}

function joinDocCandidate(parsedUrl, suffix) {
	const suffixValue = String(suffix || "").replace(/^\/+/, "");
	const normalizedPath = parsedUrl.pathname.endsWith("/") ? parsedUrl.pathname : `${parsedUrl.pathname}/`;
	return `${parsedUrl.origin}${normalizedPath}${suffixValue}`;
}

function dedupeCandidates(candidates) {
	const seen = new Set();
	const output = [];
	for (const item of candidates) {
		if (!item?.url || seen.has(item.url)) continue;
		seen.add(item.url);
		output.push(item);
	}
	return output;
}

function loadDocsFetchRules(pathOverride) {
	try {
		const resolvedPath = pathOverride
			? resolve(process.cwd(), pathOverride)
			: resolve(import.meta.dirname, "../../../config/docs-fetch-rules.json");
		const parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
		return Array.isArray(parsed?.rules) ? parsed.rules : [];
	} catch {
		return [];
	}
}

function matchDocsFetchRule(url, rules) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const host = (parsed.hostname || "").toLowerCase();
	return (rules || []).find((rule) => {
		const domain = String(rule?.domain || "").toLowerCase();
		return domain && (host === domain || host.endsWith(`.${domain}`));
		});
}

function looksLikeMarkdownContent(contentType, body) {
	if (contentType?.includes("markdown") || contentType?.includes("text/plain")) return true;
	const sample = String(body || "").trimStart();
	return /^---\n[\s\S]{0,300}?\n---\n/m.test(sample) || /^#\s+/m.test(sample) || /\[[^\]]+\]\([^)]+\)/.test(sample);
}

function isHtml(contentType, body) {
	return (contentType?.includes("html") ?? false) || /<html|<body|<article|<main/i.test(body);
}

export function assertSafeOutboundUrl(url, config = {}) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Invalid URL");
	}
	if (!["http:", "https:"].includes(parsed.protocol)) {
		throw new Error("Only http and https URLs are allowed");
	}
	const host = (parsed.hostname || "").toLowerCase();
	const allowlist = Array.isArray(config.allowPrivateFetchHosts) ? config.allowPrivateFetchHosts : [];
	if (allowlist.includes(host)) return;
	if (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host.startsWith("10.") ||
		host.startsWith("192.168.") ||
		/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
	) {
		throw new Error("Outbound fetch to local/private addresses is blocked");
	}
}
