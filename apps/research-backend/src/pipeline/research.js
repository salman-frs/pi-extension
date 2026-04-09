import { fetchRenderedPage } from "../adapters/browser/playwright.js";
import { searchSearxng } from "../adapters/discovery/searxng.js";
import { searchGitHubWeb } from "../adapters/discovery/github-web.js";
import { fetchDirect } from "../adapters/extraction/direct.js";
import { extractStructuredContent } from "../adapters/extraction/structured.js";
import { classifyFetchError } from "../errors.js";
import { stableCacheKey } from "../lib/cache.js";
import { summarizeTrace, traceStep } from "../lib/tracing.js";
import { buildQueryPlan } from "../query-planner.js";
import { bestSentences, cleanupWhitespace, extractCallouts, extractCanonicalUrl, extractCodeBlocks, extractHeadings, extractTitle, htmlToText, splitSentences, topKeywords } from "../lib/text.js";
import { clip, comparableUrlKey, domainMatches, hostnameFromUrl } from "../lib/utils.js";
import { detectDisagreementSignals, rankFetchedSources, rankSearchResults, summarizeSourceCategories, summarizeSourceTypes } from "../ranking.js";
import { resolveCanonicalSearchResults } from "../canonical-resolver.js";
import { buildTrustSignals, classifySourceCategory, inferSourceType, isAuthoritativeCategory } from "../source-quality.js";

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
		async () => traceStep(helpers, "search.workflow", { query: params.query, sourceType: params.sourceType }, async () => {
			const providerResults = [];
			const providerErrors = [];
			const diagnostics = { plan, providers: [] };

			const searx = await traceStep(helpers, "search.provider.searxng", { queryCount: plan.variants?.length || 0 }, () => searchSearxng(config, params, plan, helpers.fetchWithTimeout, helpers.logger, helpers.requestId, helpers.telemetry, helpers.trace));
			providerResults.push(...searx.results);
			providerErrors.push(...(searx.errors || []));
			diagnostics.providers.push({ name: "searxng", status: searx.status, diagnostics: searx.diagnostics });

			if (shouldUseGitHubSupplement(plan, params)) {
				const githubStartedAt = Date.now();
				const github = await traceStep(helpers, "search.provider.github", { intent: plan.intent }, () => searchGitHubWeb(config, params, plan, helpers.fetchWithTimeout, helpers.logger, helpers.requestId));
				providerResults.push(...github.results);
				providerErrors.push(...(github.errors || []));
				diagnostics.providers.push({ name: "github-web", status: github.status, diagnostics: github.diagnostics });
				helpers.telemetry?.recordProviderResult?.("github-web", { ok: github.status !== "failure", status: github.status, latencyMs: Date.now() - githubStartedAt, error: github.errors?.[0]?.message });
			}

			const ranked = resolveCanonicalSearchResults(
				rankSearchResults(providerResults, { ...params, constraintProfile: plan.constraintProfile }).slice(0, params.maxResults || 8),
				{ ...params, constraintProfile: plan.constraintProfile },
			);
			const successProviders = diagnostics.providers.filter((item) => item.status === "success" || item.status === "partial_success").length;
			const status = ranked.length === 0
				? (providerErrors.length > 0 ? "failure" : "no_results")
				: (providerErrors.length > 0 ? "partial_success" : "success");
			helpers.telemetry?.addEvent?.(helpers.trace, "search.completed", { status, resultCount: ranked.length, successProviders });
			return {
				status,
				results: ranked,
				errors: providerErrors,
				diagnostics: {
					...diagnostics,
					successProviders,
				},
			};
		}),
	);
	if (value.status === "failure") {
		helpers.cache?.delete?.("search", key);
	}
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

	const directMemo = async () => traceStep(helpers, "fetch.direct", { url: params.url, extractionProfile: params.extractionProfile }, async () => {
		const direct = await fetchDirect(config, params.url, params.extractionProfile, helpers.fetchWithTimeout, params.signal);
		const content = clip(direct.text, 16000);
		const extractionConfidence = direct.metadata?.extractionConfidence || inferExtractionConfidence(content);
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
				strategy: direct.metadata?.strategy || (direct.variant?.startsWith("docs-markdown") ? "docs-markdown-fetch" : "direct-fetch"),
				sourceVariant: direct.variant,
				resolvedUrl: direct.resolvedUrl,
				frameworkHints: direct.metadata?.frameworkHints || [],
				extractionConfidence,
				shellLikelihood: direct.metadata?.shellLikelihood,
				fallbackRecommendations: buildFetchFallbackRecommendations({
					mode: params.mode,
					extractionConfidence,
					shellLikelihood: direct.metadata?.shellLikelihood,
					frameworkHints: direct.metadata?.frameworkHints,
					strategy: direct.metadata?.strategy,
				}),
				codeAware: buildCodeAwareMetadata(direct.html, content, params.extractionProfile),
				diagnostics: direct.metadata?.diagnostics,
			},
		};
	});

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
	const { value, cache } = await memo(helpers, "research", key, config.researchCacheTtlMs, async () => traceStep(helpers, "research.workflow", { question: params.question, mode: params.mode }, async () => {
		let search;
		const failures = [];
		try {
			search = await traceStep(helpers, "research.discovery", { question: params.question }, () => performResearchDiscovery(config, params, questionPlan, helpers));
		} catch (error) {
			failures.push(normalizeFailure("discovery", error, { question: params.question }));
			search = { status: "failure", results: [], errors: failures, diagnostics: { plan: questionPlan, searches: [] } };
		}
		const initialCandidates = (search.results || []).slice(0, Math.min(config.maxFetchedSources, Math.max(params.numberOfSources * 2, params.numberOfSources + 4, 6)));
		const fetched = [];
		for (const candidate of initialCandidates) {
			try {
				const page = await fetchWorkflow(config, {
					url: candidate.url,
					mode: "auto",
					extractionProfile: modeToProfile(params.mode),
					signal: params.signal,
				}, helpers);
				const identity = chooseFetchedSourceIdentity(candidate, page);
				fetched.push({
					title: identity.title,
					url: identity.url,
					domain: hostnameFromUrl(identity.url),
					sourceType: candidate.sourceType || inferSourceType(candidate.url),
					sourceCategory: candidate.sourceCategory || classifySourceCategory(candidate),
					resultType: candidate.resultType,
					publishedAt: candidate.publishedAt,
					snippet: candidate.snippet,
					excerpt: clip(page.content, excerptLength(params.outputDepth)),
					fetchMode: page.fetchMode,
					fetchStrategy: page.metadata?.strategy,
					trustSignals: {
						...buildTrustSignals({
							url: identity.url,
							sourceCategory: candidate.sourceCategory || classifySourceCategory(candidate),
							publishedAt: candidate.publishedAt,
						}),
						extractionConfidence: page.metadata?.extractionConfidence || inferExtractionConfidence(page.content),
					},
					ranking: candidate.ranking,
				});
			} catch (error) {
				failures.push(normalizeFailure("fetch", error, { url: candidate.url, title: candidate.title }));
				fetched.push({
					title: candidate.title,
					url: candidate.url,
					domain: candidate.domain,
					sourceType: candidate.sourceType || inferSourceType(candidate.url),
					sourceCategory: candidate.sourceCategory || classifySourceCategory(candidate),
					resultType: candidate.resultType,
					publishedAt: candidate.publishedAt,
					snippet: candidate.snippet,
					trustSignals: buildTrustSignals({
						url: candidate.url,
						sourceCategory: candidate.sourceCategory || classifySourceCategory(candidate),
						publishedAt: candidate.publishedAt,
					}),
					ranking: candidate.ranking,
				});
			}
		}

		const candidateRanking = rankFetchedSources(fetched, questionPlan.searchQuery || params.question, params.preferredDomains || [], questionPlan.constraintProfile);
		const precisionFiltered = candidateRanking.filter((source) => passesResearchPrecisionGate(source, questionPlan.constraintProfile, candidateRanking));
		const prioritized = precisionFiltered.length > 0 ? precisionFiltered : candidateRanking;
		const selection = selectResearchSources(prioritized, params.numberOfSources, questionPlan.constraintProfile);
		const ranked = selection.sources;
		const findings = buildFindings(questionPlan.searchQuery || params.question, ranked);
		const keywords = topKeywords(ranked.map((source) => [source.title, source.snippet, source.excerpt].filter(Boolean).join(" ")), 8);
		const sourceTypes = summarizeSourceTypes(ranked);
		const sourceCategories = summarizeSourceCategories(ranked);
		const agreements = buildAgreements(ranked, keywords, questionPlan.constraintProfile, selection);
		const disagreements = buildDisagreements(ranked, params.mode, questionPlan.constraintProfile, selection);
		const confidence = computeConfidence(ranked, questionPlan.constraintProfile, selection);
		const traceGrades = gradeResearchTrace({
			candidates: candidateRanking,
			filteredCandidates: prioritized,
			selection,
			sources: ranked,
			constraintProfile: questionPlan.constraintProfile,
			failures: [...(search.errors || []), ...failures],
			confidence,
		});
		const retrySuggestions = buildRetrySuggestions({ failures: [...(search.errors || []), ...failures], ranked, mode: params.mode, constraintProfile: questionPlan.constraintProfile, traceGrades });
		const recommendation = buildRecommendation({ ...params, question: questionPlan.searchQuery || params.question }, ranked, questionPlan.constraintProfile, selection);
		const bestPractices = buildBestPractices(questionPlan.searchQuery || params.question, ranked, questionPlan.constraintProfile, selection);
		const tradeOffs = buildTradeOffs(questionPlan.searchQuery || params.question, ranked, questionPlan.constraintProfile, selection);
		const risks = buildRisks(questionPlan.searchQuery || params.question, ranked, questionPlan.constraintProfile, selection);
		const mitigations = buildMitigations(questionPlan.searchQuery || params.question, ranked, questionPlan.constraintProfile, selection);
		const selectionRationale = buildSelectionRationale(selection, ranked, questionPlan.constraintProfile);
		const confidenceRationale = buildConfidenceRationale(confidence, ranked, questionPlan.constraintProfile, [...(search.errors || []), ...failures], selection, traceGrades);
		const freshnessRationale = buildFreshnessRationale(ranked, params.freshness, questionPlan.constraintProfile, selection);
		const gaps = buildGaps(ranked, confidence, questionPlan.constraintProfile, [...(search.errors || []), ...failures], selection, traceGrades);
		const status =
			search.status === "failure" && ranked.length === 0
				? "failure"
				: search.status === "no_results" && ranked.length === 0
					? "no_results"
					: ((search.errors?.length || failures.length) ? "partial_success" : "success");
		helpers.telemetry?.addEvent?.(helpers.trace, "research.synthesis", { status, sourceCount: ranked.length, confidence });
		return {
			status,
			answer: buildAnswer({ ...params, question: questionPlan.searchQuery || params.question }, ranked, agreements, disagreements, questionPlan.constraintProfile),
			recommendation,
			summary: buildSummary(params, ranked, sourceTypes, sourceCategories, keywords, selection),
			findings,
			bestPractices,
			tradeOffs,
			risks,
			mitigations,
			selectionRationale,
			confidenceRationale,
			freshnessRationale,
			agreements,
			disagreements,
			sources: ranked,
			confidence,
			gaps,
			failures: [...(search.errors || []), ...failures],
			retrySuggestions,
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
				traceGrades,
				queryPlan: questionPlan,
				taskProfile: questionPlan.constraintProfile?.taskProfile,
				partialResult: status === "partial_success",
				rationales: {
					selection: selectionRationale,
					confidence: confidenceRationale,
					freshness: freshnessRationale,
				},
			},
		};
	}));
	if (value.status === "failure") {
		helpers.cache?.delete?.("research", key);
	}
	helpers.logger?.info("research.completed", {
		requestId: helpers.requestId,
		question: params.question,
		mode: params.mode,
		sourceCount: value.sources?.length || 0,
		cacheHit: cache.hit,
		confidence: value.confidence,
		status: value.status,
		failureCount: value.failures?.length || 0,
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
	const { value, cache } = await memo(helpers, "rendered-fetch", renderedKey, config.renderedFetchCacheTtlMs, async () => traceStep(helpers, "fetch.rendered", { url: params.url, extractionProfile: params.extractionProfile }, async () => {
		const rendered = await fetchRenderedPage(config, params.url);
		const structured = config.structuredExtractionEnabled ? extractStructuredContent(rendered.html, { url: params.url, extractionProfile: params.extractionProfile, variant: "rendered" }) : undefined;
		const content = clip(structured?.content || htmlToText(rendered.html), 16000);
		return {
			url: params.url,
			canonicalUrl: extractCanonicalUrl(rendered.html) ?? params.url,
			title: rendered.title ?? extractTitle(rendered.html),
			content,
			extractionProfile: params.extractionProfile,
			fetchMode: "rendered",
			contentType: "text/html",
			status: 200,
			metadata: {
				strategy: structured ? "playwright-structured-extractor" : "playwright-fallback",
				extractionConfidence: structured?.diagnostics?.extractionConfidence || inferExtractionConfidence(content),
				frameworkHints: structured?.frameworkHints || [],
				fallbackRecommendations: [],
				codeAware: buildCodeAwareMetadata(rendered.html, content, params.extractionProfile),
				diagnostics: structured?.diagnostics,
			},
		};
	}));
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
		selection?.taskProfile ? `Task profile: ${selection.taskProfile}.` : undefined,
		selection?.anchorTitle ? `Anchor source: ${selection.anchorTitle}.` : undefined,
		`Source mix: ${sourceTypes.length > 0 ? sourceTypes.join(", ") : "general"}.`,
		sourceCategories.length > 0 ? `Source categories: ${sourceCategories.join(", ")}.` : undefined,
		keywords.length > 0 ? `Dominant themes detected: ${keywords.join(", ")}.` : undefined,
		params.sourcePolicy ? `Source policy guidance applied: ${params.sourcePolicy}.` : undefined,
	].filter(Boolean).join(" ");
}

function buildSelectionRationale(selection, sources, constraintProfile) {
	if (!sources?.length) return "No source selection rationale is available because no sources were selected.";
	const anchor = selection?.anchorTitle || sources[0]?.title || sources[0]?.url;
	const exactCoverage = (constraintProfile?.exactTerms || []).length === 0 || sources.some((source) => exactTermsMatchSource(source, constraintProfile?.exactTerms || []));
	const canonicalProof = selection?.canonicalProof;
	const bundleCoverage = selection?.bundleCoverage;
	return [
		anchor ? `Anchor chosen: ${anchor}.` : undefined,
		selection?.taskProfile ? `Task profile: ${selection.taskProfile}.` : undefined,
		selection?.anchorType ? `Anchor type: ${selection.anchorType}.` : undefined,
		selection?.anchorDomain ? `Anchor domain: ${selection.anchorDomain}.` : undefined,
		canonicalProof?.anchorQuality ? `Canonical proof: ${canonicalProof.anchorQuality} anchor quality.` : undefined,
		exactCoverage ? "The selected bundle covers the strongest exact identifiers or canonical hints found in the query." : "The bundle is useful, but exact identifier coverage is incomplete.",
		(bundleCoverage?.missingRoles || []).length === 0 ? "The selected source mix satisfies the expected evidence roles for this task family." : `The selected source mix is still missing: ${bundleCoverage.missingRoles.join(", ")}.`,
	].filter(Boolean).join(" ");
}

function buildConfidenceRationale(confidence, sources, constraintProfile, failures, selection, traceGrades) {
	if (!sources?.length) return "Confidence is low because no usable evidence was retrieved.";
	const authoritativeCount = sources.filter((source) => isAuthoritativeCategory(source.sourceCategory)).length;
	const domainCount = new Set(sources.map((source) => source.domain).filter(Boolean)).size;
	const failedTraceChecks = traceGrades?.failures?.length || 0;
	return [
		`Confidence is ${confidence} based on ${sources.length} selected source(s), ${authoritativeCount} authoritative source(s), and ${domainCount} distinct domain(s).`,
		(constraintProfile?.exactTerms || []).length > 0 ? (sources.some((source) => exactTermsMatchSource(source, constraintProfile.exactTerms)) ? "At least one selected source matches the strongest exact technical identifier from the query." : "No selected source matched the strongest exact technical identifier from the query.") : undefined,
		(selection?.canonicalProof?.anchorQuality === "strong") ? "The selected anchor passed the strongest canonical-exactness checks for this task." : undefined,
		(selection?.bundleCoverage?.missingRoles || []).length > 0 ? `The bundle is missing expected evidence roles (${selection.bundleCoverage.missingRoles.join(", ")}), so confidence is intentionally limited.` : undefined,
		failedTraceChecks > 0 ? `${failedTraceChecks} retrieval trace quality check(s) failed, which reduced confidence.` : undefined,
		(failures || []).length > 0 ? `${failures.length} upstream search or fetch failure(s) reduced confidence.` : undefined,
	].filter(Boolean).join(" ");
}

function buildFreshnessRationale(sources, freshness, constraintProfile, selection) {
	if (!sources?.length) return "No freshness rationale is available because no sources were selected.";
	const dated = sources.filter((source) => source.publishedAt);
	if (dated.length === 0) return `Freshness preference was ${freshness}, but the selected sources did not expose reliable publish timestamps.`;
	const newest = [...dated].sort((a, b) => Date.parse(b.publishedAt || "") - Date.parse(a.publishedAt || ""))[0];
	return [
		`Freshness preference: ${freshness}.`,
		newest?.publishedAt ? `Newest dated evidence in the selected set: ${newest.publishedAt}.` : undefined,
		["release", "migration", "technical-change"].includes(constraintProfile?.queryMode) ? "Recency was weighted more heavily because the task looks change-sensitive." : undefined,
		selection?.taskProfile === "migration-impact" || selection?.taskProfile === "release-change" ? "Release and migration evidence was favored because the task is likely sensitive to version changes." : undefined,
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

function buildRecommendation(params, sources, constraintProfile, selection) {
	if (sources.length === 0) {
		return `No grounded recommendation is available for “${params.question}” because no usable sources were retrieved.`;
	}
	const lead = sources[0];
	const authoritativeCount = sources.filter((source) => isAuthoritativeCategory(source.sourceCategory)).length;
	const exactCoverage = exactTermsMatchSource(lead, constraintProfile?.exactTerms || []);
	const recommendationLead = lead?.title ? `Prefer starting from ${lead.title}` : "Start from the highest-ranked source";
	const authorityClause = authoritativeCount > 0 ? ` because ${authoritativeCount} primary or authoritative source(s) support the bundle` : " because the available evidence is limited";
	const verificationClause = exactCoverage || (constraintProfile?.exactTerms || []).length === 0
		? " and use the supporting sources to validate trade-offs and edge cases."
		: ", but verify the exact technical identifier manually before acting.";
	const bundleClause = (selection?.bundleCoverage?.missingRoles || []).length === 0
		? ""
		: ` Also validate missing evidence roles (${selection.bundleCoverage.missingRoles.join(", ")}) before finalizing the decision.`;
	return `${recommendationLead}${authorityClause}${verificationClause}${bundleClause}`;
}

function buildBestPractices(question, sources, constraintProfile, selection) {
	const signals = collectSourceSignals(question, sources, {
		patterns: [/\bshould\b/i, /\brecommend(?:ed|s)?\b/i, /best practice/i, /\bprefer\b/i, /\buse\b/i, /\bvalidate\b/i, /\bdocument\b/i, /\bobservability\b/i],
		limit: 4,
	});
	if (signals.length > 0) return signals;
	const fallbacks = [];
	if (sources.some((source) => isAuthoritativeCategory(source.sourceCategory))) {
		fallbacks.push("Use authoritative docs or primary sources as the implementation anchor before applying community guidance.");
	}
	if (["architecture", "technical-change", "migration"].includes(constraintProfile?.queryMode)) {
		fallbacks.push("Validate operational trade-offs and rollout implications before committing to the recommended path.");
	}
	if ((selection?.bundleCoverage?.missingRoles || []).length > 0) {
		fallbacks.push(`Fill the remaining evidence gaps for this task family before turning the research bundle into implementation guidance (${selection.bundleCoverage.missingRoles.join(", ")}).`);
	}
	return uniqueNonEmpty(fallbacks).slice(0, 4);
}

function buildTradeOffs(question, sources, constraintProfile, selection) {
	const signals = collectSourceSignals(question, sources, {
		patterns: [/trade-?off/i, /\bhowever\b/i, /\bbut\b/i, /\bversus\b|\bvs\b/i, /\bcost\b/i, /\bcomplex(?:ity)?\b/i, /\blatency\b/i, /\bperformance\b/i, /\bflexib(?:le|ility)\b/i],
		limit: 4,
	});
	if (signals.length > 0) return signals;
	const fallbacks = [];
	if (sources.length >= 2) fallbacks.push("The retrieved sources emphasize different trade-offs, so compare canonical guidance with supporting evidence before deciding.");
	if (constraintProfile?.decisionMode) fallbacks.push("The best option depends on which trade-offs matter most for your runtime, complexity budget, and operational constraints.");
	if (selection?.taskProfile === "architecture-decision") fallbacks.push("Balance official prescriptive guidance with practitioner trade-offs before locking the architecture.");
	return uniqueNonEmpty(fallbacks).slice(0, 4);
}

function buildRisks(question, sources, constraintProfile, selection) {
	const signals = collectSourceSignals(question, sources, {
		patterns: [/\brisk/i, /\bcaveat/i, /warning/i, /deprecated/i, /breaking/i, /limitation/i, /edge case/i, /compatib(?:le|ility)/i, /security/i, /stale/i],
		limit: 4,
	});
	if (signals.length > 0) return signals;
	const fallbacks = [];
	if (["migration", "technical-change"].includes(constraintProfile?.queryMode)) {
		fallbacks.push("Upgrade and migration work carries compatibility risk if release notes and migration guidance are not validated together.");
	}
	if (["config", "api", "bugfix"].includes(constraintProfile?.queryMode)) {
		fallbacks.push("Exact config or API identifiers may still need manual verification against primary references before implementation.");
	}
	if (selection?.canonicalProof?.anchorQuality === "weak") {
		fallbacks.push("The selected anchor is only weakly canonical for the task, so implementation decisions should be verified manually.");
	}
	return uniqueNonEmpty(fallbacks).slice(0, 4);
}

function buildMitigations(question, sources, constraintProfile, selection) {
	const signals = collectSourceSignals(question, sources, {
		patterns: [/\bmitigat/i, /\bvalidate\b/i, /\btest\b/i, /\bphase(?:d)?\b/i, /\bstaging\b/i, /\brollback\b/i, /\bobserve\b/i, /\bmonitor/i, /\breview\b/i, /\bverify\b/i],
		limit: 4,
	});
	if (signals.length > 0) return signals;
	const fallbacks = [];
	fallbacks.push("Verify the recommended path against primary documentation before applying it broadly.");
	if (["migration", "technical-change"].includes(constraintProfile?.queryMode)) {
		fallbacks.push("Use staged rollout, observability, and rollback readiness when applying changes suggested by release or migration research.");
	}
	if ((selection?.bundleCoverage?.missingRoles || []).length > 0) {
		fallbacks.push(`Collect the missing evidence roles (${selection.bundleCoverage.missingRoles.join(", ")}) before treating the recommendation as final.`);
	}
	return uniqueNonEmpty(fallbacks).slice(0, 4);
}

function buildAgreements(sources, keywords, constraintProfile, selection) {
	const outputs = [];
	if (keywords.length > 0) outputs.push(`Repeated themes across sources include ${keywords.slice(0, 6).join(", ")}.`);
	const authoritative = sources.filter((source) => isAuthoritativeCategory(source.sourceCategory));
	if (authoritative.length > 0) outputs.push(`${authoritative.length} source(s) are classified as authoritative or primary evidence.`);
	if (constraintProfile?.canonicalPreference && sources[0]?.resultType) {
		outputs.push(`The selected anchor matches the expected result type family for this task (${sources[0].resultType}).`);
	}
	if (selection?.canonicalProof?.anchorQuality === "strong") {
		outputs.push("The selected anchor passed strong canonical-exactness checks for this task.");
	}
	return outputs;
}

function buildDisagreements(sources, mode, constraintProfile, selection) {
	const outputs = detectDisagreementSignals(sources);
	if (mode === "news" && sources.some((source) => !source.publishedAt)) {
		outputs.push("Some news-style sources did not expose clear publish timestamps, so recency ranking may be imperfect.");
	}
	if (["bugfix", "config", "api"].includes(constraintProfile?.queryMode) && !sources.some((source) => source.resultType === "configuration-reference" || source.resultType === "api-reference" || source.resultType === "troubleshooting" || source.resultType === "package-docs")) {
		outputs.push("The final bundle lacks a clearly exact reference/troubleshooting page, so verify config/API details manually.");
	}
	if ((selection?.bundleCoverage?.missingRoles || []).length > 0) {
		outputs.push(`The selected bundle is still missing expected evidence roles: ${selection.bundleCoverage.missingRoles.join(", ")}.`);
	}
	return outputs;
}

function buildGaps(sources, confidence, constraintProfile, failures = [], selection, traceGrades) {
	const gaps = [];
	if (sources.length < 3) gaps.push("Fewer than three strong sources were retrieved.");
	if (confidence === "low") gaps.push("Evidence diversity is limited; validate important claims manually.");
	if (!sources.some((source) => isAuthoritativeCategory(source.sourceCategory))) {
		gaps.push("No clearly authoritative source was automatically identified.");
	}
	if (["repo", "release", "migration", "config", "api"].includes(constraintProfile?.queryMode) && (constraintProfile?.exactTerms || []).length > 0 && !sources.some((source) => exactTermsMatchSource(source, constraintProfile.exactTerms))) {
		gaps.push("No selected source matched the strongest exact technical identifier from the query.");
	}
	if ((selection?.bundleCoverage?.missingRoles || []).length > 0) {
		gaps.push(`The selected source bundle is missing expected evidence roles: ${selection.bundleCoverage.missingRoles.join(", ")}.`);
	}
	if ((traceGrades?.failures || []).length > 0) {
		gaps.push(`Retrieval trace checks failed for: ${(traceGrades.failures || []).map((item) => item.class).join(", ")}.`);
	}
	if ((failures || []).length > 0) {
		gaps.push(`Some sources could not be searched or fetched automatically (${failures.length} failure${failures.length === 1 ? "" : "s"}).`);
	}
	return gaps;
}

function collectSourceSignals(question, sources, options = {}) {
	const patterns = Array.isArray(options.patterns) ? options.patterns : [];
	const limit = Number.isFinite(options.limit) ? options.limit : 4;
	const collected = [];
	for (const source of sources.slice(0, 5)) {
		const sentences = [
			...(bestSentences(source.excerpt || source.snippet || source.title || "", question, 3) || []),
			...splitSentences(source.excerpt || source.snippet || "").slice(0, 4),
		];
		for (const sentence of uniqueNonEmpty(sentences)) {
			if (!patterns.some((pattern) => pattern.test(sentence))) continue;
			collected.push(cleanSignalSentence(sentence, source.title || source.url));
			if (collected.length >= limit) return uniqueNonEmpty(collected).slice(0, limit);
		}
	}
	return uniqueNonEmpty(collected).slice(0, limit);
}

function cleanSignalSentence(sentence) {
	const cleaned = cleanupWhitespace(String(sentence || ""))
		.replace(/^[-*]\s*/, "")
		.replace(/\n+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	if (cleaned.length < 24) return undefined;
	if (/\b(search|learn|reference|community|blog|react@\d|skip to content)\b/i.test(cleaned) && cleaned.split(" ").length > 18) return undefined;
	const limitedByWords = cleaned.split(" ").slice(0, 40).join(" ");
	return limitedByWords.length > 220 ? `${limitedByWords.slice(0, 217)}...` : limitedByWords;
}

function uniqueNonEmpty(values) {
	return [...new Set((values || []).filter(Boolean))];
}

function computeConfidence(sources, constraintProfile, selection) {
	if (sources.length === 0) return "low";
	const authoritativeCount = sources.filter((source) => isAuthoritativeCategory(source.sourceCategory)).length;
	const diverseDomains = new Set(sources.map((source) => source.domain).filter(Boolean)).size;
	const exactCoverage = (constraintProfile?.exactTerms || []).length === 0 || sources.some((source) => exactTermsMatchSource(source, constraintProfile.exactTerms));
	const strongExactCoverage = (constraintProfile?.exactTerms || []).length === 0 || sources.some((source) => strongExactTermsMatchSource(source, constraintProfile.exactTerms));
	const missingRoles = selection?.bundleCoverage?.missingRoles || [];
	const canonicalStrength = selection?.canonicalProof?.anchorQuality || "weak";
	if (sources.length >= 5 && authoritativeCount >= 2 && diverseDomains >= 3 && strongExactCoverage && canonicalStrength === "strong" && missingRoles.length === 0) return "high";
	if (sources.length >= 3 && authoritativeCount >= 1 && exactCoverage && canonicalStrength !== "weak") return missingRoles.length === 0 ? "medium" : "low";
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
	const constraintProfile = questionPlan.constraintProfile || {};
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
	const addConfig = (query, sourceType, label, extra = {}) => {
		configs.push({
			...base,
			query,
			sourceType,
			label,
			preferredDomains: uniqueNonEmpty([...(base.preferredDomains || []), ...(extra.preferredDomains || [])]),
			blockedDomains: uniqueNonEmpty([...(base.blockedDomains || []), ...(extra.blockedDomains || [])]),
		});
	};

	addConfig(baseQuery, primarySourceType, "primary");

	if (["exact-docs"].includes(constraintProfile.taskProfile)) {
		addConfig(`${baseQuery} official reference`, "docs", "reference-anchor");
		for (const exactTerm of (constraintProfile.exactTerms || []).slice(0, 2)) {
			addConfig(`${baseQuery} "${exactTerm}" official docs`, "docs", `exact-reference-${exactTerm}`);
		}
	}
	if (["migration-impact"].includes(constraintProfile.taskProfile)) {
		addConfig(`${baseQuery} migration guide release notes`, "docs", "migration-anchor");
		addConfig(`${baseQuery} breaking changes changelog`, "docs", "release-evidence");
		addConfig(`${baseQuery} maintainer discussion compatibility`, "github", "migration-community");
	}
	if (["release-change"].includes(constraintProfile.taskProfile)) {
		addConfig(`${baseQuery} release notes changelog`, "docs", "release-anchor");
		addConfig(`${baseQuery} github releases`, "github", "release-github");
	}
	if (["bugfix-investigation"].includes(constraintProfile.taskProfile)) {
		addConfig(`${baseQuery} troubleshooting official docs`, "docs", "bugfix-reference");
		addConfig(`${baseQuery} github issue discussion`, "github", "bugfix-community");
	}
	if (["architecture-decision"].includes(constraintProfile.taskProfile)) {
		addConfig(`${baseQuery} prescriptive guidance trade-offs compare`, "docs", "architecture-anchor");
		addConfig(`${baseQuery} service quotas limitations`, "docs", "architecture-constraints");
		addConfig(`${baseQuery} architecture best practices tradeoffs`, "general", "architecture-support");
	}
	if (["official-vs-community"].includes(constraintProfile.taskProfile)) {
		addConfig(`${baseQuery} official docs`, "docs", "official-position");
		addConfig(`${baseQuery} community discussion forum`, "general", "community-position");
	}
	if (constraintProfile.queryMode === "novel-discovery") {
		addConfig(`${baseQuery} official docs getting started`, "docs", "discovery-docs");
		addConfig(`${baseQuery} github repo releases`, "github", "discovery-github");
		addConfig(`${baseQuery} launch announcement blog`, "general", "discovery-announcement");
	}
	if (constraintProfile.needsGithubEvidence) {
		addConfig(`${baseQuery} github issues discussions releases`, "github", "github-support");
	}
	if (constraintProfile.queryMode === "repo") {
		addConfig(`${baseQuery} github repository`, "github", "repo-anchor");
	}
	for (const hint of constraintProfile.ecosystemHints || []) {
		for (const queryHint of (hint.queryHints || []).slice(0, 4)) {
			addConfig(queryHint, /github/i.test(queryHint) ? "github" : "docs", `ecosystem-${hint.ecosystem}`, { preferredDomains: hint.preferredDomains || [] });
		}
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

function passesResearchPrecisionGate(source, constraintProfile, candidates = []) {
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
	if (["exact-docs", "migration-impact", "bugfix-investigation", "release-change"].includes(constraintProfile.taskProfile)) {
		for (const entity of constraintProfile.entities || []) {
			if (!conciseHaystack.includes(entity)) return false;
		}
	}
	if ((constraintProfile.exactTerms || []).length > 0 && ["config", "api", "bugfix", "repo", "release", "migration", "technical-change"].includes(constraintProfile.queryMode)) {
		const exactMatch = constraintProfile.requiresStrongExactMatch
			? strongExactTermsMatchSource(source, constraintProfile.exactTerms)
			: exactTermsMatchSource(source, constraintProfile.exactTerms);
		if (!exactMatch) return false;
	}
	if (constraintProfile.taskProfile === "migration-impact" && ["github-issue", "github-discussion"].includes(source.resultType)) {
		const officialCandidateExists = candidates.some((candidate) => candidate !== source && anchorMatchesTaskProfile(candidate, constraintProfile));
		if (officialCandidateExists) return false;
	}
	if (["exact-docs", "migration-impact", "release-change"].includes(constraintProfile.taskProfile) && isGenericOfficialSource(source)) {
		const strongerCandidateExists = candidates.some((candidate) => candidate !== source && sameSourceFamily(candidate, source) && strongerCanonicalCandidate(candidate, source, constraintProfile));
		if (strongerCandidateExists) return false;
	}
	return true;
}

function selectResearchSources(candidates, maxSources, constraintProfile) {
	const pool = [...candidates];
	const selected = [];
	const selectionReasons = [];
	const policy = buildSelectionPolicy(constraintProfile);
	const anchor = pickAnchorSource(pool, constraintProfile);
	if (anchor) {
		selected.push(anchor);
		selectionReasons.push({ url: anchor.url, reason: "anchor-source", role: "anchor" });
	}
	for (const picker of buildCoveragePickers(constraintProfile, policy)) {
		const match = pool.find((candidate) => !selected.some((item) => comparableUrlKey(item.url) === comparableUrlKey(candidate.url)) && picker.test(candidate));
		if (match) {
			selected.push(match);
			selectionReasons.push({ url: match.url, reason: picker.reason, role: picker.role });
		}
		if (selected.length >= maxSources) break;
	}
	for (const candidate of orderSelectionPool(pool, anchor, constraintProfile, policy)) {
		if (selected.length >= maxSources) break;
		if (selected.some((item) => comparableUrlKey(item.url) === comparableUrlKey(candidate.url))) continue;
		if (selected.some((item) => item.domain && candidate.domain && item.domain === candidate.domain) && !shouldAllowSameDomain(candidate, constraintProfile, anchor, policy)) continue;
		selected.push(candidate);
		selectionReasons.push({ url: candidate.url, reason: anchor?.domain && candidate.domain === anchor.domain ? "anchor-domain-support" : "score-fill", role: "supporting" });
	}
	const sources = selected.slice(0, maxSources);
	const canonicalProof = buildCanonicalProof(anchor, pool, constraintProfile);
	const bundleCoverage = summarizeBundleCoverage(sources, policy, constraintProfile);
	return {
		sources,
		anchorUrl: anchor?.url,
		anchorTitle: anchor?.title,
		anchorType: anchor?.resultType,
		anchorDomain: anchor?.domain,
		taskProfile: policy.taskProfile,
		policy,
		canonicalProof,
		bundleCoverage,
		reasons: selectionReasons,
	};
}

function pickAnchorSource(candidates, constraintProfile) {
	if (candidates.length === 0) return undefined;
	const scored = candidates.map((candidate) => ({ candidate, score: anchorScore(candidate, constraintProfile, candidates) }));
	scored.sort((a, b) => b.score - a.score);
	return scored[0]?.candidate;
}

function anchorScore(source, constraintProfile, candidates = []) {
	let score = Number(source.score || 0);
	if (isAuthoritativeCategory(source.sourceCategory)) score += 12;
	if (matchesPreferredDomains(source, constraintProfile?.preferredDomains || [])) score += 12;
	if (exactTermsMatchSource(source, constraintProfile?.exactTerms || [])) score += 18;
	if (strongExactTermsMatchSource(source, constraintProfile?.exactTerms || [])) score += 16;
	switch (constraintProfile?.canonicalPreference || constraintProfile?.queryMode) {
		case "migration":
			if (["migration-guide", "package-docs"].includes(source.resultType)) score += 30;
			if (["release-notes", "github-releases", "package-registry"].includes(source.resultType)) score += 18;
			break;
		case "config":
			if (["configuration-reference", "package-docs"].includes(source.resultType)) score += 30;
			if (source.resultType === "api-reference") score += 18;
			break;
		case "api":
			if (["api-reference", "package-docs"].includes(source.resultType)) score += 28;
			if (source.resultType === "configuration-reference") score += 12;
			break;
		case "repo":
			if (source.resultType === "repository-home") score += 30;
			break;
		case "release":
			if (["github-releases", "release-notes", "package-registry"].includes(source.resultType)) score += 28;
			break;
		case "architecture":
			if (source.resultType === "architecture-guide") score += 26;
			break;
		case "novel-discovery":
			if (["getting-started", "announcement", "repository-home", "github-releases", "release-notes"].includes(source.resultType)) score += 24;
			break;
		case "bugfix":
			if (["troubleshooting", "api-reference", "configuration-reference", "package-docs", "github-issue", "github-discussion"].includes(source.resultType)) score += 20;
			break;
	}
	if (["exact-docs", "migration-impact", "release-change"].includes(constraintProfile?.taskProfile) && isGenericOfficialSource(source)) score -= 18;
	if (constraintProfile?.taskProfile === "migration-impact") {
		if (anchorMatchesTaskProfile(source, constraintProfile)) score += 18;
		if (["github-issue", "github-discussion"].includes(source.resultType)) score -= 22;
	}
	if (constraintProfile?.taskProfile === "novel-discovery") {
		if (matchesResultTypes(source, ["getting-started", "guide", "announcement"])) score += 12;
		if (["github-issue", "github-discussion"].includes(source.resultType)) score -= 12;
	}
	if (candidates.some((candidate) => candidate !== source && sameSourceFamily(candidate, source) && strongerCanonicalCandidate(candidate, source, constraintProfile))) score -= 12;
	return score;
}

function buildCoveragePickers(constraintProfile, policy = buildSelectionPolicy(constraintProfile)) {
	const taskProfile = policy.taskProfile;
	if (taskProfile === "migration-impact") {
		return [
			{ role: "official-migration-doc", reason: "official-migration-doc", test: (source) => matchesResultTypes(source, ["migration-guide", "package-docs"]) && isAuthoritativeCategory(source.sourceCategory) },
			{ role: "release-evidence", reason: "release-evidence", test: (source) => matchesResultTypes(source, ["release-notes", "github-releases", "package-registry"]) },
			{ role: "maintainer-or-community", reason: "maintainer-or-community", test: (source) => ["github-issue", "github-discussion", "vendor-blog", "forum-community"].includes(source.resultType) || ["github-issue", "github-discussion", "vendor-blog", "forum-community"].includes(source.sourceCategory) },
		];
	}
	if (taskProfile === "bugfix-investigation") {
		return [
			{ role: "exact-reference", reason: "exact-reference", test: (source) => matchesResultTypes(source, ["configuration-reference", "api-reference", "troubleshooting", "package-docs"]) },
			{ role: "community-bug-signal", reason: "community-bug-signal", test: (source) => matchesResultTypes(source, ["github-issue", "github-discussion"]) },
		];
	}
	if (taskProfile === "architecture-decision") {
		return [
			{ role: "official-architecture-doc", reason: "official-architecture-doc", test: (source) => matchesResultTypes(source, ["architecture-guide"]) && isAuthoritativeCategory(source.sourceCategory) },
			{ role: "official-constraint-doc", reason: "official-constraint-doc", test: (source) => isAuthoritativeCategory(source.sourceCategory) },
			{ role: "community-tradeoff", reason: "community-tradeoff", test: (source) => ["vendor-blog", "forum-community", "secondary-tech-blog"].includes(source.sourceCategory) },
		];
	}
	if (taskProfile === "release-change") {
		return [
			{ role: "release-anchor", reason: "release-anchor", test: (source) => matchesResultTypes(source, ["github-releases", "release-notes", "package-registry"]) },
			{ role: "repo-home", reason: "repo-home", test: (source) => source.resultType === "repository-home" },
		];
	}
	if (taskProfile === "official-vs-community") {
		return [
			{ role: "official-position", reason: "official-position", test: (source) => isAuthoritativeCategory(source.sourceCategory) },
			{ role: "community-position", reason: "community-position", test: (source) => ["forum-community", "github-discussion", "github-issue", "secondary-tech-blog"].includes(source.sourceCategory) || matchesResultTypes(source, ["github-issue", "github-discussion"]) },
		];
	}
	if (taskProfile === "exact-docs") {
		return [
			{ role: "exact-reference", reason: "exact-reference", test: (source) => matchesResultTypes(source, ["configuration-reference", "api-reference", "package-docs"]) && strongExactTermsMatchSource(source, constraintProfile?.exactTerms || []) },
			{ role: "supporting-official-doc", reason: "supporting-official-doc", test: (source) => isAuthoritativeCategory(source.sourceCategory) },
		];
	}
	if (constraintProfile?.queryMode === "novel-discovery") {
		return [
			{ role: "official-discovery-doc", reason: "official-discovery-doc", test: (source) => ["getting-started", "guide", "announcement"].includes(source.resultType) && isAuthoritativeCategory(source.sourceCategory) },
			{ role: "repo-signal", reason: "repo-signal", test: (source) => ["repository-home", "github-releases"].includes(source.resultType) },
		];
	}
	if (constraintProfile?.queryMode === "repo") {
		return [
			{ role: "canonical-repo", reason: "canonical-repo", test: (source) => source.resultType === "repository-home" },
			{ role: "release-surface", reason: "release-surface", test: (source) => source.resultType === "github-releases" },
		];
	}
	return [
		{ role: "authoritative-support", reason: "authoritative-support", test: (source) => isAuthoritativeCategory(source.sourceCategory) },
	];
}

function orderSelectionPool(pool, anchor, constraintProfile, policy = buildSelectionPolicy(constraintProfile)) {
	return [...pool].sort((a, b) => selectionPreferenceScore(b, anchor, constraintProfile, policy) - selectionPreferenceScore(a, anchor, constraintProfile, policy));
}

function selectionPreferenceScore(candidate, anchor, constraintProfile, policy) {
	let score = Number(candidate.score || 0);
	if (anchor?.domain && candidate.domain === anchor.domain) score += 18;
	if (matchesPreferredDomains(candidate, constraintProfile?.preferredDomains || [])) score += 12;
	if (exactTermsMatchSource(candidate, constraintProfile?.exactTerms || [])) score += 10;
	if (strongExactTermsMatchSource(candidate, constraintProfile?.exactTerms || [])) score += 8;
	if (["migration", "technical-change", "config", "api"].includes(constraintProfile?.queryMode) && candidate.sourceCategory === "official-docs") score += 8;
	if (policy.taskProfile === "architecture-decision" && ["vendor-blog", "forum-community", "secondary-tech-blog"].includes(candidate.sourceCategory)) score += 10;
	if (policy.taskProfile === "migration-impact" && ["github-issue", "github-discussion"].includes(candidate.resultType)) score += 8;
	return score;
}

function shouldAllowSameDomain(candidate, constraintProfile, anchor, policy) {
	if (["repo", "release", "config", "api", "migration", "technical-change", "novel-discovery"].includes(constraintProfile?.queryMode)) return true;
	if (policy.taskProfile === "architecture-decision" && ["vendor-blog", "forum-community", "secondary-tech-blog"].includes(candidate.sourceCategory)) return true;
	if (anchor?.domain && candidate.domain === anchor.domain) return true;
	if (candidate.sourceCategory && isAuthoritativeCategory(candidate.sourceCategory)) return true;
	return false;
}

function buildSelectionPolicy(constraintProfile = {}) {
	const taskProfile = constraintProfile.taskProfile || "general-research";
	const requiredRoles = {
		"exact-docs": ["exact-reference"],
		"migration-impact": ["official-migration-doc", "release-evidence", "maintainer-or-community"],
		"architecture-decision": ["official-architecture-doc", "official-constraint-doc", "community-tradeoff"],
		"bugfix-investigation": ["exact-reference", "community-bug-signal"],
		"official-vs-community": ["official-position", "community-position"],
		"release-change": ["release-anchor"],
		"novel-discovery": ["official-discovery-doc", "repo-signal"],
	}[taskProfile] || ["authoritative-support"];
	return { taskProfile, requiredRoles };
}

function buildCanonicalProof(anchor, candidates, constraintProfile = {}) {
	const exactTerms = constraintProfile.exactTerms || [];
	const exactMatch = exactTerms.length === 0 ? true : exactTermsMatchSource(anchor, exactTerms);
	const strongExactMatch = exactTerms.length === 0 ? true : strongExactTermsMatchSource(anchor, exactTerms);
	const strongerCanonicalExists = candidates.some((candidate) => candidate !== anchor && sameSourceFamily(candidate, anchor) && strongerCanonicalCandidate(candidate, anchor, constraintProfile));
	const evidence = uniqueNonEmpty([
		isAuthoritativeCategory(anchor?.sourceCategory) ? "authoritative-source" : undefined,
		matchesPreferredDomains(anchor || {}, constraintProfile.preferredDomains || []) ? "preferred-domain" : undefined,
		exactMatch ? "exact-term-match" : undefined,
		strongExactMatch ? "strong-exact-term-match" : undefined,
		anchor?.resultType ? `result-type:${anchor.resultType}` : undefined,
	]);
	const matchesProfile = anchorMatchesTaskProfile(anchor, constraintProfile);
	const anchorQuality = strongExactMatch && matchesProfile && !strongerCanonicalExists
		? "strong"
		: exactMatch && matchesProfile && !strongerCanonicalExists
			? "partial"
			: "weak";
	return {
		taskProfile: constraintProfile.taskProfile,
		anchorQuality,
		exactTerms,
		exactMatch,
		strongExactMatch,
		strongerCanonicalExists,
		matchesTaskProfile: matchesProfile,
		evidence,
	};
}

function summarizeBundleCoverage(sources, policy, constraintProfile = {}) {
	const satisfiedRoles = [];
	for (const role of policy.requiredRoles || []) {
		const picker = buildCoveragePickers(constraintProfile, policy).find((item) => item.role === role);
		if (picker && sources.some((source) => picker.test(source))) satisfiedRoles.push(role);
	}
	const missingRoles = (policy.requiredRoles || []).filter((role) => !satisfiedRoles.includes(role));
	return {
		taskProfile: policy.taskProfile,
		requiredRoles: policy.requiredRoles,
		satisfiedRoles,
		missingRoles,
	};
}

function gradeResearchTrace({ candidates, filteredCandidates, selection, sources, constraintProfile, failures, confidence }) {
	const grades = [];
	const canonicalProof = selection?.canonicalProof || buildCanonicalProof(sources[0], candidates || [], constraintProfile);
	grades.push({ name: "authoritative-anchor", pass: Boolean(sources[0] && isAuthoritativeCategory(sources[0].sourceCategory)), category: "anchor-quality" });
	grades.push({ name: "canonical-anchor", pass: canonicalProof.anchorQuality !== "weak", category: "anchor-quality" });
	if (["exact-docs", "migration-impact", "bugfix-investigation", "release-change"].includes(constraintProfile?.taskProfile)) {
		grades.push({ name: "exact-identifier-coverage", pass: canonicalProof.exactMatch, category: "precision" });
	}
	grades.push({ name: "bundle-coverage", pass: (selection?.bundleCoverage?.missingRoles || []).length === 0, category: "bundle" });
	grades.push({ name: "precision-filter-helped", pass: (filteredCandidates || []).length > 0, category: "retrieval" });
	grades.push({ name: "confidence-calibrated", pass: confidence !== "high" || (selection?.bundleCoverage?.missingRoles || []).length === 0, category: "confidence" });
	if ((failures || []).length > 0) grades.push({ name: "partial-failure-visible", pass: true, category: "resilience" });
	const failuresByClass = grades.filter((grade) => !grade.pass).map((grade) => ({ class: grade.name, category: grade.category }));
	return {
		checks: grades,
		failures: failuresByClass,
		summary: failuresByClass.length === 0 ? "Selection trace passed the current retrieval quality checks." : `Selection trace failed ${failuresByClass.length} retrieval quality check(s).`,
	};
}

function matchesPreferredDomains(source, preferredDomains) {
	return (preferredDomains || []).some((domain) => domainMatches(source.domain || hostnameFromUrl(source.url || ""), domain));
}

function matchesResultTypes(source, resultTypes) {
	return Boolean(source && resultTypes.includes(source.resultType));
}

function exactTermsMatchSource(source, exactTerms) {
	if (!exactTerms?.length) return false;
	const haystack = compactText([source.title, source.url, source.snippet, source.excerpt].filter(Boolean).join(" "));
	return exactTerms.some((term) => haystack.includes(compactText(term)));
}

function strongExactTermsMatchSource(source, exactTerms) {
	if (!exactTerms?.length) return false;
	const haystack = compactText([source.title, source.url].filter(Boolean).join(" "));
	return exactTerms.some((term) => haystack.includes(compactText(term)));
}

function sameSourceFamily(a, b) {
	if (!a || !b) return false;
	const aDomain = a.domain || hostnameFromUrl(a.url || "");
	const bDomain = b.domain || hostnameFromUrl(b.url || "");
	return aDomain === bDomain || comparableUrlKey(a.url || "") === comparableUrlKey(b.url || "");
}

function strongerCanonicalCandidate(candidate, current, constraintProfile = {}) {
	if (!candidate || !current) return false;
	const candidateStrong = strongExactTermsMatchSource(candidate, constraintProfile.exactTerms || []);
	const currentStrong = strongExactTermsMatchSource(current, constraintProfile.exactTerms || []);
	if (candidateStrong && !currentStrong) return true;
	const candidateExact = exactTermsMatchSource(candidate, constraintProfile.exactTerms || []);
	const currentExact = exactTermsMatchSource(current, constraintProfile.exactTerms || []);
	if (candidateExact && !currentExact) return true;
	if (anchorMatchesTaskProfile(candidate, constraintProfile) && !anchorMatchesTaskProfile(current, constraintProfile)) return true;
	if (urlSpecificity(candidate.url) > urlSpecificity(current.url) + 1) return true;
	return false;
}

function anchorMatchesTaskProfile(source, constraintProfile = {}) {
	if (!source) return false;
	switch (constraintProfile.taskProfile) {
		case "exact-docs":
			return matchesResultTypes(source, ["configuration-reference", "api-reference", "package-docs"]);
		case "migration-impact":
			return matchesResultTypes(source, ["migration-guide", "release-notes", "github-releases", "package-docs", "package-registry"]);
		case "release-change":
			return matchesResultTypes(source, ["release-notes", "github-releases", "package-registry"]);
		case "architecture-decision":
			return matchesResultTypes(source, ["architecture-guide", "guide"]);
		case "bugfix-investigation":
			return matchesResultTypes(source, ["troubleshooting", "configuration-reference", "api-reference", "package-docs"]);
		case "novel-discovery":
			return matchesResultTypes(source, ["getting-started", "guide", "announcement", "repository-home", "github-releases"]);
		default:
			return Boolean(source.resultType || source.sourceCategory);
	}
}

function isGenericOfficialSource(source) {
	if (!source || !isAuthoritativeCategory(source.sourceCategory)) return false;
	const title = String(source.title || "").trim();
	const url = String(source.url || "").toLowerCase();
	if (/^(docs?|documentation|reference overview|next\.js|react)$/i.test(title)) return true;
	if (/\/(docs|documentation)(?:\/)?$/.test(url)) return true;
	if (urlSpecificity(source.url) <= 1 && !/github\.com/.test(url)) return true;
	return false;
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
	const extractionConfidence = direct?.metadata?.extractionConfidence;
	const shellLikelihood = Number(direct?.metadata?.shellLikelihood || 0);
	const frameworkHints = direct?.metadata?.frameworkHints || [];
	if (shellLikelihood >= 0.55) return true;
	if (extractionConfidence === "low") return true;
	if (frameworkHints.length > 0 && (!direct.content || direct.content.length < 900)) return true;
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

function chooseFetchedSourceIdentity(candidate, page) {
	const fetchedUrl = page?.canonicalUrl || candidate?.url;
	const candidateUrl = candidate?.url;
	const keepCandidateUrl = shouldPreferCandidateUrl(candidateUrl, fetchedUrl);
	const url = keepCandidateUrl ? candidateUrl : (fetchedUrl || candidateUrl);
	const fetchedTitle = String(page?.title || "").trim();
	const candidateTitle = String(candidate?.title || "").trim();
	const keepCandidateTitle = shouldPreferCandidateTitle(candidateTitle, fetchedTitle, candidate, page, keepCandidateUrl);
	return {
		title: keepCandidateTitle ? (candidateTitle || fetchedTitle) : (fetchedTitle || candidateTitle),
		url,
	};
}

function shouldPreferCandidateUrl(candidateUrl, fetchedUrl) {
	if (!candidateUrl || !fetchedUrl) return false;
	if (comparableUrlKey(candidateUrl) === comparableUrlKey(fetchedUrl)) return false;
	const candidateHost = hostnameFromUrl(candidateUrl);
	const fetchedHost = hostnameFromUrl(fetchedUrl);
	if (candidateHost && fetchedHost && candidateHost !== fetchedHost) return false;
	if (/\/docs\//.test(candidateUrl) && !/\/docs\//.test(fetchedUrl)) return true;
	return urlSpecificity(candidateUrl) > urlSpecificity(fetchedUrl) + 1;
}

function shouldPreferCandidateTitle(candidateTitle, fetchedTitle, candidate, page, keepCandidateUrl) {
	if (!candidateTitle) return false;
	if (!fetchedTitle) return true;
	if (keepCandidateUrl) return true;
	const fetchedGeneric = /^(next\.js|react|documentation|docs|reference overview)$/i.test(fetchedTitle) || fetchedTitle.split(/\s+/).length <= 2;
	const candidateSpecific = candidateTitle.length > fetchedTitle.length || /proxyclientmaxbodysize|configuration|reference|guide|release|upgrade|migration|cachex|version/i.test(candidateTitle);
	const pageUrl = page?.canonicalUrl || candidate?.url;
	if ((page?.metadata?.strategy || "").includes("docs-markdown") && candidateSpecific) return true;
	return fetchedGeneric && candidateSpecific && urlSpecificity(candidate?.url) >= urlSpecificity(pageUrl);
}

function urlSpecificity(url) {
	try {
		const parsed = new URL(url);
		return parsed.pathname.split("/").filter(Boolean).length;
	} catch {
		return 0;
	}
}

function buildTrace(helpers) {
	return summarizeTrace(helpers.trace) || { requestId: helpers.requestId };
}

function normalizeFailure(stage, error, context = {}) {
	const typed = stage === "fetch" ? classifyFetchError(error, context) : error;
	if (typed?.code && typed?.message) {
		return {
			stage,
			code: typed.code,
			message: typed.message,
			retryable: typed.retryable,
			details: typed.details,
		};
	}
	return {
		stage,
		code: "INTERNAL_ERROR",
		message: error instanceof Error ? error.message : String(error),
		retryable: true,
		details: context,
	};
}

function buildRetrySuggestions({ failures, ranked, mode, constraintProfile, traceGrades }) {
	const suggestions = [];
	if ((failures || []).some((item) => item.retryable)) suggestions.push("Retry the research query with fewer sources to reduce upstream timeout risk.");
	if ((failures || []).some((item) => item.stage === "fetch")) suggestions.push("Retry in docs-focused mode or rendered mode when important pages look incomplete.");
	if ((failures || []).length > 0 && (constraintProfile?.preferredDomains || []).length === 0) suggestions.push("Retry with preferred official domains if you already know the primary docs or repo host.");
	if ((ranked || []).length === 0 && mode === "technical") suggestions.push("Retry with docs-only constraints or explicit official domains to improve technical precision.");
	if ((traceGrades?.failures || []).some((item) => item.class === "canonical-anchor" || item.class === "exact-identifier-coverage")) suggestions.push("Retry with the exact identifier quoted and an official docs or package-docs domain constraint.");
	if ((traceGrades?.failures || []).some((item) => item.class === "bundle-coverage")) suggestions.push("Retry with a task-specific source policy such as migration guide + release notes + maintainer discussion.");
	return uniqueNonEmpty(suggestions).slice(0, 5);
}

function inferExtractionConfidence(content) {
	const length = String(content || "").length;
	if (length >= 1200) return "high";
	if (length >= 300) return "medium";
	return "low";
}

function buildFetchFallbackRecommendations({ mode, extractionConfidence, shellLikelihood, frameworkHints, strategy }) {
	const suggestions = [];
	if (mode !== "rendered" && (shellLikelihood >= 0.55 || extractionConfidence === "low")) {
		suggestions.push("Rendered mode recommended: the fast fetch looks incomplete or shell-like.");
	}
	if ((frameworkHints || []).length > 0 && strategy !== "playwright-fallback") {
		suggestions.push(`Docs framework detected (${frameworkHints.join(", ")}); rendered or advanced extraction may improve content quality.`);
	}
	return suggestions.slice(0, 3);
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
