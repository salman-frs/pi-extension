import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractCanonicalUrl, extractMarkdownTitle, extractTitle, htmlToText, markdownToText } from "../../lib/text.js";
import { normalizeComparableUrl, trim, versionHintFromUrl } from "../../lib/utils.js";
import { extractStructuredContent } from "./structured.js";

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
			const structured = html && config.structuredExtractionEnabled
				? extractStructuredContent(html, { url: response.url || candidate.url, extractionProfile, variant: candidate.variant })
				: undefined;
			const text = markdown
				? markdownToText(markdown)
				: structured?.content || (html ? htmlToText(html) : body.trim());
			const title = markdown ? extractMarkdownTitle(markdown) : html ? extractTitle(html) : undefined;
			if (looksLikeErrorDocument({ status: response.status, title, text, variant: candidate.variant })) {
				lastError = new Error(`Direct fetch candidate was not usable: ${candidate.url}`);
				continue;
			}
			const canonicalUrl = canonicalizeFetchedUrl({
				url,
				resolvedUrl: response.url || candidate.url,
				html,
				variant: candidate.variant,
			});
			return {
				url,
				resolvedUrl: response.url || candidate.url,
				canonicalUrl,
				title,
				html,
				markdown,
				text,
				contentType,
				status: response.status,
				variant: candidate.variant,
				metadata: {
					strategy: markdown
						? candidate.variant?.startsWith("docs-markdown") ? "docs-markdown-fetch" : "markdown-fetch"
						: structured ? "structured-html-extractor" : "direct-fetch",
					frameworkHints: structured?.frameworkHints || [],
					extractionConfidence: markdown ? "high" : structured?.diagnostics?.extractionConfidence || inferDirectExtractionConfidence(text),
					shellLikelihood: markdown ? 0 : structured?.diagnostics?.shellLikelihood,
					versionHint: versionHintFromUrl(response.url || candidate.url),
					diagnostics: structured?.diagnostics,
				},
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
	const parsed = safeUrl(url);
	if (!parsed) return candidates;
	const rules = loadDocsFetchRules(config?.docsFetchRulesPath);
	const matchedRule = matchDocsFetchRule(url, rules);
	const heuristicCandidates = buildHeuristicDocsCandidates(parsed);
	const preferred = [];
	for (const suffix of matchedRule?.pathSuffixCandidates || []) {
		preferred.push({
			url: joinDocCandidate(parsed, suffix),
			accept: matchedRule?.accept || docsAcceptHeader(),
			variant: "docs-markdown",
		});
	}
	for (const rootPath of matchedRule?.rootCandidates || []) {
		preferred.push({
			url: `${parsed.origin}${rootPath}`,
			accept: matchedRule?.accept || docsAcceptHeader(),
			variant: "docs-markdown-root",
		});
	}
	for (const item of heuristicCandidates) preferred.push(item);
	return dedupeCandidates([...preferred, ...candidates]);
}

function buildHeuristicDocsCandidates(parsed) {
	if (!looksDocsLike(parsed)) return [];
	const accept = docsAcceptHeader();
	const candidates = [];
	const pathWithoutSlash = parsed.pathname.replace(/\/+$/, "") || "/";
	const trailingPath = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
	for (const suffix of ["llms-full.txt", "llms.txt", "index.md"]) {
		candidates.push({
			url: `${parsed.origin}${trailingPath}${suffix}`.replace(/([^:]\/)\/+/g, "$1"),
			accept,
			variant: "docs-heuristic-markdown",
		});
	}
	for (const suffix of [".md", "/index.md"]) {
		const normalizedPath = suffix === ".md" ? `${pathWithoutSlash}.md` : `${pathWithoutSlash}${suffix}`;
		candidates.push({
			url: `${parsed.origin}${normalizedPath}`.replace(/([^:]\/)\/+/g, "$1"),
			accept,
			variant: "docs-heuristic-markdown",
		});
	}
	for (const rootPath of ["/llms-full.txt", "/llms.txt"]) {
		candidates.push({ url: `${parsed.origin}${rootPath}`, accept, variant: "docs-heuristic-root" });
	}
	return candidates;
}

function docsAcceptHeader() {
	return "text/markdown, text/plain;q=0.95, text/html;q=0.85, application/xhtml+xml;q=0.8, */*;q=0.5";
}

function looksDocsLike(parsed) {
	const host = String(parsed?.hostname || "").toLowerCase();
	const path = String(parsed?.pathname || "").toLowerCase();
	return host.startsWith("docs.")
		|| host.startsWith("developers.")
		|| host.startsWith("developer.")
		|| /\/docs\/|\/guide\/|\/guides\/|\/reference\/|\/api\//.test(path)
		|| /documentation|reference|quickstart|getting-started|guides?/.test(path);
}

function safeUrl(value) {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
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
		const normalized = trim(item?.url);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
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
		const parsed = safeUrl(url);
		if (!parsed) return undefined;
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

function canonicalizeFetchedUrl({ url, resolvedUrl, html, variant }) {
	const rawCanonical = html ? extractCanonicalUrl(html) : undefined;
	const candidate = rawCanonical || resolvedUrl || url;
	const normalized = normalizeComparableUrl(candidate);
	if (normalized) return normalized;
	if (/docs-/.test(String(variant || ""))) {
		return normalizeComparableUrl(url) || candidate;
	}
	return candidate;
}

function inferDirectExtractionConfidence(text) {
	const length = String(text || "").length;
	if (length >= 1200) return "high";
	if (length >= 300) return "medium";
	return "low";
}

function looksLikeErrorDocument({ status, title, text, variant }) {
	if (status >= 400) return true;
	const combined = `${String(title || "")} ${String(text || "").slice(0, 300)}`.toLowerCase();
	if (!/docs|markdown|heuristic/i.test(String(variant || ""))) return false;
	return /page not found|404|not found|document not found|requested page could not be found/.test(combined);
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
