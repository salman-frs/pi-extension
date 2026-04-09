import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ageInDays, hostnameFromUrl, normalizeDomain, versionHintFromUrl } from "./lib/utils.js";

const rulesPath = process.env.SOURCE_QUALITY_RULES_PATH
	? resolve(process.cwd(), process.env.SOURCE_QUALITY_RULES_PATH)
	: resolve(import.meta.dirname, "../config/source-quality-rules.json");
const rules = JSON.parse(readFileSync(rulesPath, "utf8"));

const DOC_HOST_HINTS = rules.officialDocsDomains || [];
const MAJOR_MEDIA_DOMAINS = rules.majorMediaDomains || [];
const WIRE_SERVICE_DOMAINS = rules.wireServiceDomains || [];
const MAINSTREAM_MEDIA_DOMAINS = rules.mainstreamMediaDomains || [];
const FORUM_DOMAINS = rules.forumDomains || [];
const SURVEY_DOMAINS = rules.surveyDomains || [];
const AGGREGATOR_DOMAINS = rules.aggregatorDomains || [];

export function inferSourceType(url, fallback = "general") {
	const host = hostnameFromUrl(url) ?? "";
	const value = String(url || "").toLowerCase();
	if (host.includes("github.com")) return "github";
	if (MAJOR_MEDIA_DOMAINS.some((domain) => domainMatchesHost(host, domain))) return "news";
	if (
		host.includes("docs.") ||
		DOC_HOST_HINTS.some((domain) => domainMatchesHost(host, domain)) ||
		/\/docs\/|\/reference\/|\/guide\//.test(value)
	) return "docs";
	return fallback;
}

export function classifySourceCategory(input) {
	const url = String(input?.url || "");
	const title = String(input?.title || "");
	const host = normalizeDomain(input?.domain || hostnameFromUrl(url)) || "";
	const lowerUrl = url.toLowerCase();
	const lowerTitle = title.toLowerCase();
	const sourceType = input?.sourceType || inferSourceType(url);

	if (host.includes("github.com")) {
		if (lowerUrl.includes("/pull/")) return "github-pr";
		if (lowerUrl.includes("/issues/")) return "github-issue";
		if (lowerUrl.includes("/discussions/")) return "github-discussion";
		if (lowerUrl.includes("/releases/") || lowerUrl.endsWith("/releases") || /\brelease\b|\bchangelog\b/.test(lowerTitle)) return "release-notes";
		return "github-repo";
	}

	if (SURVEY_DOMAINS.some((domain) => domainMatchesHost(host, domain))) return "survey-organization";
	if (WIRE_SERVICE_DOMAINS.some((domain) => domainMatchesHost(host, domain))) return "wire-service";
	if (MAINSTREAM_MEDIA_DOMAINS.some((domain) => domainMatchesHost(host, domain))) return "mainstream-media";
	if (AGGREGATOR_DOMAINS.some((domain) => domainMatchesHost(host, domain))) return "aggregator-republisher";

	if (sourceType === "docs" || looksLikeOfficialDocs(host, lowerUrl, lowerTitle)) {
		if (looksLikeReleaseNotes(lowerUrl, lowerTitle)) return "release-notes";
		return "official-docs";
	}
	if (["npmjs.com", "pypi.org", "crates.io", "hex.pm", "pkg.go.dev", "search.maven.org", "central.sonatype.com"].some((domain) => domainMatchesHost(host, domain))) {
		return "official-docs";
	}

	if (host.endsWith(".go.id") || host.endsWith(".gov") || host.endsWith(".gov.uk")) return "official-government";
	if (looksLikeReleaseNotes(lowerUrl, lowerTitle)) return "release-notes";
	if (MAJOR_MEDIA_DOMAINS.some((domain) => domainMatchesHost(host, domain))) return "major-media";
	if (FORUM_DOMAINS.some((domain) => domainMatchesHost(host, domain)) || host.startsWith("community.") || /\bcommunity\b|\bdiscussion\b|\bforum\b/.test(lowerTitle)) return "forum-community";
	if (looksLikeVendorBlog(host, lowerUrl)) return "vendor-blog";
	if (looksLikeTechBlog(host, lowerUrl)) return "secondary-tech-blog";
	return "unknown-low-trust";
}

export function authorityWeight(category) {
	switch (category) {
		case "official-docs":
			return 16;
		case "official-government":
			return 18;
		case "release-notes":
			return 14;
		case "survey-organization":
			return 14;
		case "wire-service":
			return 14;
		case "mainstream-media":
			return 12;
		case "aggregator-republisher":
			return -8;
		case "github-pr":
		case "github-issue":
		case "github-discussion":
			return 8;
		case "github-repo":
			return 6;
		case "major-media":
			return 10;
		case "vendor-blog":
			return 8;
		case "secondary-tech-blog":
			return 5;
		case "forum-community":
			return 2;
		default:
			return 0;
	}
}

export function classifyResultType(input) {
	const url = String(input?.url || "").toLowerCase();
	const title = String(input?.title || "").toLowerCase();
	const combined = `${url} ${title}`;
	if (url.includes("github.com/")) {
		if (url.includes("/pull/")) return "github-pr";
		if (url.includes("/issues/")) return "github-issue";
		if (url.includes("/discussions/")) return "github-discussion";
		if (url.endsWith("/releases") || url.includes("/releases/")) return "github-releases";
		if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url)) return "repository-home";
		return "repository-page";
	}
	if (url.endsWith(".pdf")) return "pdf";
	if (/upgrade|migrate|migration/.test(combined)) return "migration-guide";
	if (/release|changelog|release-notes|whats-new|what-s-new/.test(combined)) return "release-notes";
	if (/troubleshoot|troubleshooting|faq|common issues|known issues|error/.test(combined)) return "troubleshooting";
	if (/npmjs\.com\/package|pypi\.org\/project|crates\.io\/crates|hex\.pm\/packages|pkg\.go\.dev|search\.maven\.org|central\.sonatype\.com/.test(url)) return "package-registry";
	if (/docs\.rs|hexdocs\.pm|readthedocs\.io|javadoc\.io/.test(url)) return "package-docs";
	if (/next\.config|config|configuration|options?|settings?|proxyclientmaxbodysize|middlewareclientmaxbodysize|bodysizelimit|maxbody/.test(combined)) return "configuration-reference";
	if (/reference|api|sdk|hook|hooks/.test(combined)) return "api-reference";
	if (/getting-started|quickstart|introduction|intro|installation|install/.test(combined)) return "getting-started";
	if (/launch|announcement|introducing|what.?s new/.test(combined)) return "announcement";
	if (/example|examples|sample/.test(combined)) return "examples";
	if (/prescriptive guidance|architecture|architectures|trade-offs|tradeoffs|compare|versus| vs /.test(combined)) return "architecture-guide";
	if (/guide/.test(combined)) return "guide";
	return undefined;
}

export function resultTypeWeight(resultType, queryMode = "general") {
	if (!resultType) return 0;
	const table = {
		github: {
			"github-issue": 18,
			"github-discussion": 14,
			"github-releases": 16,
			"repository-home": 10,
			"github-pr": 12,
		},
		repo: {
			"repository-home": 24,
			"repository-page": 10,
			"github-releases": 8,
			"github-issue": -8,
			"github-discussion": -6,
			"github-pr": -6,
		},
		release: {
			"github-releases": 20,
			"release-notes": 18,
			"repository-home": 8,
			"github-issue": 2,
		},
		migration: {
			"migration-guide": 22,
			"release-notes": 18,
			"github-releases": 16,
			"package-docs": 18,
			"package-registry": 12,
			"repository-home": 8,
			"github-issue": 6,
			troubleshooting: 6,
		},
		bugfix: {
			"github-issue": 18,
			"github-discussion": 14,
			troubleshooting: 14,
			"api-reference": 12,
			"configuration-reference": 12,
			"package-docs": 12,
			"package-registry": 8,
			examples: 8,
		},
		config: {
			"configuration-reference": 22,
			"api-reference": 16,
			"package-docs": 14,
			troubleshooting: 8,
			guide: 4,
			"getting-started": -4,
		},
		api: {
			"api-reference": 20,
			"configuration-reference": 16,
			"package-docs": 16,
			troubleshooting: 8,
			examples: 8,
			guide: 4,
		},
		"technical-change": {
			"migration-guide": 18,
			"release-notes": 16,
			"github-releases": 14,
			"package-docs": 16,
			"package-registry": 10,
			"github-issue": 10,
			troubleshooting: 8,
		},
		architecture: {
			"architecture-guide": 18,
			guide: 8,
			"package-docs": 8,
			pdf: -10,
		},
		"novel-discovery": {
			"repository-home": 18,
			"github-releases": 16,
			"release-notes": 16,
			"getting-started": 14,
			announcement: 12,
			guide: 8,
			"api-reference": 8,
		},
		docs: {
			"configuration-reference": 16,
			"api-reference": 14,
			"getting-started": 8,
			guide: 8,
			"migration-guide": 8,
		},
		general: {
			"release-notes": 6,
			"api-reference": 4,
			"configuration-reference": 4,
			pdf: -4,
		},
	};
	return table[queryMode]?.[resultType] ?? table.general[resultType] ?? 0;
}

export function canonicalHintScore(input, queryMode = "general", constraintProfile) {
	const url = String(input?.url || "").toLowerCase();
	const title = String(input?.title || "").toLowerCase();
	const host = normalizeDomain(input?.domain || hostnameFromUrl(input?.url || "")) || "";
	let score = 0;
	if (queryMode === "technical-change" || queryMode === "migration") {
		if (/upgrade|migration|release-notes|whats-new|changelog/.test(`${url} ${title}`)) score += 10;
		if (/hexdocs\.pm|pypi\.org|docs\.rs|pkg\.go\.dev|javadoc\.io/.test(url)) score += 6;
	}
	if (queryMode === "docs" && /getting-started|quickstart|introduction|install/.test(`${url} ${title}`)) score += 8;
	if (queryMode === "architecture" && /prescriptive-guidance|best-practices|architecture|trade-offs|tradeoffs/.test(`${url} ${title}`)) score += 10;
	if (/\/service\/|\/guide\//.test(url) && queryMode === "architecture") score += 4;
	if (queryMode === "novel-discovery" && /getting-started|quickstart|introducing|announcement|release|launch|agent|mcp/.test(`${url} ${title}`)) score += 10;
	if (queryMode === "repo" && host === "github.com" && /^https?:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url)) score += 16;
	if (queryMode === "release" && /github\.com\/[^/]+\/[^/]+\/releases/.test(url)) score += 14;
	if (queryMode === "config" && /config|configuration|options?|proxyclientmaxbodysize|middlewareclientmaxbodysize|bodysizelimit|maxbody/.test(`${url} ${title}`)) score += 14;
	if (queryMode === "api" && /reference|api|hooks?|function/.test(`${url} ${title}`)) score += 12;
	if (["migration", "technical-change", "api", "config", "bugfix"].includes(queryMode) && /hexdocs\.pm|pypi\.org|docs\.rs|pkg\.go\.dev|javadoc\.io|npmjs\.com\/package/.test(url)) score += 8;
	if (constraintProfile?.requiresOfficialSource && ["official-docs", "release-notes", "github-repo"].includes(input?.sourceCategory)) score += 4;
	return score;
}

export function buildTrustSignals(input = {}) {
	const sourceCategory = input.sourceCategory || classifySourceCategory(input);
	const authorityScore = normalizeAuthorityScore(authorityWeight(sourceCategory));
	const authority = authorityLevel(authorityScore);
	const ageDays = ageInDays(input.publishedAt);
	const official = ["official-docs", "official-government", "release-notes", "github-repo"].includes(sourceCategory);
	const freshness = classifyFreshness(ageDays);
	const likelyOutdated = Boolean(ageDays != null && ageDays > 365 && ["official-docs", "release-notes", "github-repo", "vendor-blog", "secondary-tech-blog"].includes(sourceCategory));
	const versionHint = versionHintFromUrl(input.url);
	return {
		authority,
		authorityScore,
		official,
		community: ["forum-community", "secondary-tech-blog", "github-issue", "github-discussion"].includes(sourceCategory),
		freshness,
		ageDays,
		likelyOutdated,
		versionHint,
	};
}

export function isAuthoritativeCategory(category) {
	return [
		"official-docs",
		"official-government",
		"release-notes",
		"survey-organization",
		"wire-service",
		"mainstream-media",
		"major-media",
		"github-pr",
		"github-issue",
		"github-discussion",
		"github-repo",
	].includes(category);
}

function normalizeAuthorityScore(weight) {
	return Math.max(0, Math.min(100, 50 + Number(weight || 0) * 2));
}

function authorityLevel(score) {
	if (score >= 80) return "high";
	if (score >= 60) return "medium";
	return "low";
}

function classifyFreshness(ageDays) {
	if (ageDays == null) return "unknown";
	if (ageDays <= 30) return "fresh";
	if (ageDays <= 180) return "recent";
	if (ageDays <= 365) return "aging";
	return "stale";
}

function looksLikeOfficialDocs(host, lowerUrl, lowerTitle) {
	if (DOC_HOST_HINTS.some((domain) => domainMatchesHost(host, domain))) return true;
	return /\bdocs\b|\breference\b|\bguide\b|\bofficial\b/.test(`${lowerTitle} ${lowerUrl}`);
}

function looksLikeReleaseNotes(lowerUrl, lowerTitle) {
	return /release|changelog|release-notes|whats-new|what-s-new/.test(`${lowerTitle} ${lowerUrl}`);
}

function looksLikeVendorBlog(host, lowerUrl) {
	if (!host) return false;
	if (host.startsWith("blog.")) return true;
	return /\/blog\//.test(lowerUrl) && !MAJOR_MEDIA_DOMAINS.some((domain) => domainMatchesHost(host, domain));
}

function looksLikeTechBlog(host, lowerUrl) {
	if (!host) return false;
	if (/medium\.com$|substack\.com$|hashnode\.dev$|dev\.to$/.test(host)) return true;
	return /\/blog\//.test(lowerUrl);
}

function domainMatchesHost(host, domain) {
	const normalizedHost = normalizeDomain(host);
	const normalizedDomain = normalizeDomain(domain);
	if (!normalizedHost || !normalizedDomain) return false;
	return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}
