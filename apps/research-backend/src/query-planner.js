import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveEcosystemHints } from "./ecosystem-resolver.js";

const rulesPath = process.env.QUERY_NORMALIZATION_RULES_PATH
	? resolve(process.cwd(), process.env.QUERY_NORMALIZATION_RULES_PATH)
	: resolve(import.meta.dirname, "../config/query-normalization-rules.json");
const rules = JSON.parse(readFileSync(rulesPath, "utf8"));
const STOPWORDS = new Set([
	"siapa", "saja", "yang", "paling", "sering", "disebut", "sebagai", "apa", "bagaimana", "dimana", "kapan", "untuk", "dan", "atau", "dari", "dengan", "tahun", "di", "ke", "the", "what", "who", "when", "where", "how", "most", "popular"
]);

export function buildQueryPlan(params = {}) {
	const rawQuery = String(params.query || params.question || "").trim();
	const searchQuery = sanitizeTaskQuery(rawQuery);
	const language = detectLanguage(searchQuery);
	const normalized = normalizeQuery(searchQuery);
	const exactTerms = detectExactTerms(searchQuery);
	const intent = detectIntent(normalized, params.sourceType, params.mode, language);
	const expanded = expandTerms(normalized);
	const repoCandidates = detectRepoCandidates(searchQuery, normalized, intent);
	const entities = detectEntities(searchQuery, normalized, exactTerms, repoCandidates);
	const rawLower = searchQuery.toLowerCase().replace(/\s+/g, " ").trim();
	const keywordQuery = toKeywordQuery(normalized);
	const constraintProfile = buildConstraintProfile({
		rawQuery: searchQuery,
		normalized,
		expanded,
		language,
		intent,
		entities,
		exactTerms,
		repoCandidates,
		preferredDomains: params.preferredDomains || [],
	});
	const variants = generateVariants({
		rawQuery: searchQuery,
		rawLower,
		normalized,
		keywordQuery,
		expanded,
		language,
		intent,
		entities,
		exactTerms,
		repoCandidates,
		constraintProfile,
		preferredDomains: params.preferredDomains || [],
	});
	return {
		originalQuery: rawQuery,
		searchQuery,
		normalizedQuery: normalized,
		language,
		intent,
		entities,
		exactTerms,
		repoCandidates,
		variants,
		constraintProfile,
	};
}

export function buildConstraintProfile(params = {}) {
	const rawQuery = String(params.rawQuery || params.query || params.question || "").trim();
	const normalized = params.normalized || normalizeQuery(rawQuery);
	const expanded = params.expanded || expandTerms(normalized);
	const language = params.language || detectLanguage(rawQuery);
	const intent = params.intent || detectIntent(normalized, params.sourceType, params.mode, language);
	const exactTerms = params.exactTerms || detectExactTerms(rawQuery);
	const repoCandidates = params.repoCandidates || detectRepoCandidates(rawQuery, normalized, intent);
	const entities = params.entities || detectEntities(rawQuery, normalized, exactTerms, repoCandidates);
	const explicitSites = extractExplicitSites(rawQuery);
	const years = [...new Set((expanded.match(/\b(19|20)\d{2}\b/g) || []))];
	const topicalGroups = [];
	const queryMode = detectQueryMode(normalized, intent, exactTerms);
	const taskProfile = detectTaskProfile({ query: normalized, intent, queryMode, exactTerms });
	const ecosystemResolution = resolveEcosystemHints({
		rawQuery,
		normalizedQuery: normalized,
		queryMode,
		exactTerms,
		repoCandidates,
		preferredDomains: params.preferredDomains || [],
		intent,
	});
	return {
		language,
		intent,
		entities,
		years,
		explicitSites,
		topicalGroups,
		exactTerms,
		repoCandidates,
		strictPreferredDomains: explicitSites.length > 0,
		preferredDomains: params.preferredDomains || [],
		expandedQuery: expanded,
		normalizedQuery: normalized,
		queryMode,
		taskProfile,
		ecosystemHints: ecosystemResolution.hints,
		packageCandidates: ecosystemResolution.packageCandidates,
		needsGithubEvidence: intent === "github" || intent === "bugfix" || intent === "discovery" || ["repo", "release", "novel-discovery"].includes(queryMode) || taskProfile === "migration-impact" || taskProfile === "bugfix-investigation" || taskProfile === "release-change" || (intent === "technical-change" && (repoCandidates.length > 0 || /\bgithub\b/.test(normalized))),
		decisionMode: intent === "architecture" || taskProfile === "architecture-decision",
		canonicalPreference: detectCanonicalPreference(normalized, intent, exactTerms),
		githubEntityType: detectGitHubEntityType(normalized, intent, queryMode),
		requiresOfficialSource: /\bofficial\b|\bdocs?\b|\bdocumentation\b|\breference\b/.test(normalized) || (params.preferredDomains || []).length > 0 || ["exact-docs", "migration-impact", "release-change", "official-vs-community"].includes(taskProfile),
		requiresStrongExactMatch: ["exact-docs", "bugfix-investigation"].includes(taskProfile),
	};
}

function sanitizeTaskQuery(query) {
	const raw = String(query || "").trim();
	if (!raw) return raw;
	let cleaned = raw;
	cleaned = cleaned.replace(/\breturn exactly these sections:[\s\S]*$/i, "");
	cleaned = cleaned.replace(/\bin citations[\s\S]*$/i, "");
	cleaned = cleaned.replace(/\buse the [^.!?]*?tool once[^.!?]*? to /i, "");
	cleaned = cleaned.replace(/^use the [^.!?]*?tool[^.!?]*? to /i, "");
	cleaned = cleaned.replace(/^then\s+/i, "");
	cleaned = cleaned.replace(/^brief me on\s+/i, "");
	cleaned = cleaned.replace(/^assess\s+/i, "assess ");
	cleaned = cleaned.replace(/^(assess|evaluate) the impact of\s+/i, "");
	cleaned = cleaned.replace(/^(assess|evaluate) impact of\s+/i, "");
	cleaned = cleaned.replace(/\s+/g, " ").trim();
	return cleaned || raw;
}

function detectLanguage(query) {
	const lower = query.toLowerCase();
	if ((rules.languageHints?.id || []).some((hint) => lower.includes(hint))) return "id";
	return /\b(apa|siapa|dimana|bagaimana|tahun|terpopuler|pakai|cara|dengan)\b/.test(lower) ? "id" : "en";
}

function normalizeQuery(query) {
	return query
		.toLowerCase()
		.replace(/[“”‘’]/g, '"')
		.replace(/[^\p{L}\p{N}\s:\/_\-.]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function detectIntent(query, sourceType, mode, language) {
	if (sourceType === "github" || /\bgithub\b|\brepo\b|\brepository\b|\bissues?\b|\bdiscussions?\b|\breleases?\b|\bpull requests?\b|\bprs?\b/.test(query)) return "github";
	if (/\b(new|novel|uncommon|niche|emerging|latest|newer)\b/.test(query) && /\b(framework|library|sdk|tool|runtime|platform|agent|mcp|server|edge)\b/.test(query)) return "discovery";
	if (/\bvs\b|\bversus\b|\bcompare\b|trade-?off|architecture|microservices|monolith|eventbridge|sqs/.test(query)) return "architecture";
	if (/bug|error|fix|regression|not working|troubleshooting|formdata|server actions/.test(query)) return "bugfix";
	if (/upgrade|upgrading|migrate|migrating|migration|deprecated|breaking changes|release notes|changelog/.test(query)) return "technical-change";
	if (sourceType === "news" || mode === "news") return "news";
	if (sourceType === "docs" || mode === "best-practice") return "docs";
	if (mode === "technical") {
		if (/\bconfig\b|\bconfiguration\b|\boption\b|\bsettings?\b|next\.config|\bapi\b|\breference\b|\bhook\b|\bfunction\b|\bdocs?\b/.test(query)) return "docs";
		if (/\bvs\b|\bcompare\b|trade-?off|architecture/.test(query)) return "architecture";
		return "general";
	}
	return language === "id" ? "general" : "general";
}

function expandTerms(query) {
	let output = query;
	for (const [term, expansions] of Object.entries(rules.expansions || {})) {
		if (!output.includes(term)) continue;
		for (const expansion of expansions) {
			if (!output.includes(expansion)) output += ` ${expansion}`;
		}
	}
	return output.trim();
}

function detectEntities(rawQuery, normalizedQuery, exactTerms = [], repoCandidates = []) {
	const entities = new Set();
	for (const term of exactTerms) {
		const normalized = compactEntity(term);
		if (normalized) entities.add(normalized);
	}
	for (const candidate of repoCandidates) {
		const normalized = compactEntity(candidate.split("/").pop());
		if (normalized) entities.add(normalized);
	}
	for (const token of String(rawQuery || "").split(/\s+/)) {
		if (!/[A-Z]/.test(token) && !/[_-]/.test(token)) continue;
		const normalized = compactEntity(token);
		if (normalized) entities.add(normalized);
	}
	if (entities.size === 0 && /\breact\b|\bnext\.js\b|\bnextjs\b/.test(normalizedQuery)) {
		for (const keyword of ["react", "nextjs"]) {
			if (normalizedQuery.includes(keyword)) entities.add(keyword);
		}
	}
	return [...entities].slice(0, 4);
}

function generateVariants(context) {
	const variants = new Set();
	const hasExplicitSite = context.rawLower.includes("site:");
	const baseRaw = hasExplicitSite ? context.rawQuery : stripOperators(context.rawQuery);
	const baseWithoutSite = hasExplicitSite ? stripOperators(context.rawLower) : (context.keywordQuery || stripOperators(context.normalized));
	const expandedWithoutSite = hasExplicitSite ? stripOperators(context.rawLower) : toKeywordQuery(context.expanded);
	if (baseRaw) variants.add(baseRaw);
	if (hasExplicitSite) variants.add(context.rawLower);
	else variants.add(context.keywordQuery || context.normalized);
	if (!hasExplicitSite && context.expanded && context.expanded !== context.normalized) variants.add(toKeywordQuery(context.expanded));

	const templates = rules.intentTemplates?.[context.intent] || [];
	for (const template of templates) {
		if (hasExplicitSite && template.includes("{query}")) continue;
		variants.add(applyTemplate(template, context));
	}

	for (const exactTerm of context.exactTerms || []) {
		variants.add(`${baseWithoutSite} "${exactTerm}"`.trim());
		if (context.constraintProfile?.requiresOfficialSource) {
			variants.add(`${baseWithoutSite} "${exactTerm}" official docs`.trim());
			variants.add(`${baseWithoutSite} "${exactTerm}" reference`.trim());
		}
	}
	for (const repoCandidate of context.repoCandidates || []) {
		variants.add(repoCandidate);
		variants.add(`${repoCandidate} github`.trim());
		variants.add(`${repoCandidate} site:github.com`.trim());
	}

	if (context.constraintProfile?.queryMode === "config") {
		variants.add(`${baseWithoutSite} configuration reference`.trim());
		variants.add(`${baseWithoutSite} config docs`.trim());
	}
	if (context.constraintProfile?.queryMode === "api") {
		variants.add(`${baseWithoutSite} api reference`.trim());
		variants.add(`${baseWithoutSite} official reference`.trim());
	}
	if (context.constraintProfile?.queryMode === "repo") {
		variants.add(`${baseWithoutSite} github repository`.trim());
		variants.add(`${baseWithoutSite} official repo`.trim());
	}
	if (context.constraintProfile?.queryMode === "novel-discovery") {
		variants.add(`${baseWithoutSite} official docs getting started`.trim());
		variants.add(`${baseWithoutSite} github repo releases`.trim());
		variants.add(`${baseWithoutSite} launch announcement`.trim());
	}
	if (context.constraintProfile?.queryMode === "release" || context.constraintProfile?.queryMode === "migration") {
		variants.add(`${baseWithoutSite} release notes`.trim());
		variants.add(`${baseWithoutSite} changelog`.trim());
	}
	if (context.constraintProfile?.taskProfile === "architecture-decision") {
		variants.add(`${baseWithoutSite} official architecture guidance`.trim());
		variants.add(`${baseWithoutSite} trade-offs best practices`.trim());
	}
	if (context.constraintProfile?.taskProfile === "bugfix-investigation") {
		variants.add(`${baseWithoutSite} troubleshooting`.trim());
		variants.add(`${baseWithoutSite} known issue`.trim());
	}

	for (const domain of (context.preferredDomains || []).slice(0, 3)) {
		variants.add(`${baseWithoutSite} site:${domain}`.trim());
		if (context.intent !== "general") variants.add(`${expandedWithoutSite} site:${domain}`.trim());
		for (const exactTerm of context.exactTerms || []) {
			variants.add(`${baseWithoutSite} "${exactTerm}" site:${domain}`.trim());
		}
	}

	for (const hint of context.constraintProfile?.ecosystemHints || []) {
		for (const queryHint of hint.queryHints || []) variants.add(queryHint);
		for (const domain of (hint.preferredDomains || []).slice(0, 2)) {
			variants.add(`${baseWithoutSite} site:${domain}`.trim());
		}
	}

	variants.add(baseWithoutSite);
	if (expandedWithoutSite) variants.add(expandedWithoutSite);

	return [...variants]
		.map((value) => value.trim())
		.filter(Boolean)
		.slice(0, 16);
}

function applyTemplate(template, context) {
	return template
		.replaceAll("{query}", context.expanded || context.normalized)
		.replaceAll("{entities}", context.entities.join(" "))
		.trim();
}

function extractExplicitSites(query) {
	return [...new Set((String(query || "").match(/\bsite:([^\s]+)/gi) || [])
		.map((item) => item.replace(/^site:/i, "").trim().toLowerCase())
		.filter(Boolean))];
}

function toKeywordQuery(query) {
	return String(query || "")
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token && !STOPWORDS.has(token))
		.join(" ")
		.trim();
}

function detectQueryMode(query, intent, exactTerms = []) {
	if (/\brepo\b|\brepository\b|\bofficial repo\b/.test(query)) return "repo";
	if (/\breleases?\b|\bchangelog\b/.test(query)) return "release";
	if (/\bconfig\b|\bconfiguration\b|\boption\b|\bsettings?\b|next\.config/.test(query)) return "config";
	if (/\bapi\b|\breference\b|\bhook\b|\bfunction\b/.test(query)) return "api";
	if (exactTerms.some((term) => /body.?size|proxyclientmaxbodysize|middlewareclientmaxbodysize|maxbody|config/i.test(term))) return "config";
	if (/\bupgrade\b|\bupgrading\b|\bmigrate\b|\bmigrating\b|\bmigration\b|\bbreaking changes?\b/.test(query)) return "migration";
	if (intent === "github") return "github";
	if (intent === "discovery") return "novel-discovery";
	if (intent === "bugfix") return "bugfix";
	if (intent === "architecture") return "architecture";
	if (intent === "technical-change") return "technical-change";
	if (exactTerms.length > 0) return "api";
	if (/\bdocs\b|\bofficial\b/.test(query)) return "docs";
	return "general";
}

function detectCanonicalPreference(query, intent, exactTerms = []) {
	if (/\brepo\b|\brepository\b/.test(query)) return "repo";
	if (/\breleases?\b|\bchangelog\b/.test(query)) return "release";
	if (/\bconfig\b|\bconfiguration\b|\boption\b|\bsettings?\b|next\.config/.test(query)) return "config";
	if (/\bapi\b|\breference\b|\bhook\b|\bfunction\b/.test(query)) return "api";
	if (exactTerms.some((term) => /body.?size|proxyclientmaxbodysize|middlewareclientmaxbodysize|maxbody|config/i.test(term))) return "config";
	if (exactTerms.length > 0) return "api";
	if (/\bupgrade\b|\bupgrading\b|\bmigrate\b|\bmigrating\b|\bmigration\b|\bbreaking changes?\b/.test(query) || intent === "technical-change") return "migration";
	if (intent === "architecture") return "architecture";
	if (intent === "bugfix") return "bugfix";
	if (intent === "discovery") return "novel-discovery";
	return "general";
}

function detectTaskProfile({ query, intent, queryMode, exactTerms = [] }) {
	if (/\bofficial\b.*\bcommunity\b|\bcommunity\b.*\bofficial\b/.test(query)) return "official-vs-community";
	if (["config", "api"].includes(queryMode) || (exactTerms.length > 0 && /\bdocs?\b|\bofficial\b|\breference\b/.test(query))) return "exact-docs";
	if (["migration", "technical-change"].includes(queryMode) || intent === "technical-change") return "migration-impact";
	if (queryMode === "release") return "release-change";
	if (queryMode === "architecture" || intent === "architecture") return "architecture-decision";
	if (queryMode === "bugfix" || intent === "bugfix") return "bugfix-investigation";
	if (queryMode === "novel-discovery" || intent === "discovery") return "novel-discovery";
	if (intent === "docs") return "best-practice";
	return "general-research";
}

function detectGitHubEntityType(query, intent, queryMode) {
	if (/\bpull requests?\b|\bpr\b/.test(query)) return "pull-request";
	if (/\bdiscussions?\b/.test(query)) return "discussion";
	if (/\bissues?\b/.test(query) || intent === "bugfix") return "issue";
	if (/\breleases?\b|\bchangelog\b/.test(query) || queryMode === "release" || queryMode === "migration") return "release";
	if (/\brepo\b|\brepository\b|\bofficial repo\b/.test(query) || queryMode === "repo") return "repository";
	if (intent === "github") return "mixed";
	return undefined;
}

function detectExactTerms(rawQuery) {
	const exactTerms = new Set();
	for (const match of String(rawQuery || "").matchAll(/"([^"]{3,80})"/g)) {
		exactTerms.add(match[1].trim());
	}
	for (const token of String(rawQuery || "").split(/\s+/)) {
		const cleaned = token.replace(/^[^\p{L}\p{N}_.-]+|[^\p{L}\p{N}_.-]+$/gu, "");
		if (!cleaned || cleaned.length < 4) continue;
		if (/^site:/i.test(cleaned)) continue;
		if (/^https?:\/\//i.test(cleaned)) continue;
		if (/^[A-Za-z0-9]+\.[A-Za-z]{2,}$/i.test(cleaned)) continue;
		if (/[A-Z]/.test(cleaned.slice(1)) || /[_-]/.test(cleaned)) {
			exactTerms.add(cleaned);
		}
	}
	return [...exactTerms].slice(0, 4);
}

function detectRepoCandidates(rawQuery, normalized, intent) {
	if (!/github|repo|repository|release|changelog/.test(normalized) && intent !== "github") return [];
	const tokens = String(rawQuery || "")
		.split(/\s+/)
		.map((token) => token.replace(/^[^\p{L}\p{N}_.\/-]+|[^\p{L}\p{N}_.\/-]+$/gu, ""))
		.filter(Boolean)
		.filter((token) => !/^(github|repo|repository|official|issues?|discussions?|releases?|release|changelog|pull|request|docs?|documentation|guide|guides)$/i.test(token));
	const candidates = new Set();
	for (const token of tokens) {
		if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(token)) candidates.add(token);
	}
	const exactTerms = detectExactTerms(rawQuery)
		.map((term) => normalizeRepoSegment(term))
		.filter(Boolean);
	const repoishTerms = tokens
		.map((token) => normalizeRepoSegment(token))
		.filter(Boolean)
		.filter((token) => !isGenericRepoQualifier(token));
		
	if (tokens.length >= 2) {
		const owner = normalizeRepoSegment(tokens[0]);
		const projectPrimary = exactTerms[0] || repoishTerms[1] || repoishTerms[0];
		const projectSecondary = repoishTerms[2] || exactTerms[1];
		if (owner && projectPrimary && owner !== projectPrimary) {
			candidates.add(`${owner}/${projectPrimary}`);
			if (projectSecondary && !isGenericRepoQualifier(projectSecondary)) {
				candidates.add(`${owner}/${projectPrimary}-${projectSecondary}`);
			}
		}
	}
	for (const exactTerm of exactTerms) {
		if (tokens[0]) {
			const owner = normalizeRepoSegment(tokens[0]);
			if (owner && owner !== exactTerm) candidates.add(`${owner}/${exactTerm}`);
		}
	}
	return [...candidates].slice(0, 6);
}

function normalizeRepoSegment(value) {
	const normalized = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/^@/, "")
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return normalized || undefined;
}

function isGenericRepoQualifier(value) {
	return /^(official|github|repo|repository|release|releases|changelog|compiler|sdk|framework|library|tool|project)$/i.test(String(value || ""));
}

function compactEntity(value) {
	const normalized = String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.trim();
	if (!normalized || normalized.length < 4) return undefined;
	if (STOPWORDS.has(normalized)) return undefined;
	if (["find", "show", "tell", "give", "need", "want", "about", "impact", "official", "docs", "guide", "upgrade", "migration", "release", "notes", "best", "practice"].includes(normalized)) return undefined;
	return normalized;
}

function stripOperators(query) {
	return String(query || "").replace(/\bsite:[^\s]+/g, "").replace(/\s+/g, " ").trim();
}
