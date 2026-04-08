import { stableCacheKey } from "../lib/cache.js";
import { bestSentences, topKeywords } from "../lib/text.js";
import { clip, hostnameFromUrl, unique } from "../lib/utils.js";
import { rankFetchedSources, summarizeSourceCategories } from "../ranking.js";
import { buildTrustSignals, classifySourceCategory, inferSourceType, isAuthoritativeCategory } from "../source-quality.js";
import { fetchWorkflow } from "./research.js";

export async function analyzeWorkflow(config, params, helpers) {
	const key = stableCacheKey({
		question: params.question,
		comparisonMode: params.comparisonMode,
		sources: params.sources,
	});
	const startedAt = Date.now();
	const { value, cache } = await memo(helpers, "analyze", key, config.analyzeCacheTtlMs, async () => {
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
		const strongestEvidence = buildStrongestEvidence(ranked, params.question, params.comparisonMode);
		const agreements = buildAgreements(keywords, ranked, params.comparisonMode);
		const disagreements = buildDisagreements(ranked, params.comparisonMode);
		const gaps = [];
		if (ranked.length < 2) gaps.push("Fewer than two usable sources were available for comparison.");
		if (disagreements.length === 0) gaps.push("No strong disagreement was automatically detected; manual review may still be needed.");

		return {
			summary: buildSummary(ranked, params.comparisonMode),
			agreements,
			disagreements,
			strongestEvidence,
			officialPosition: buildOfficialPosition(ranked, params.question),
			communityPosition: buildCommunityPosition(ranked, params.question),
			recommendation: buildRecommendation(ranked, params.comparisonMode),
			uncertainties: buildUncertainties(ranked, disagreements, params.comparisonMode),
			gaps,
			sources: ranked,
			metadata: {
				comparisonMode: params.comparisonMode,
				keywords,
				sourceTypes: unique(ranked.map((source) => source.sourceType).filter(Boolean)),
				sourceCategories: summarizeSourceCategories(ranked),
				rankingVisible: true,
			},
		};
	});
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
			trace: { requestId: helpers.requestId },
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

function buildSummary(ranked, comparisonMode) {
	return `Source analysis prepared across ${ranked.length} source(s) using ${comparisonMode} mode.`;
}

function buildStrongestEvidence(ranked, question, comparisonMode) {
	if (comparisonMode === "timeline") {
		return ranked
			.filter((source) => source.publishedAt)
			.sort((a, b) => Date.parse(a.publishedAt || "") - Date.parse(b.publishedAt || ""))
			.slice(0, 5)
			.map((source) => `${source.publishedAt}: ${source.title || source.url}`);
	}
	return ranked
		.map((source) => {
			const sentences = bestSentences(source.excerpt || source.title || "", question, 2);
			return sentences[0] ? `${source.title || source.url}: ${sentences[0]}` : undefined;
		})
		.filter(Boolean)
		.slice(0, 5);
}

function buildAgreements(keywords, ranked, comparisonMode) {
	const outputs = [];
	if (keywords.length > 0) outputs.push(`Common recurring terms across sources: ${keywords.slice(0, 6).join(", ")}.`);
	const commonDomains = unique(ranked.map((source) => source.domain).filter(Boolean));
	if (commonDomains.length > 1) outputs.push(`Evidence spans multiple domains: ${commonDomains.slice(0, 5).join(", ")}.`);
	const authoritative = ranked.filter((source) => isAuthoritativeCategory(source.sourceCategory));
	if (authoritative.length > 0) outputs.push(`${authoritative.length} source(s) are classified as primary or authoritative evidence.`);
	if (comparisonMode === "official-vs-community") {
		const official = ranked.filter((source) => ["official-docs", "release-notes", "vendor-blog"].includes(source.sourceCategory));
		const community = ranked.filter((source) => ["secondary-tech-blog", "forum-community", "github-discussion", "github-issue"].includes(source.sourceCategory));
		if (official.length > 0 && community.length > 0) outputs.push(`Both official/vendor and community-oriented sources are present for direct comparison.`);
	}
	return outputs;
}

function buildOfficialPosition(ranked, question) {
	const official = ranked.filter((source) => ["official-docs", "release-notes", "vendor-blog", "github-repo"].includes(source.sourceCategory));
	if (official.length === 0) return undefined;
	const top = official[0];
	const sentence = bestSentences(top.excerpt || top.title || "", question, 1)[0];
	return sentence ? `${top.title || top.url}: ${sentence}` : `${top.title || top.url} is the strongest official/vendor source in this comparison.`;
}

function buildCommunityPosition(ranked, question) {
	const community = ranked.filter((source) => ["forum-community", "secondary-tech-blog", "github-issue", "github-discussion"].includes(source.sourceCategory));
	if (community.length === 0) return undefined;
	const top = community[0];
	const sentence = bestSentences(top.excerpt || top.title || "", question, 1)[0];
	return sentence ? `${top.title || top.url}: ${sentence}` : `${top.title || top.url} is the strongest community-oriented source in this comparison.`;
}

function buildRecommendation(ranked, comparisonMode) {
	if (ranked.length === 0) return undefined;
	const top = ranked[0];
	if (comparisonMode === "official-vs-community") {
		return `Prefer ${top.title || top.url} as the anchor, then use the strongest community source to validate edge cases and implementation caveats.`;
	}
	return `Start from ${top.title || top.url} as the strongest evidence source, then validate any conflicting details against the remaining sources.`;
}

function buildUncertainties(ranked, disagreements, comparisonMode) {
	const outputs = [];
	if (ranked.length < 2) outputs.push("Only a small source set was available for comparison.");
	if ((disagreements || []).length === 0) outputs.push("No strong disagreement was automatically detected, but manual review may still surface nuance.");
	if (comparisonMode === "official-vs-community" && !ranked.some((source) => ["forum-community", "secondary-tech-blog", "github-issue", "github-discussion"].includes(source.sourceCategory))) {
		outputs.push("Community-oriented evidence is limited, so community edge cases may be underrepresented.");
	}
	return outputs;
}

function buildDisagreements(ranked, comparisonMode) {
	const outputs = [];
	if (comparisonMode === "timeline") {
		const dated = ranked.filter((source) => source.publishedAt);
		if (dated.length > 1) outputs.push("Sources reference different publication times, which may explain differences in emphasis or completeness.");
	}
	if (comparisonMode === "official-vs-community") {
		const official = ranked.some((source) => ["official-docs", "release-notes", "vendor-blog"].includes(source.sourceCategory));
		const community = ranked.some((source) => ["secondary-tech-blog", "forum-community", "github-discussion", "github-issue"].includes(source.sourceCategory));
		if (official && community) outputs.push("Official/vendor sources and community sources may emphasize different tradeoffs, caveats, or edge cases.");
	}
	const categories = summarizeSourceCategories(ranked);
	if (categories.includes("major-media") && categories.includes("forum-community")) {
		outputs.push("Reporting-style sources and community discussion often differ in certainty, framing, and level of verification.");
	}
	return outputs;
}

async function memo(helpers, namespace, key, ttlMs, compute) {
	if (!helpers.cache?.enabled) {
		return { value: await compute(), cache: { hit: false, namespace, key, enabled: false } };
	}
	const result = await helpers.cache.memo(namespace, key, ttlMs, compute);
	return { value: result.value, cache: { ...result.cache, enabled: true } };
}
