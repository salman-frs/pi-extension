import { stableCacheKey } from "../lib/cache.js";
import { summarizeTrace, traceStep } from "../lib/tracing.js";
import { bestSentences, splitSentences, topKeywords } from "../lib/text.js";
import { clip, hostnameFromUrl, unique } from "../lib/utils.js";
import { rankFetchedSources, summarizeSourceCategories } from "../ranking.js";
import { buildTrustSignals, classifySourceCategory, inferSourceType, isAuthoritativeCategory } from "../source-quality.js";
import { fetchWorkflow } from "./research.js";

const COMMUNITY_CATEGORIES = ["forum-community", "secondary-tech-blog", "github-issue", "github-discussion"];
const OFFICIAL_CATEGORIES = ["official-docs", "release-notes", "vendor-blog", "github-repo", "package-docs", "package-registry"];
const AXIS_RULES = [
	{ axis: "maturity", patterns: [/\bmature\b/i, /\bstable\b/i, /\bproduction\b/i, /\bexperimental\b/i, /\bbeta\b/i, /\bga\b/i, /\bpreview\b/i] },
	{ axis: "setup-complexity", patterns: [/\binstall\b/i, /\bsetup\b/i, /\bquickstart\b/i, /\bconfiguration\b/i, /\bcomplex\b/i, /\beasy\b/i] },
	{ axis: "self-hosting", patterns: [/\bself-host\b/i, /\blocal\b/i, /\bedge\b/i, /\bdeploy\b/i, /\bstateless\b/i, /\bdurable\b/i] },
	{ axis: "integration-risk", patterns: [/\brisk\b/i, /\bcaveat\b/i, /\bbreaking\b/i, /\bcompatib(?:le|ility)\b/i, /\blimitation\b/i, /\brollback\b/i] },
	{ axis: "correctness", patterns: [/\binvalidation\b/i, /\brevalidation\b/i, /\bstale\b/i, /\bfreshness\b/i, /\bcorrectness\b/i, /\bcache\b/i] },
	{ axis: "performance", patterns: [/\blatency\b/i, /\bperformance\b/i, /\bthroughput\b/i, /\bdedup(?:lication)?\b/i] },
	{ axis: "ecosystem-fit", patterns: [/\becosystem\b/i, /\bframework\b/i, /\bruntime\b/i, /\bintegration\b/i, /\bpackage\b/i] },
	{ axis: "capability", patterns: [/\bsupports?\b/i, /\bprovides?\b/i, /\benables?\b/i, /\bfeature\b/i, /\bMCP\b/i, /\bagent\b/i] },
];

export async function analyzeWorkflow(config, params, helpers) {
	const key = stableCacheKey({
		question: params.question,
		comparisonMode: params.comparisonMode,
		sources: params.sources,
	});
	const startedAt = Date.now();
	const { value, cache } = await memo(helpers, "analyze", key, config.analyzeCacheTtlMs, async () => traceStep(helpers, "analyze.workflow", { comparisonMode: params.comparisonMode }, async () => {
		const hydrated = [];
		for (const source of params.sources) {
			if (source.content) {
				hydrated.push(normalizeSource({
					title: source.title,
					url: source.url,
					excerpt: clip(source.content, 2200),
					publishedAt: source.publishedAt,
				}));
				continue;
			}
			if (source.url) {
				try {
					const page = await fetchWorkflow(config, {
						url: source.url,
						mode: "auto",
						extractionProfile: "generic",
						signal: params.signal,
					}, helpers);
					hydrated.push(normalizeSource({
						title: source.title || page.title,
						url: page.canonicalUrl || source.url,
						excerpt: clip(page.content, 2200),
						publishedAt: source.publishedAt,
					}));
				} catch {
					hydrated.push(normalizeSource({
						title: source.title,
						url: source.url,
						publishedAt: source.publishedAt,
					}));
				}
			}
		}

		const ranked = rankFetchedSources(hydrated, params.question).slice(0, 8);
		const keywords = topKeywords(ranked.map((source) => `${source.title || ""} ${source.excerpt || ""}`), 10);
		const claimMatrix = buildClaimMatrix(ranked, params.question);
		const comparisonAxes = buildComparisonAxes(claimMatrix);
		const conflicts = buildConflicts(claimMatrix, params.comparisonMode);
		const strongestEvidence = buildStrongestEvidence(ranked, params.question, params.comparisonMode, claimMatrix);
		const agreements = buildAgreements(keywords, ranked, params.comparisonMode, claimMatrix);
		const disagreements = buildDisagreements(ranked, params.comparisonMode, claimMatrix);
		const officialPosition = buildOfficialPosition(ranked, params.question, claimMatrix);
		const communityPosition = buildCommunityPosition(ranked, params.question, claimMatrix);
		const recommendation = buildRecommendation(ranked, params.comparisonMode, claimMatrix, conflicts);
		const uncertainties = buildUncertainties(ranked, disagreements, params.comparisonMode, claimMatrix);
		const gaps = [];
		if (ranked.length < 2) gaps.push("Fewer than two usable sources were available for comparison.");
		if (claimMatrix.length === 0) gaps.push("Claim extraction found little structured evidence, so the comparison remains summary-heavy.");
		if (conflicts.length === 0) gaps.push("No strong contradiction was automatically extracted; manual review may still be needed.");

		helpers.telemetry?.addEvent?.(helpers.trace, "analyze.completed", { comparisonMode: params.comparisonMode, sourceCount: ranked.length, claimAxes: claimMatrix.length });
		return {
			summary: buildSummary(ranked, params.comparisonMode, claimMatrix),
			agreements,
			disagreements,
			strongestEvidence,
			officialPosition,
			communityPosition,
			recommendation,
			uncertainties,
			comparisonAxes,
			conflicts,
			claimMatrix,
			gaps,
			sources: ranked,
			metadata: {
				comparisonMode: params.comparisonMode,
				keywords,
				sourceTypes: unique(ranked.map((source) => source.sourceType).filter(Boolean)),
				sourceCategories: summarizeSourceCategories(ranked),
				rankingVisible: true,
				analysisQuality: claimMatrix.length >= 2 ? "claim-structured" : "summary-heavy",
			},
		};
	}));
	helpers.logger?.info("analyze.completed", {
		requestId: helpers.requestId,
		question: params.question,
		comparisonMode: params.comparisonMode,
		sourceCount: value.sources?.length || 0,
		cacheHit: cache.hit,
		durationMs: Date.now() - startedAt,
	});
	return {
		...value,
		metadata: {
			...(value.metadata || {}),
			cache,
			trace: summarizeTrace(helpers.trace) || { requestId: helpers.requestId },
		},
	};
}

function normalizeSource(source) {
	const sourceType = inferSourceType(source.url, "general");
	const sourceCategory = classifySourceCategory({ ...source, sourceType });
	return {
		...source,
		domain: hostnameFromUrl(source.url),
		sourceType,
		sourceCategory,
		trustSignals: buildTrustSignals({ ...source, sourceType, sourceCategory }),
	};
}

function buildSummary(ranked, comparisonMode, claimMatrix) {
	const structured = claimMatrix.length > 0 ? ` Claim extraction covered ${claimMatrix.length} comparison axis/axes.` : "";
	return `Source analysis prepared across ${ranked.length} source(s) using ${comparisonMode} mode.${structured}`;
}

function buildStrongestEvidence(ranked, question, comparisonMode, claimMatrix) {
	if (comparisonMode === "timeline") {
		return ranked
			.filter((source) => source.publishedAt)
			.sort((a, b) => Date.parse(a.publishedAt || "") - Date.parse(b.publishedAt || ""))
			.slice(0, 5)
			.map((source) => `${source.publishedAt}: ${source.title || source.url}`);
	}
	const fromClaims = claimMatrix
		.flatMap((axis) => axis.support.slice(0, 1).concat(axis.conflict.slice(0, 1)))
		.filter(Boolean)
		.slice(0, 5)
		.map((claim) => `${claim.sourceTitle || claim.sourceUrl}: ${claim.sentence}`);
	if (fromClaims.length > 0) return fromClaims;
	return ranked
		.map((source) => {
			const sentences = bestSentences(source.excerpt || source.title || "", question, 2);
			return sentences[0] ? `${source.title || source.url}: ${sentences[0]}` : undefined;
		})
		.filter(Boolean)
		.slice(0, 5);
}

function buildAgreements(keywords, ranked, comparisonMode, claimMatrix) {
	const outputs = [];
	if (keywords.length > 0) outputs.push(`Common recurring terms across sources: ${keywords.slice(0, 6).join(", ")}.`);
	const commonDomains = unique(ranked.map((source) => source.domain).filter(Boolean));
	if (commonDomains.length > 1) outputs.push(`Evidence spans multiple domains: ${commonDomains.slice(0, 5).join(", ")}.`);
	const authoritative = ranked.filter((source) => isAuthoritativeCategory(source.sourceCategory));
	if (authoritative.length > 0) outputs.push(`${authoritative.length} source(s) are classified as primary or authoritative evidence.`);
	for (const axis of claimMatrix) {
		if (axis.conflict.length === 0 && axis.support.length >= 2) outputs.push(`Sources broadly align on ${axis.axis}: ${axis.summary}`);
	}
	if (comparisonMode === "official-vs-community") {
		const official = ranked.filter((source) => OFFICIAL_CATEGORIES.includes(source.sourceCategory));
		const community = ranked.filter((source) => COMMUNITY_CATEGORIES.includes(source.sourceCategory));
		if (official.length > 0 && community.length > 0) outputs.push("Both official/vendor and community-oriented sources are present for direct comparison.");
	}
	return unique(outputs).slice(0, 6);
}

function buildOfficialPosition(ranked, question, claimMatrix) {
	const official = ranked.filter((source) => OFFICIAL_CATEGORIES.includes(source.sourceCategory));
	if (official.length === 0) return undefined;
	const claim = claimMatrix.flatMap((axis) => axis.support).find((item) => OFFICIAL_CATEGORIES.includes(item.sourceCategory));
	if (claim) return `${claim.sourceTitle || claim.sourceUrl}: ${claim.sentence}`;
	const top = official[0];
	const sentence = bestSentences(top.excerpt || top.title || "", question, 1)[0];
	return sentence ? `${top.title || top.url}: ${sentence}` : `${top.title || top.url} is the strongest official/vendor source in this comparison.`;
}

function buildCommunityPosition(ranked, question, claimMatrix) {
	const community = ranked.filter((source) => COMMUNITY_CATEGORIES.includes(source.sourceCategory));
	if (community.length === 0) return undefined;
	const claim = claimMatrix.flatMap((axis) => axis.support.concat(axis.conflict)).find((item) => COMMUNITY_CATEGORIES.includes(item.sourceCategory));
	if (claim) return `${claim.sourceTitle || claim.sourceUrl}: ${claim.sentence}`;
	const top = community[0];
	const sentence = bestSentences(top.excerpt || top.title || "", question, 1)[0];
	return sentence ? `${top.title || top.url}: ${sentence}` : `${top.title || top.url} is the strongest community-oriented source in this comparison.`;
}

function buildRecommendation(ranked, comparisonMode, claimMatrix, conflicts) {
	if (ranked.length === 0) return undefined;
	const top = ranked[0];
	const contradictory = conflicts.length > 0;
	if (comparisonMode === "official-vs-community") {
		return contradictory
			? `Use ${top.title || top.url} as the anchor, but resolve the extracted conflicts before finalizing a decision.`
			: `Prefer ${top.title || top.url} as the anchor, then use the strongest community source to validate edge cases and implementation caveats.`;
	}
	if (claimMatrix.length >= 2 && !contradictory) {
		return `Start from ${top.title || top.url} as the strongest evidence source; the extracted comparison claims are coherent enough for a directionally confident recommendation.`;
	}
	return `Start from ${top.title || top.url} as the strongest evidence source, then validate any conflicting details against the remaining sources.`;
}

function buildUncertainties(ranked, disagreements, comparisonMode, claimMatrix) {
	const outputs = [];
	if (ranked.length < 2) outputs.push("Only a small source set was available for comparison.");
	if ((disagreements || []).length === 0) outputs.push("No strong disagreement was automatically detected, but manual review may still surface nuance.");
	if (comparisonMode === "official-vs-community" && !ranked.some((source) => COMMUNITY_CATEGORIES.includes(source.sourceCategory))) {
		outputs.push("Community-oriented evidence is limited, so community edge cases may be underrepresented.");
	}
	if (claimMatrix.length === 0) outputs.push("Claim extraction did not find enough structured evidence to support a richer comparison matrix.");
	return outputs;
}

function buildDisagreements(ranked, comparisonMode, claimMatrix) {
	const outputs = [];
	if (comparisonMode === "timeline") {
		const dated = ranked.filter((source) => source.publishedAt);
		if (dated.length > 1) outputs.push("Sources reference different publication times, which may explain differences in emphasis or completeness.");
	}
	if (comparisonMode === "official-vs-community") {
		const official = ranked.some((source) => OFFICIAL_CATEGORIES.includes(source.sourceCategory));
		const community = ranked.some((source) => COMMUNITY_CATEGORIES.includes(source.sourceCategory));
		if (official && community) outputs.push("Official/vendor sources and community sources may emphasize different tradeoffs, caveats, or edge cases.");
	}
	for (const axis of claimMatrix) {
		if (axis.conflict.length > 0) outputs.push(`Conflict on ${axis.axis}: ${axis.summary}`);
	}
	const categories = summarizeSourceCategories(ranked);
	if (categories.includes("major-media") && categories.includes("forum-community")) {
		outputs.push("Reporting-style sources and community discussion often differ in certainty, framing, and level of verification.");
	}
	return unique(outputs).slice(0, 6);
}

function buildComparisonAxes(claimMatrix) {
	return claimMatrix.map((axis) => ({
		axis: axis.axis,
		summary: axis.summary,
		supportCount: axis.support.length,
		conflictCount: axis.conflict.length,
		leadingStance: axis.leadingStance,
	}));
}

function buildConflicts(claimMatrix, comparisonMode) {
	const outputs = [];
	for (const axis of claimMatrix) {
		if (axis.conflict.length === 0) continue;
		outputs.push(`${axis.axis}: ${axis.conflict[0].sentence}`);
	}
	if (comparisonMode === "official-vs-community" && outputs.length === 0) {
		outputs.push("Official and community evidence may still diverge in edge cases even when direct contradiction was not extracted.");
	}
	return outputs.slice(0, 6);
}

function buildClaimMatrix(ranked, question) {
	const claims = ranked.flatMap((source) => extractClaimsFromSource(source, question));
	const grouped = new Map();
	for (const claim of claims) {
		const entry = grouped.get(claim.axis) || { axis: claim.axis, support: [], conflict: [], neutral: [] };
		if (claim.stance === "positive") entry.support.push(claim);
		else if (claim.stance === "negative") entry.conflict.push(claim);
		else entry.neutral.push(claim);
		grouped.set(claim.axis, entry);
	}
	return [...grouped.values()].map((entry) => ({
		axis: entry.axis,
		support: orderClaims(entry.support),
		conflict: orderClaims(entry.conflict),
		neutral: orderClaims(entry.neutral),
		leadingStance: entry.support.length >= entry.conflict.length ? "positive" : "negative",
		summary: summarizeClaimGroup(entry),
	})).sort((a, b) => (b.support.length + b.conflict.length) - (a.support.length + a.conflict.length)).slice(0, 6);
}

function extractClaimsFromSource(source, question) {
	const sentences = unique([
		...bestSentences(source.excerpt || source.title || "", question, 4),
		...splitSentences(source.excerpt || source.snippet || "").slice(0, 6),
	]);
	const claims = [];
	for (const sentence of sentences) {
		const cleaned = cleanupSentence(sentence);
		if (!cleaned || cleaned.length < 24) continue;
		const axis = classifyClaimAxis(cleaned);
		if (!axis) continue;
		claims.push({
			axis,
			stance: classifyClaimStance(cleaned),
			sentence: cleaned,
			sourceTitle: source.title,
			sourceUrl: source.url,
			sourceCategory: source.sourceCategory,
			weight: claimWeight(source),
		});
	}
	return claims;
}

function classifyClaimAxis(sentence) {
	for (const rule of AXIS_RULES) {
		if (rule.patterns.some((pattern) => pattern.test(sentence))) return rule.axis;
	}
	return undefined;
}

function classifyClaimStance(sentence) {
	if (/\b(risk|warning|caveat|complex|breaking|limitation|hard|difficult|manual|underrepresented|experimental|beta|preview)\b/i.test(sentence)) return "negative";
	if (/\b(recommend|prefer|supports?|provides?|enables?|stable|mature|production|easy|quickstart|simple|works)\b/i.test(sentence)) return "positive";
	return "neutral";
}

function claimWeight(source) {
	let weight = 0;
	if (isAuthoritativeCategory(source.sourceCategory)) weight += 3;
	if (OFFICIAL_CATEGORIES.includes(source.sourceCategory)) weight += 2;
	if (COMMUNITY_CATEGORIES.includes(source.sourceCategory)) weight += 1;
	return weight;
}

function orderClaims(claims) {
	return [...claims].sort((a, b) => (b.weight || 0) - (a.weight || 0));
}

function summarizeClaimGroup(entry) {
	if (entry.support.length > 0 && entry.conflict.length === 0) return entry.support[0].sentence;
	if (entry.conflict.length > 0 && entry.support.length === 0) return entry.conflict[0].sentence;
	if (entry.support.length > 0 && entry.conflict.length > 0) {
		return `${entry.support[0].sentence} However, ${entry.conflict[0].sentence.toLowerCase()}`;
	}
	return entry.neutral[0]?.sentence || `Mixed evidence on ${entry.axis}.`;
}

function cleanupSentence(sentence) {
	return String(sentence || "")
		.replace(/\s+/g, " ")
		.replace(/^[-*]\s*/, "")
		.trim();
}

async function memo(helpers, namespace, key, ttlMs, compute) {
	if (!helpers.cache?.enabled) {
		return { value: await compute(), cache: { hit: false, namespace, key, enabled: false } };
	}
	const result = await helpers.cache.memo(namespace, key, ttlMs, compute);
	return { value: result.value, cache: { ...result.cache, enabled: true } };
}
