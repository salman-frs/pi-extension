export const OUTPUT_SCHEMA_VERSION = "2026-04-09.v2";

export const OUTPUT_CONTRACTS = {
	search: "pi.web-research.search.v1",
	fetch: "pi.web-research.fetch.v1",
	research: "pi.web-research.research.v1",
	analyze: "pi.web-research.analyze.v1",
};

const DEFAULT_HINTS = {
	search: {
		recommendedNextTools: ["fetch_url", "research_query"],
		suitableFor: ["candidate-discovery", "downstream-extension-input"],
		stableFields: ["title", "url", "snippet", "sourceType", "sourceCategory", "resultType", "domain", "publishedAt", "ranking"],
	},
	fetch: {
		recommendedNextTools: ["research_query", "analyze_sources"],
		suitableFor: ["exact-source-retrieval", "citation-support", "downstream-extension-input"],
		stableFields: ["url", "canonicalUrl", "title", "content", "fetchMode", "contentType", "metadata.codeAware"],
	},
	research: {
		recommendedNextTools: ["analyze_sources"],
		suitableFor: ["general-research", "deep-research", "decision-support", "downstream-extension-input"],
		stableFields: ["answer", "recommendation", "summary", "bestPractices", "tradeOffs", "risks", "mitigations", "selectionRationale", "confidenceRationale", "freshnessRationale", "sources", "confidence", "evidenceStatus", "decisionReadiness", "missingEvidence", "nextActions", "gaps", "failures", "retrySuggestions"],
	},
	analyze: {
		recommendedNextTools: [],
		suitableFor: ["source-comparison", "decision-support", "downstream-extension-input"],
		stableFields: ["summary", "agreements", "disagreements", "strongestEvidence", "officialPosition", "communityPosition", "recommendation", "uncertainties", "comparisonAxes", "conflicts", "claimMatrix", "gaps", "sources"],
	},
};

export function decorateMetadata(kind, metadata = {}, extras = {}) {
	return {
		contract: OUTPUT_CONTRACTS[kind],
		schemaVersion: OUTPUT_SCHEMA_VERSION,
		outputKind: kind,
		consumerHints: DEFAULT_HINTS[kind],
		...metadata,
		...extras,
	};
}

export function buildResearchResponseSections(result = {}) {
	return [
		"answer",
		result.recommendation ? "recommendation" : undefined,
		result.summary ? "summary" : undefined,
		Array.isArray(result.findings) && result.findings.length ? "findings" : undefined,
		Array.isArray(result.bestPractices) && result.bestPractices.length ? "bestPractices" : undefined,
		Array.isArray(result.tradeOffs) && result.tradeOffs.length ? "tradeOffs" : undefined,
		Array.isArray(result.risks) && result.risks.length ? "risks" : undefined,
		Array.isArray(result.mitigations) && result.mitigations.length ? "mitigations" : undefined,
		result.selectionRationale ? "selectionRationale" : undefined,
		result.confidenceRationale ? "confidenceRationale" : undefined,
		result.freshnessRationale ? "freshnessRationale" : undefined,
		Array.isArray(result.agreements) && result.agreements.length ? "agreements" : undefined,
		Array.isArray(result.disagreements) && result.disagreements.length ? "disagreements" : undefined,
		Array.isArray(result.sources) && result.sources.length ? "sources" : undefined,
		result.confidence ? "confidence" : undefined,
		result.evidenceStatus ? "evidenceStatus" : undefined,
		result.decisionReadiness ? "decisionReadiness" : undefined,
		Array.isArray(result.missingEvidence) && result.missingEvidence.length ? "missingEvidence" : undefined,
		Array.isArray(result.nextActions) && result.nextActions.length ? "nextActions" : undefined,
		Array.isArray(result.gaps) && result.gaps.length ? "gaps" : undefined,
		Array.isArray(result.failures) && result.failures.length ? "failures" : undefined,
		Array.isArray(result.retrySuggestions) && result.retrySuggestions.length ? "retrySuggestions" : undefined,
	].filter(Boolean);
}

export function buildAnalyzeResponseSections(result = {}) {
	return [
		result.summary ? "summary" : undefined,
		Array.isArray(result.agreements) && result.agreements.length ? "agreements" : undefined,
		Array.isArray(result.disagreements) && result.disagreements.length ? "disagreements" : undefined,
		Array.isArray(result.strongestEvidence) && result.strongestEvidence.length ? "strongestEvidence" : undefined,
		result.officialPosition ? "officialPosition" : undefined,
		result.communityPosition ? "communityPosition" : undefined,
		result.recommendation ? "recommendation" : undefined,
		Array.isArray(result.uncertainties) && result.uncertainties.length ? "uncertainties" : undefined,
		Array.isArray(result.comparisonAxes) && result.comparisonAxes.length ? "comparisonAxes" : undefined,
		Array.isArray(result.conflicts) && result.conflicts.length ? "conflicts" : undefined,
		Array.isArray(result.claimMatrix) && result.claimMatrix.length ? "claimMatrix" : undefined,
		Array.isArray(result.gaps) && result.gaps.length ? "gaps" : undefined,
		Array.isArray(result.sources) && result.sources.length ? "sources" : undefined,
	].filter(Boolean);
}
