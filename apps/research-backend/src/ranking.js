import { comparableUrlKey, domainMatches, hostnameFromUrl, normalizeDomain, unique } from "./lib/utils.js";
import { authorityWeight, buildTrustSignals, canonicalHintScore, classifyResultType, classifySourceCategory, inferSourceType, isAuthoritativeCategory, resultTypeWeight } from "./source-quality.js";

const HIGH_TRUST_SUFFIXES = [
	"gov",
	"edu",
	"wikipedia.org",
	"mozilla.org",
	"openai.com",
	"anthropic.com",
	"nodejs.org",
	"python.org",
	"react.dev",
	"nextjs.org",
	"vercel.com",
	"developer.mozilla.org",
	"web.dev",
	"npmjs.com",
	"pypi.org",
	"docs.rs",
	"crates.io",
	"hexdocs.pm",
	"hex.pm",
	"pkg.go.dev",
	"go.dev",
	"search.maven.org",
	"central.sonatype.com",
	"javadoc.io",
];

export function rankSearchResults(results, params) {
	const preferredDomains = (params.preferredDomains || []).map(normalizeDomain).filter(Boolean);
	const blockedDomains = (params.blockedDomains || []).map(normalizeDomain).filter(Boolean);
	const queryTokens = tokenize(params.query);
	const constraintProfile = params.constraintProfile;

	let filtered = results.filter((result) => {
		const domain = normalizeDomain(result.domain ?? hostnameFromUrl(result.url));
		if (!domain) return true;
		if (constraintProfile?.explicitSites?.length) {
			return constraintProfile.explicitSites.some((site) => domainMatches(domain, site));
		}
		return !blockedDomains.some((blocked) => domainMatches(domain, blocked));
	});

	filtered = filtered.map((result) => scoreResult(result, {
		queryTokens,
		preferredDomains,
		freshness: params.freshness,
		sourceTypePreference: params.sourceType,
		constraintProfile,
	}));

	return enforcePreferredDomainPrecision(filtered
		.sort((a, b) => (b.score || 0) - (a.score || 0)), contextFromParams(params))
		.filter((item, index, arr) => arr.findIndex((other) => resultIdentity(other) === resultIdentity(item)) === index);
}

export function rankFetchedSources(sources, question, preferredDomains = [], constraintProfile) {
	const queryTokens = tokenize(question);
	const preferred = preferredDomains.map(normalizeDomain).filter(Boolean);
	return sources
		.map((source) => scoreResult(source, {
			queryTokens,
			preferredDomains: preferred,
			freshness: "month",
			sourceTypePreference: undefined,
			constraintProfile,
		}))
		.sort((a, b) => (b.score || 0) - (a.score || 0))
		.filter((item, index, arr) => arr.findIndex((other) => resultIdentity(other) === resultIdentity(item)) === index);
}

export function summarizeSourceTypes(sources) {
	return unique(sources.map((source) => source.sourceType).filter(Boolean));
}

export function summarizeSourceCategories(sources) {
	return unique(sources.map((source) => source.sourceCategory).filter(Boolean));
}

export function detectDisagreementSignals(sources) {
	const signals = [];
	const domains = unique(sources.map((source) => normalizeDomain(source.domain)).filter(Boolean));
	const categories = summarizeSourceCategories(sources);
	if (domains.length >= 3) signals.push("Evidence comes from multiple domains, reducing single-source bias.");
	if (categories.includes("official-docs") && categories.some((item) => ["secondary-tech-blog", "forum-community", "vendor-blog"].includes(item))) {
		signals.push("Official/vendor materials and community commentary are both present, so emphasis may differ across sources.");
	}
	const dated = sources.filter((source) => source.publishedAt).length;
	if (dated >= 2) signals.push("Multiple dated sources were retrieved, which helps compare recency and changes in emphasis.");
	return signals;
}

function scoreResult(result, context) {
	const domain = normalizeDomain(result.domain ?? hostnameFromUrl(result.url));
	const sourceType = result.sourceType || inferSourceType(result.url, "general");
	const sourceCategory = result.sourceCategory || classifySourceCategory({ ...result, domain, sourceType });
	const resultType = result.resultType || classifyResultType({ ...result, domain, sourceType, sourceCategory });
	const contributions = [];
	const queryMode = context.constraintProfile?.queryMode || (context.sourceTypePreference === "github" ? "github" : context.sourceTypePreference === "docs" ? "docs" : "general");

	const preferredMatch = context.preferredDomains.some((preferred) => domainMatches(domain, preferred));
	const explicitSiteMatch = context.constraintProfile?.explicitSites?.some((site) => domainMatches(domain, site));
	if (explicitSiteMatch) {
		contributions.push([60, "explicit-site-match"]);
	} else if (context.constraintProfile?.explicitSites?.length) {
		contributions.push([-30, "explicit-site-miss"]);
	}
	if (preferredMatch) {
		contributions.push([context.sourceTypePreference === "docs" ? 52 : 40, "preferred-domain"]);
	} else if (context.preferredDomains.length > 0) {
		const penalty = context.constraintProfile?.strictPreferredDomains
			? -28
			: context.sourceTypePreference === "docs" || context.constraintProfile?.requiresOfficialSource
				? -18
				: -8;
		contributions.push([penalty, "non-preferred-domain-penalty"]);
	}
	if (isHighTrust(domain)) contributions.push([12, "high-trust-domain"]);
	if (sourceType === context.sourceTypePreference && context.sourceTypePreference && context.sourceTypePreference !== "general") {
		contributions.push([8, `source-type:${sourceType}`]);
	}
	if (sourceType === "docs") contributions.push([context.sourceTypePreference === "docs" ? 16 : 10, "docs-source"]);
	if (sourceType === "github") contributions.push([context.sourceTypePreference === "github" || ["repo", "release", "novel-discovery"].includes(queryMode) ? 6 : -8, "github-source"]);
	if (looksLikeRepoBlob(result)) contributions.push([context.sourceTypePreference === "github" ? 0 : -10, "github-blob-penalty"]);

	const authority = authorityWeight(sourceCategory);
	if (authority) contributions.push([authority, `category:${sourceCategory}`]);
	const resultTypeScore = resultTypeWeight(resultType, queryMode);
	if (resultTypeScore) contributions.push([resultTypeScore, `result-type:${resultType}`]);
	const canonicalScore = canonicalHintScore(result, queryMode, context.constraintProfile);
	if (canonicalScore) contributions.push([canonicalScore, "canonical-hint"]);
	const exactScore = exactTermScore(result, context.constraintProfile?.exactTerms || [], queryMode);
	if (exactScore) contributions.push([exactScore, "exact-term-match"]);
	const repoCandidateScoreValue = repoCandidateScore(result, context.constraintProfile?.repoCandidates || [], queryMode);
	if (repoCandidateScoreValue) contributions.push([repoCandidateScoreValue, "repo-candidate-match"]);
	const officialScore = officialIntentScore(result, context.constraintProfile, preferredMatch);
	if (officialScore) contributions.push([officialScore, "official-intent"]);
	const canonicalPreference = canonicalPreferenceScore(result, context.constraintProfile, queryMode);
	if (canonicalPreference) contributions.push([canonicalPreference, "canonical-preference"]);
	if (result.publishedAt) {
		const freshness = freshnessScore(result.publishedAt, context.freshness);
		if (freshness) contributions.push([freshness, "freshness"]);
	}
	const relevance = relevanceScore(result, context.queryTokens);
	if (relevance) contributions.push([relevance, "query-relevance"]);
	if ((result.excerpt || "").length > 200) contributions.push([5, "rich-excerpt"]);
	if (isAuthoritativeCategory(sourceCategory) && context.sourceTypePreference === "docs") contributions.push([10, "authoritative-for-docs-query"]);
	if (context.sourceTypePreference === "news" && ["wire-service", "mainstream-media", "major-media", "survey-organization", "official-government"].includes(sourceCategory)) {
		contributions.push([6, "authoritative-for-news-query"]);
	}
	applyConstraintFidelity(contributions, result, context.constraintProfile, queryMode);

	const score = contributions.reduce((sum, [value]) => sum + value, 0);
	const normalizedContributions = contributions.filter(([value]) => value !== 0);
	return {
		...result,
		domain,
		sourceType,
		sourceCategory,
		resultType,
		score,
		trustSignals: {
			...buildTrustSignals({ ...result, domain, sourceType, sourceCategory }),
			extractionConfidence: result.trustSignals?.extractionConfidence,
		},
		ranking: {
			reasons: normalizedContributions.map(([value, reason]) => `${reason}:${value > 0 ? "+" : ""}${value}`),
			contributions: Object.fromEntries(contributions.map(([value, reason]) => [reason, value])),
			topReason: normalizedContributions[0]?.[1],
			explanation: buildRankingExplanation(result, normalizedContributions, { domain, sourceCategory, resultType }),
		},
	};
}

function exactTermScore(result, exactTerms, queryMode) {
	if (!exactTerms.length) return 0;
	const title = compact(result.title);
	const url = compact(result.url);
	const snippet = compact(result.snippet);
	const excerpt = compact(result.excerpt);
	let score = 0;
	let matched = 0;
	for (const term of exactTerms) {
		const normalized = compact(term);
		if (!normalized) continue;
		if (title.includes(normalized) || url.includes(normalized)) {
			score += ["config", "api", "bugfix", "repo", "release", "migration"].includes(queryMode) ? 22 : 14;
			matched += 1;
			continue;
		}
		if (snippet.includes(normalized) || excerpt.includes(normalized)) {
			score += ["config", "api", "bugfix"].includes(queryMode) ? 10 : 6;
			matched += 1;
		}
	}
	if (matched === 0 && ["config", "api", "bugfix", "repo", "release", "migration"].includes(queryMode)) return -14;
	return Math.min(score, 36);
}

function repoCandidateScore(result, repoCandidates, queryMode) {
	if (!repoCandidates?.length || queryMode !== "repo") return 0;
	const url = String(result.url || "").toLowerCase();
	const title = String(result.title || "").toLowerCase();
	for (const candidate of repoCandidates) {
		const normalized = String(candidate).toLowerCase();
		if (normalized.includes("/")) {
			const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (new RegExp(`github\\.com/${escaped}(?:[/?#]|$)`, "i").test(url)) {
				return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/?$/i.test(result.url || "") ? 32 : 18;
			}
		}
		if (title.includes(normalized) || url.includes(normalized.replace(/\s+/g, "-"))) return 16;
	}
	return -6;
}

function officialIntentScore(result, constraintProfile, preferredMatch) {
	if (!constraintProfile?.requiresOfficialSource) return 0;
	if (["official-docs", "release-notes", "official-government", "github-repo"].includes(result.sourceCategory)) return preferredMatch ? 12 : 8;
	if (["forum-community", "secondary-tech-blog", "unknown-low-trust", "aggregator-republisher"].includes(result.sourceCategory)) return -8;
	return 0;
}

function canonicalPreferenceScore(result, constraintProfile, queryMode) {
	const preference = constraintProfile?.canonicalPreference || queryMode;
	if (!preference) return 0;
	const resultType = result.resultType || classifyResultType(result);
	if (preference === "repo") {
		if (resultType === "repository-home") return 20;
		if (["github-issue", "github-discussion", "github-pr"].includes(resultType)) return -12;
	}
	if (preference === "release") {
		if (["github-releases", "release-notes"].includes(resultType)) return 18;
		if (resultType === "repository-home") return 6;
	}
	if (preference === "migration") {
		if (resultType === "migration-guide") return 20;
		if (["release-notes", "github-releases"].includes(resultType)) return 14;
	}
	if (preference === "config") {
		if (resultType === "configuration-reference") return 20;
		if (resultType === "api-reference") return 8;
		if (resultType === "getting-started") return -10;
	}
	if (preference === "api") {
		if (resultType === "api-reference") return 18;
		if (resultType === "configuration-reference") return 10;
		if (resultType === "getting-started") return -8;
	}
	if (preference === "architecture") {
		if (resultType === "architecture-guide") return 18;
	}
	if (preference === "novel-discovery") {
		if (["repository-home", "github-releases", "release-notes", "getting-started", "announcement"].includes(resultType)) return 14;
	}
	if (preference === "bugfix") {
		if (["troubleshooting", "github-issue", "github-discussion", "api-reference", "configuration-reference"].includes(resultType)) return 10;
	}
	return 0;
}

function relevanceScore(result, queryTokens) {
	const haystack = [result.title, result.snippet, result.excerpt].filter(Boolean).join(" ").toLowerCase();
	let score = 0;
	for (const token of queryTokens) {
		if (haystack.includes(token)) score += 2;
	}
	return score;
}

function tokenize(text) {
	return (text || "")
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 3);
}

function compact(text) {
	return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isHighTrust(domain) {
	if (!domain) return false;
	return HIGH_TRUST_SUFFIXES.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`));
}

function looksLikeRepoBlob(result) {
	const url = (result.url || "").toLowerCase();
	return url.includes("github.com/") && (url.includes("/blob/") || url.includes("/tree/"));
}

function applyConstraintFidelity(contributions, result, constraintProfile, queryMode) {
	if (!constraintProfile) return;
	const haystack = [result.title, result.snippet, result.excerpt, result.url, result.publishedAt].filter(Boolean).join(" ").toLowerCase();
	for (const year of constraintProfile.years || []) {
		contributions.push([haystack.includes(year) ? 10 : -8, `year:${year}`]);
	}
	for (const group of constraintProfile.topicalGroups || []) {
		const matched = group.terms.some((term) => haystack.includes(term));
		if (matched) contributions.push([8, `topic:${group.name}`]);
		else if (group.strict) contributions.push([-10, `topic-miss:${group.name}`]);
		else contributions.push([-4, `topic-miss:${group.name}`]);
	}
	for (const entity of constraintProfile.entities || []) {
		contributions.push([haystack.includes(entity) ? 8 : -6, `entity:${entity}`]);
	}
	if ((constraintProfile.exactTerms || []).length > 0 && ["config", "api", "bugfix", "repo", "release", "migration"].includes(queryMode)) {
		const matched = (constraintProfile.exactTerms || []).some((term) => compact(haystack).includes(compact(term)));
		contributions.push([matched ? 8 : -10, "constraint-exact-term"]);
	}
}

function resultIdentity(item) {
	return comparableUrlKey(item?.url) || [compact(item?.title), compact(item?.snippet), compact(item?.excerpt)].filter(Boolean).join("|");
}

function contextFromParams(params) {
	return {
		sourceTypePreference: params.sourceType,
		preferredDomains: params.preferredDomains || [],
		constraintProfile: params.constraintProfile,
	};
}

function enforcePreferredDomainPrecision(results, context) {
	if (!Array.isArray(results) || results.length === 0) return [];
	if (!context?.preferredDomains?.length) return results;
	const hasDocsConstraint = context.sourceTypePreference === "docs" || context.constraintProfile?.requiresOfficialSource;
	if (!hasDocsConstraint) return results;
	const preferred = results.filter((item) => context.preferredDomains.some((domain) => domainMatches(item.domain, domain)));
	if (preferred.length >= Math.min(3, results.length)) {
		const nonPreferred = results.filter((item) => !context.preferredDomains.some((domain) => domainMatches(item.domain, domain)));
		return [...preferred, ...nonPreferred];
	}
	return results;
}

function buildRankingExplanation(result, contributions, context) {
	const positives = contributions.filter(([value]) => value > 0).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, reason]) => reason.replace(/-/g, " "));
	const negatives = contributions.filter(([value]) => value < 0).sort((a, b) => a[0] - b[0]).slice(0, 2).map(([, reason]) => reason.replace(/-/g, " "));
	const leading = positives.length > 0 ? `Ranked highly because of ${positives.join(", ")}` : "Ranked based on weak or neutral signals";
	const descriptor = [context.resultType, context.sourceCategory, context.domain].filter(Boolean).join(" / ");
	const caution = negatives.length > 0 ? `; penalties applied for ${negatives.join(", ")}` : "";
	return descriptor ? `${leading}; classified as ${descriptor}${caution}.` : `${leading}${caution}.`;
}

function freshnessScore(value, freshness) {
	const ts = Date.parse(value);
	if (!Number.isFinite(ts)) return 0;
	const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
	if (freshness === "day") return ageDays <= 2 ? 10 : 0;
	if (freshness === "week") return ageDays <= 10 ? 8 : ageDays <= 30 ? 3 : 0;
	if (freshness === "month") return ageDays <= 45 ? 6 : ageDays <= 180 ? 2 : 0;
	if (freshness === "year") return ageDays <= 400 ? 4 : 1;
	return ageDays <= 30 ? 3 : ageDays <= 180 ? 2 : 0;
}
