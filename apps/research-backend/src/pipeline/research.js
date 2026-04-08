import { fetchRenderedPage } from "../adapters/browser/playwright.js";
import { searchSearxng } from "../adapters/discovery/searxng.js";
import { searchGitHubWeb } from "../adapters/discovery/github-web.js";
import { fetchDirect } from "../adapters/extraction/direct.js";
import { stableCacheKey } from "../lib/cache.js";
import { buildQueryPlan } from "../query-planner.js";
import { bestSentences, cleanupWhitespace, extractCallouts, extractCanonicalUrl, extractCodeBlocks, extractHeadings, extractTitle, htmlToText, topKeywords } from "../lib/text.js";
import { clip, domainMatches, hostnameFromUrl } from "../lib/utils.js";
import { detectDisagreementSignals, rankFetchedSources, rankSearchResults, summarizeSourceCategories, summarizeSourceTypes } from "../ranking.js";
import { classifySourceCategory, inferSourceType, isAuthoritativeCategory } from "../source-quality.js";

export async function searchWorkflow(config, params, helpers) {
	if (!config.searxngUrl) {
		throw new Error("SEARXNG_URL is required for search workflow");
	}
	const key = stableCacheKey({
		query: params.query,
		freshness: params.freshness,
		maxResults: params.maxResults,
		preferredDomains: params.preferredDomains || [],
		blockedDomains: params.blockedDomains || [],
		sourceType: params.sourceType || "general",
	});
	const startedAt = Date.now();
	const plan = buildQueryPlan(params);
	const { value, cache } = await memo(
		helpers,
		"search",
		key,
		config.searchCacheTtlMs,
		async () => {
			const providerResults = [];
			const providerErrors = [];
			const diagnostics = { plan, providers: [] };

			const searx = await searchSearxng(config, params, plan, helpers.fetchWithTimeout, helpers.logger, helpers.requestId);
			providerResults.push(...searx.results);
			providerErrors.push(...(searx.errors || []));
			diagnostics.providers.push({ name: "searxng", status: searx.status, diagnostics: searx.diagnostics });

			if (shouldUseGitHubSupplement(plan, params)) {
				const github = await searchGitHubWeb(config, params, plan, helpers.fetchWithTimeout, helpers.logger, helpers.requestId);
				providerResults.push(...github.results);
				providerErrors.push(...(github.errors || []));
				diagnostics.providers.push({ name: "github-web", status: github.status, diagnostics: github.diagnostics });
			}

			const ranked = rankSearchResults(providerResults, { ...params, constraintProfile: plan.constraintProfile }).slice(0, params.maxResults || 8);
			const successProviders = diagnostics.providers.filter((item) => item.status === "success" || item.status === "partial_success").length;
			const status = ranked.length === 0
				? (providerErrors.length > 0 ? "failure" : "no_results")
				: (providerErrors.length > 0 ? "partial_success" : "success");
			return {
				status,
				results: ranked,
				errors: providerErrors,
				diagnostics: {
					...diagnostics,
					successProviders,
				},
			};
		},
	);
	helpers.logger?.info("search.completed", {
		requestId: helpers.requestId,
		query: params.query,
		freshness: params.freshness,
		sourceType: params.sourceType,
		status: value.status,
		resultCount: value.results.length,
		cacheHit: cache.hit,
		errorCount: value.errors?.length || 0,
		preferredDomainHitRatio: computePreferredDomainHitRatio(value.results, params.preferredDomains || []),
		domainDistribution: summarizeDomains(value.results),
		durationMs: Date.now() - startedAt,
	});
	return {
		...value,
		metadata: {
			cache,
			trace: buildTrace(helpers),
		},
	};
}

export async function fetchWorkflow(config, params, helpers) {
	const directKey = stableCacheKey({ url: params.url, mode: "fast", extractionProfile: params.extractionProfile });
	const renderedKey = stableCacheKey({ url: params.url, mode: "rendered", extractionProfile: params.extractionProfile });
	const startedAt = Date.now();

	const directMemo = async () => {
		const direct = await fetchDirect(config, params.url, params.extractionProfile, helpers.fetchWithTimeout, params.signal);
		const content = clip(direct.text, 16000);
		return {
			url: params.url,
			canonicalUrl: direct.canonicalUrl,
			title: direct.title,
			content,
			extractionProfile: params.extractionProfile,
			fetchMode: params.mode === "rendered" ? "fast-fallback" : params.mode,
			contentType: direct.contentType,
			status: direct.status,
			metadata: {
				strategy: direct.variant?.startsWith("docs-markdown") ? "docs-markdown-fetch" : "direct-fetch",
				sourceVariant: direct.variant,
				resolvedUrl: direct.resolvedUrl,
				codeAware: buildCodeAwareMetadata(direct.html, content, params.extractionProfile),
			},
		};
	};

	if (params.mode === "rendered") {
		const rendered = await fetchRenderedWorkflow(config, params, helpers, renderedKey);
		helpers.logger?.info("fetch.completed", {
			requestId: helpers.requestId,
			url: params.url,
			mode: params.mode,
			strategy: rendered.metadata?.strategy,
			cacheHit: rendered.metadata?.cache?.hit,
			durationMs: Date.now() - startedAt,
		});
		return rendered;
	}

	const { value: direct, cache: directCache } = await memo(helpers, "fetch", directKey, config.fetchCacheTtlMs, directMemo);
	if (shouldUseBrowserFallback(config, params.mode, direct)) {
		try {
			const rendered = await fetchRenderedWorkflow(config, params, helpers, renderedKey);
			helpers.logger?.info("fetch.completed", {
				requestId: helpers.requestId,
				url: params.url,
				mode: params.mode,
				strategy: rendered.metadata?.strategy,
				cacheHit: rendered.metadata?.cache?.hit,
				durationMs: Date.now() - startedAt,
			});
			return rendered;
		} catch (error) {
			helpers.logger?.warn("fetch.rendered_fallback_failed", {
				requestId: helpers.requestId,
				url: params.url,
				error,
			});
		}
	}

	const response = withFetchMetadata(direct, {
		cache: directCache,
		trace: buildTrace(helpers),
	});
	helpers.logger?.info("fetch.completed", {
		requestId: helpers.requestId,
		url: params.url,
		mode: params.mode,
		strategy: response.metadata?.strategy,
		cacheHit: response.metadata?.cache?.hit,
		durationMs: Date.now() - startedAt,
	});
	return response;
}

export async function researchWorkflow(config, params, helpers) {
	const key = stableCacheKey({
		question: params.question,
		mode: params.mode,
		freshness: params.freshness,
		numberOfSources: params.numberOfSources,
		sourcePolicy: params.sourcePolicy || "",
		outputDepth: params.outputDepth,
		preferredDomains: params.preferredDomains || [],
		blockedDomains: params.blockedDomains || [],
	});
	const startedAt = Date.now();
	const questionPlan = buildQueryPlan({ query: params.question, mode: params.mode, preferredDomains: params.preferredDomains || [] });
	const { value, cache } = await memo(helpers, "research", key, config.researchCacheTtlMs, async () => {
		const search = await performResearchDiscovery(config, params, questionPlan, helpers);
		const initialCandidates = search.results.slice(0, Math.min(config.maxFetchedSources, Math.max(params.numberOfSources * 2, params.numberOfSources + 4, 6)));
		const fetched = [];
		for (const candidate of initialCandidates) {
			try {
				const page = await fetchWorkflow(config, {
					url: candidate.url,
					mode: "auto",
					extractionProfile: modeToProfile(params.mode),
					signal: params.signal,
				}, helpers);
				fetched.push({
					title: page.title || candidate.title,
					url: page.canonicalUrl || candidate.url,
					domain: hostnameFromUrl(page.canonicalUrl || candidate.url),
					sourceType: candidate.sourceType || inferSourceType(candidate.url),
					sourceCategory: candidate.sourceCategory || classifySourceCategory(candidate),
					resultType: candidate.resultType,
					publishedAt: candidate.publishedAt,
					snippet: candidate.snippet,
					excerpt: clip(page.content, excerptLength(params.outputDepth)),
					fetchMode: page.fetchMode,
					fetchStrategy: page.metadata?.strategy,
					ranking: candidate.ranking,
				});
			} catch {
				fetched.push({
					title: candidate.title,
					url: candidate.url,
					domain: candidate.domain,
					sourceType: candidate.sourceType || inferSourceType(candidate.url),
					sourceCategory: candidate.sourceCategory || classifySourceCategory(candidate),
					resultType: candidate.resultType,
					publishedAt: candidate.publishedAt,
					snippet: candidate.snippet,
					ranking: candidate.ranking,
				});
			}
		}

		const candidateRanking = rankFetchedSources(fetched, questionPlan.searchQuery || params.question, params.preferredDomains || [], questionPlan.constraintProfile);
		const precisionFiltered = candidateRanking.filter((source) => passesResearchPrecisionGate(source, questionPlan.constraintProfile));
		const prioritized = precisionFiltered.length > 0 ? precisionFiltered : candidateRanking;
		const selection = selectResearchSources(prioritized, params.numberOfSources, questionPlan.constraintProfile);
		const ranked = selection.sources;
		const findings = buildFindings(questionPlan.searchQuery || params.question, ranked);
		const keywords = topKeywords(ranked.map((source) => [source.title, source.snippet, source.excerpt].filter(Boolean).join(" ")), 8);
		const sourceTypes = summarizeSourceTypes(ranked);
		const sourceCategories = summarizeSourceCategories(ranked);
		const agreements = buildAgreements(ranked, keywords, questionPlan.constraintProfile);
		const disagreements = buildDisagreements(ranked, params.mode, questionPlan.constraintProfile);
		const confidence = computeConfidence(ranked, questionPlan.constraintProfile);

		return {
			status:
				search.status === "failure" && ranked.length === 0
					? "failure"
					: search.status === "no_results" && ranked.length === 0
						? "no_results"
						: (search.errors?.length ? "partial_success" : "success"),
			answer: buildAnswer({ ...params, question: questionPlan.searchQuery || params.question }, ranked, agreements, disagreements, questionPlan.constraintProfile),
			summary: buildSummary(params, ranked, sourceTypes, sourceCategories, keywords, selection),
			findings,
			agreements,
			disagreements,
			sources: ranked,
			confidence,
			gaps: buildGaps(ranked, confidence, questionPlan.constraintProfile),
			metadata: {
				strategy: "web-research-workflow",
				keywords,
				sourceTypes,
				sourceCategories,
				retrievedSources: ranked.length,
				rankingVisible: true,
				searchDiagnostics: search.diagnostics,
				searchErrors: search.errors,
				selection,
				queryPlan: questionPlan,
			},
		};
	});
	helpers.logger?.info("research.completed", {
		requestId: helpers.requestId,
		question: params.question,
		mode: params.mode,
		sourceCount: value.sources?.length || 0,
		cacheHit: cache.hit,
		confidence: value.confidence,
		status: value.status,
		durationMs: Date.now() - startedAt,
	});
	return {
		...value,
		metadata: {
			...(value.metadata || {}),
			cache,
			trace: buildTrace(helpers),
		},
	};
}

async function fetchRenderedWorkflow(config, params, helpers, renderedKey) {
	const { value, cache } = await memo(helpers, "rendered-fetch", renderedKey, config.renderedFetchCacheTtlMs, async () => {
		const rendered = await fetchRenderedPage(config, params.url);
		const content = clip(htmlToText(rendered.html), 16000);
		return {
			url: params.url,
			canonicalUrl: extractCanonicalUrl(rendered.html) ?? params.url,
			title: rendered.title ?? extractTitle(rendered.html),
			content,
			extractionProfile: params.extractionProfile,
			fetchMode: "rendered",
			contentType: "text/html",
			status: 200,
			metadata: { strategy: "playwright-fallback", codeAware: buildCodeAwareMetadata(rendered.html, content, params.extractionProfile) },
		};
	});
	return withFetchMetadata(value, { cache, trace: buildTrace(helpers) });
}

function buildFindings(question, sources) {
	const findings = [];
	for (const source of sources.slice(0, 5)) {
		const evidence = bestSentences(source.excerpt || source.snippet || source.title || "", question, 2)
			.map((sentence) => cleanupWhitespace(sentence))
			.filter(Boolean);
		if (evidence.length === 0) {
			findings.push(`${source.title || source.url}: relevant source retrieved, but no strong sentence-level match was extracted automatically.`);
		} else {
			findings.push(`${source.title || source.url}: ${evidence.join(" ")}`);
		}
	}
	return findings;
}

function buildSummary(params, sources, sourceTypes, sourceCategories, keywords, selection) {
	if (sources.length === 0) {
		return `No usable sources were retrieved for this ${params.mode} research query.`;
	}
	return [
		`Research bundle assembled for a ${params.mode} query using ${sources.length} ranked source(s).`,
		selection?.anchorTitle ? `Anchor source: ${selection.anchorTitle}.` : undefined,
		`Source mix: ${sourceTypes.length > 0 ? sourceTypes.join(", ") : "general"}.`,
		sourceCategories.length > 0 ? `Source categories: ${sourceCategories.join(", ")}.` : undefined,
		keywords.length > 0 ? `Dominant themes detected: ${keywords.join(", ")}.` : undefined,
		params.sourcePolicy ? `Source policy guidance applied: ${params.sourcePolicy}.` : undefined,
	].filter(Boolean).join(" ");
}

function buildAnswer(params, sources, agreements, disagreements, constraintProfile) {
	if (sources.length === 0) {
		return `I could not assemble a grounded answer for this ${params.mode} query because no usable sources were retrieved.`;
	}
	const lead = sources[0];
	const authoritative = sources.filter((source) => isAuthoritativeCategory(source.sourceCategory));
	const leadDescriptor = describeLeadSource(lead, constraintProfile);
	return [
		`Based on ${sources.length} ranked source(s), the strongest evidence for “${params.question}” comes from ${authoritative.length > 0 ? `${authoritative.length} authoritative source(s)` : "a limited evidence set"}.`,
		lead?.title ? `The anchor source is ${lead.title}${leadDescriptor ? ` (${leadDescriptor})` : ""}.` : undefined,
		agreements[0] ? `Agreement signal: ${agreements[0]}` : undefined,
		disagreements[0] ? `Caveat: ${disagreements[0]}` : undefined,
	].filter(Boolean).join(" ");
}

function buildAgreements(sources, keywords, constraintProfile) {
	const outputs = [];
	if (keywords.length > 0) outputs.push(`Repeated themes across sources include ${keywords.slice(0, 6).join(", ")}.`);
	const authoritative = sources.filter((source) => isAuthoritativeCategory(source.sourceCategory));
	if (authoritative.length > 0) outputs.push(`${authoritative.length} source(s) are classified as authoritative or primary evidence.`);
	if (constraintProfile?.canonicalPreference && sources[0]?.resultType) {
		outputs.push(`The selected anchor matches the expected result type family for this task (${sources[0].resultType}).`);
	}
	return outputs;
}

function buildDisagreements(sources, mode, constraintProfile) {
	const outputs = detectDisagreementSignals(sources);
	if (mode === "news" && sources.some((source) => !source.publishedAt)) {
		outputs.push("Some news-style sources did not expose clear publish timestamps, so recency ranking may be imperfect.");
	}
	if (["bugfix", "config", "api"].includes(constraintProfile?.queryMode) && !sources.some((source) => source.resultType === "configuration-reference" || source.resultType === "api-reference" || source.resultType === "troubleshooting")) {
		outputs.push("The final bundle lacks a clearly exact reference/troubleshooting page, so verify config/API details manually.");
	}
	return outputs;
}

function buildGaps(sources, confidence, constraintProfile) {
	const gaps = [];
	if (sources.length < 3) gaps.push("Fewer than three strong sources were retrieved.");
	if (confidence === "low") gaps.push("Evidence diversity is limited; validate important claims manually.");
	if (!sources.some((source) => isAuthoritativeCategory(source.sourceCategory))) {
		gaps.push("No clearly authoritative source was automatically identified.");
	}
	if (["repo", "release", "migration", "config", "api"].includes(constraintProfile?.queryMode) && (constraintProfile?.exactTerms || []).length > 0 && !sources.some((source) => exactTermsMatchSource(source, constraintProfile.exactTerms))) {
		gaps.push("No selected source matched the strongest exact technical identifier from the query.");
	}
	return gaps;
}

function computeConfidence(sources, constraintProfile) {
	if (sources.length === 0) return "low";
	const authoritativeCount = sources.filter((source) => isAuthoritativeCategory(source.sourceCategory)).length;
	const diverseDomains = new Set(sources.map((source) => source.domain).filter(Boolean)).size;
	const exactCoverage = (constraintProfile?.exactTerms || []).length === 0 || sources.some((source) => exactTermsMatchSource(source, constraintProfile.exactTerms));
	if (sources.length >= 5 && authoritativeCount >= 2 && diverseDomains >= 3 && exactCoverage) return "high";
	if (sources.length >= 3 && authoritativeCount >= 1 && exactCoverage) return "medium";
	return authoritativeCount >= 1 ? "medium" : "low";
}

function excerptLength(depth) {
	switch (depth) {
		case "brief":
			return 600;
		case "deep":
			return 2600;
		default:
			return 1400;
	}
}

function modeToSourceType(mode) {
	switch (mode) {
		case "news":
			return "news";
		case "technical":
		case "best-practice":
			return "docs";
		default:
			return "general";
	}
}

function inferResearchSourceType(mode, _intent) {
	if (mode === "news") return "news";
	if (mode === "technical" || mode === "best-practice") return "docs";
	return modeToSourceType(mode);
}

async function performResearchDiscovery(config, params, questionPlan, helpers) {
	const searchConfigs = buildResearchSearchConfigs(params, questionPlan);
	const allResults = [];
	const allErrors = [];
	const diagnostics = [];
	for (const searchConfig of searchConfigs) {
		const result = await searchWorkflow(config, searchConfig, helpers);
		allResults.push(...(result.results || []));
		allErrors.push(...(result.errors || []));
		diagnostics.push({ label: searchConfig.label, sourceType: searchConfig.sourceType, diagnostics: result.diagnostics || result.metadata?.diagnostics });
	}
	const primarySourceType = inferResearchSourceType(params.mode, questionPlan.intent);
	const ranked = rankSearchResults(allResults, {
		query: params.question,
		freshness: params.freshness,
		maxResults: Math.max(params.numberOfSources * 4, params.numberOfSources + 4),
		preferredDomains: params.preferredDomains || [],
		blockedDomains: params.blockedDomains || [],
		sourceType: primarySourceType,
		constraintProfile: questionPlan.constraintProfile,
	});
	return {
		status: ranked.length === 0 ? (allErrors.length ? "failure" : "no_results") : (allErrors.length ? "partial_success" : "success"),
		results: ranked,
		errors: allErrors,
		diagnostics: {
			plan: questionPlan,
			searches: diagnostics,
		},
	};
}

function buildResearchSearchConfigs(params, questionPlan) {
	const baseQuery = questionPlan.searchQuery || params.question;
	const base = {
		query: baseQuery,
		freshness: params.freshness,
		maxResults: Math.max(params.numberOfSources * 4, params.numberOfSources + 4),
		preferredDomains: params.preferredDomains || [],
		blockedDomains: params.blockedDomains || [],
		signal: params.signal,
	};
	const configs = [];
	const primarySourceType = inferResearchSourceType(params.mode, questionPlan.intent);
	configs.push({ ...base, sourceType: primarySourceType, label: "primary" });
	if (["migration", "technical-change"].includes(questionPlan.constraintProfile?.queryMode)) {
		configs.push({ ...base, query: `${baseQuery} migration guide release notes`, sourceType: "docs", label: "migration-anchor" });
	}
	if (["config", "api"].includes(questionPlan.constraintProfile?.queryMode)) {
		configs.push({ ...base, query: `${baseQuery} official reference`, sourceType: "docs", label: "reference-anchor" });
	}
	if (questionPlan.constraintProfile?.queryMode === "architecture") {
		configs.push({ ...base, query: `${baseQuery} prescriptive guidance trade-offs compare`, sourceType: "docs", label: "architecture-anchor" });
		configs.push({ ...base, query: `${baseQuery} architecture best practices`, sourceType: "general", label: "architecture-support" });
	}
	if (questionPlan.constraintProfile?.queryMode === "novel-discovery") {
		configs.push({ ...base, query: `${baseQuery} official docs getting started`, sourceType: "docs", label: "discovery-docs" });
		configs.push({ ...base, query: `${baseQuery} github repo releases`, sourceType: "github", label: "discovery-github" });
		configs.push({ ...base, query: `${baseQuery} launch announcement blog`, sourceType: "general", label: "discovery-announcement" });
	}
	if (questionPlan.constraintProfile?.needsGithubEvidence) {
		configs.push({ ...base, query: `${baseQuery} github issues discussions releases`, sourceType: "github", label: "github-support" });
	}
	if (questionPlan.constraintProfile?.queryMode === "repo") {
		configs.push({ ...base, query: `${baseQuery} github repository`, sourceType: "github", label: "repo-anchor" });
	}
	if (questionPlan.constraintProfile?.queryMode === "release") {
		configs.push({ ...base, query: `${baseQuery} release notes changelog`, sourceType: "github", label: "release-anchor" });
	}
	return dedupeSearchConfigs(configs);
}

function dedupeSearchConfigs(configs) {
	const seen = new Set();
	const output = [];
	for (const config of configs) {
		const key = JSON.stringify([config.query, config.sourceType, (config.preferredDomains || []).join(","), (config.blockedDomains || []).join(",")]);
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(config);
	}
	return output;
}

function shouldUseGitHubSupplement(plan, params) {
	return params.sourceType === "github" || plan.constraintProfile?.needsGithubEvidence || plan.intent === "github";
}

function modeToProfile(mode) {
	switch (mode) {
		case "news":
			return "article";
		case "technical":
		case "best-practice":
			return "docs";
		default:
			return "generic";
	}
}

function passesResearchPrecisionGate(source, constraintProfile) {
	if (!constraintProfile) return true;
	const domain = String(source.domain || "").toLowerCase();
	const conciseHaystack = [source.title, source.snippet, source.url, source.publishedAt].filter(Boolean).join(" ").toLowerCase();
	if ((constraintProfile.explicitSites || []).length > 0) {
		const domainMatch = constraintProfile.explicitSites.some((site) => domain === site || domain.endsWith(`.${site}`));
		if (!domainMatch) return false;
	}
	if ((constraintProfile.preferredDomains || []).length > 0 && constraintProfile.requiresOfficialSource) {
		const preferredMatch = constraintProfile.preferredDomains.some((site) => domainMatches(domain, site));
		if (!preferredMatch && !isAuthoritativeCategory(source.sourceCategory)) return false;
	}
	if ((constraintProfile.years || []).length > 0) {
		const yearHits = (constraintProfile.years || []).filter((year) => conciseHaystack.includes(year)).length;
		if (yearHits === 0) return false;
	}
	for (const group of constraintProfile.topicalGroups || []) {
		const matched = group.terms.some((term) => conciseHaystack.includes(term));
		if (group.strict && !matched) return false;
	}
	for (const entity of constraintProfile.entities || []) {
		if (!conciseHaystack.includes(entity)) return false;
	}
	if ((constraintProfile.exactTerms || []).length > 0 && ["config", "api", "bugfix", "repo", "release", "migration"].includes(constraintProfile.queryMode)) {
		if (!exactTermsMatchSource(source, constraintProfile.exactTerms)) return false;
	}
	return true;
}

function selectResearchSources(candidates, maxSources, constraintProfile) {
	const pool = [...candidates];
	const selected = [];
	const selectionReasons = [];
	const anchor = pickAnchorSource(pool, constraintProfile);
	if (anchor) {
		selected.push(anchor);
		selectionReasons.push({ url: anchor.url, reason: "anchor-source" });
	}
	for (const picker of buildCoveragePickers(constraintProfile)) {
		const match = pool.find((candidate) => !selected.some((item) => item.url === candidate.url) && picker.test(candidate));
		if (match) {
			selected.push(match);
			selectionReasons.push({ url: match.url, reason: picker.reason });
		}
		if (selected.length >= maxSources) break;
	}
	for (const candidate of orderSelectionPool(pool, anchor, constraintProfile)) {
		if (selected.length >= maxSources) break;
		if (selected.some((item) => item.url === candidate.url)) continue;
		if (selected.some((item) => item.domain && candidate.domain && item.domain === candidate.domain) && !shouldAllowSameDomain(candidate, constraintProfile, anchor)) continue;
		selected.push(candidate);
		selectionReasons.push({ url: candidate.url, reason: anchor?.domain && candidate.domain === anchor.domain ? "anchor-domain-support" : "score-fill" });
	}
	return {
		sources: selected.slice(0, maxSources),
		anchorUrl: anchor?.url,
		anchorTitle: anchor?.title,
		reasons: selectionReasons,
	};
}

function pickAnchorSource(candidates, constraintProfile) {
	if (candidates.length === 0) return undefined;
	const scored = candidates.map((candidate) => ({ candidate, score: anchorScore(candidate, constraintProfile) }));
	scored.sort((a, b) => b.score - a.score);
	return scored[0]?.candidate;
}

function anchorScore(source, constraintProfile) {
	let score = Number(source.score || 0);
	if (isAuthoritativeCategory(source.sourceCategory)) score += 12;
	if (matchesPreferredDomains(source, constraintProfile?.preferredDomains || [])) score += 12;
	if (exactTermsMatchSource(source, constraintProfile?.exactTerms || [])) score += 18;
	switch (constraintProfile?.canonicalPreference || constraintProfile?.queryMode) {
		case "migration":
			if (source.resultType === "migration-guide") score += 30;
			if (["release-notes", "github-releases"].includes(source.resultType)) score += 18;
			break;
		case "config":
			if (source.resultType === "configuration-reference") score += 30;
			if (source.resultType === "api-reference") score += 18;
			break;
		case "api":
			if (source.resultType === "api-reference") score += 28;
			if (source.resultType === "configuration-reference") score += 12;
			break;
		case "repo":
			if (source.resultType === "repository-home") score += 30;
			break;
		case "release":
			if (["github-releases", "release-notes"].includes(source.resultType)) score += 28;
			break;
		case "architecture":
			if (source.resultType === "architecture-guide") score += 26;
			break;
		case "novel-discovery":
			if (["getting-started", "announcement", "repository-home", "github-releases", "release-notes"].includes(source.resultType)) score += 24;
			break;
		case "bugfix":
			if (["troubleshooting", "api-reference", "configuration-reference", "github-issue", "github-discussion"].includes(source.resultType)) score += 20;
			break;
	}
	return score;
}

function buildCoveragePickers(constraintProfile) {
	const queryMode = constraintProfile?.queryMode;
	if (queryMode === "migration" || queryMode === "technical-change") {
		return [
			{ reason: "official-migration-doc", test: (source) => ["migration-guide", "release-notes", "github-releases"].includes(source.resultType) && isAuthoritativeCategory(source.sourceCategory) },
			{ reason: "community-upgrade-signal", test: (source) => ["github-issue", "github-discussion", "vendor-blog"].includes(source.sourceCategory) || ["github-issue", "github-discussion"].includes(source.resultType) },
		];
	}
	if (queryMode === "bugfix") {
		return [
			{ reason: "exact-reference", test: (source) => ["configuration-reference", "api-reference", "troubleshooting"].includes(source.resultType) },
			{ reason: "community-bug-signal", test: (source) => ["github-issue", "github-discussion"].includes(source.resultType) },
		];
	}
	if (queryMode === "architecture") {
		return [
			{ reason: "official-architecture-doc", test: (source) => source.resultType === "architecture-guide" && isAuthoritativeCategory(source.sourceCategory) },
			{ reason: "supporting-official-doc", test: (source) => isAuthoritativeCategory(source.sourceCategory) },
		];
	}
	if (queryMode === "novel-discovery") {
		return [
			{ reason: "official-discovery-doc", test: (source) => ["getting-started", "guide", "announcement"].includes(source.resultType) && isAuthoritativeCategory(source.sourceCategory) },
			{ reason: "repo-signal", test: (source) => ["repository-home", "github-releases"].includes(source.resultType) },
		];
	}
	if (queryMode === "repo") {
		return [
			{ reason: "canonical-repo", test: (source) => source.resultType === "repository-home" },
			{ reason: "release-surface", test: (source) => source.resultType === "github-releases" },
		];
	}
	if (queryMode === "release") {
		return [
			{ reason: "release-anchor", test: (source) => ["github-releases", "release-notes"].includes(source.resultType) },
			{ reason: "repo-home", test: (source) => source.resultType === "repository-home" },
		];
	}
	if (["config", "api"].includes(queryMode)) {
		return [
			{ reason: "exact-reference", test: (source) => ["configuration-reference", "api-reference"].includes(source.resultType) },
			{ reason: "troubleshooting-support", test: (source) => ["troubleshooting", "github-issue", "github-discussion"].includes(source.resultType) },
		];
	}
	return [
		{ reason: "authoritative-support", test: (source) => isAuthoritativeCategory(source.sourceCategory) },
	];
}

function orderSelectionPool(pool, anchor, constraintProfile) {
	return [...pool].sort((a, b) => selectionPreferenceScore(b, anchor, constraintProfile) - selectionPreferenceScore(a, anchor, constraintProfile));
}

function selectionPreferenceScore(candidate, anchor, constraintProfile) {
	let score = Number(candidate.score || 0);
	if (anchor?.domain && candidate.domain === anchor.domain) score += 18;
	if (matchesPreferredDomains(candidate, constraintProfile?.preferredDomains || [])) score += 12;
	if (exactTermsMatchSource(candidate, constraintProfile?.exactTerms || [])) score += 10;
	if (["migration", "technical-change", "config", "api"].includes(constraintProfile?.queryMode) && candidate.sourceCategory === "official-docs") score += 8;
	return score;
}

function shouldAllowSameDomain(candidate, constraintProfile, anchor) {
	if (["repo", "release", "config", "api", "migration", "technical-change", "novel-discovery"].includes(constraintProfile?.queryMode)) return true;
	if (anchor?.domain && candidate.domain === anchor.domain) return true;
	if (candidate.sourceCategory && isAuthoritativeCategory(candidate.sourceCategory)) return true;
	return false;
}

function matchesPreferredDomains(source, preferredDomains) {
	return (preferredDomains || []).some((domain) => domainMatches(source.domain || hostnameFromUrl(source.url || ""), domain));
}

function exactTermsMatchSource(source, exactTerms) {
	if (!exactTerms?.length) return false;
	const haystack = compactText([source.title, source.url, source.snippet, source.excerpt].filter(Boolean).join(" "));
	return exactTerms.some((term) => haystack.includes(compactText(term)));
}

function compactText(value) {
	return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function describeLeadSource(source, constraintProfile) {
	if (!source) return undefined;
	const parts = [source.resultType, source.sourceCategory].filter(Boolean);
	if (constraintProfile?.canonicalPreference && source.resultType) {
		parts.unshift(`matched-${constraintProfile.canonicalPreference}`);
	}
	return parts.join(", ");
}

function shouldUseBrowserFallback(config, mode, direct) {
	if (!config.playwrightEnabled) return false;
	if (mode === "rendered") return true;
	if (config.browserMode === "always") return true;
	if (mode === "fast") return false;
	return !direct.content || direct.content.length < 500;
}

async function memo(helpers, namespace, key, ttlMs, compute) {
	if (!helpers.cache?.enabled) {
		return { value: await compute(), cache: { hit: false, namespace, key, enabled: false } };
	}
	const result = await helpers.cache.memo(namespace, key, ttlMs, compute);
	return { value: result.value, cache: { ...result.cache, enabled: true } };
}

function withFetchMetadata(result, extra) {
	return {
		...result,
		metadata: {
			...(result.metadata || {}),
			...extra,
		},
	};
}

function buildTrace(helpers) {
	return { requestId: helpers.requestId };
}

function buildCodeAwareMetadata(html, content, extractionProfile) {
	if (!html || !["docs", "release-note", "generic"].includes(extractionProfile)) return undefined;
	const headings = extractHeadings(html, 8);
	const codeSnippets = extractCodeBlocks(html, 4).map((item) => clip(item, 240));
	const callouts = extractCallouts(content, 6).map((item) => clip(item, 240));
	return {
		headings,
		codeSnippets,
		callouts,
	};
}

function computePreferredDomainHitRatio(results, preferredDomains) {
	if (!preferredDomains?.length || !results?.length) return 0;
	const preferred = preferredDomains.map((value) => String(value).toLowerCase());
	const hits = results.filter((item) => preferred.some((domain) => String(item.domain || "").toLowerCase() === domain || String(item.domain || "").toLowerCase().endsWith(`.${domain}`))).length;
	return Number((hits / results.length).toFixed(3));
}

function summarizeDomains(results) {
	const counts = {};
	for (const item of results || []) {
		const domain = item.domain || "unknown";
		counts[domain] = (counts[domain] || 0) + 1;
	}
	return counts;
}
