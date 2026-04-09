const DESIRED_TYPES = {
	config: ["configuration-reference", "api-reference", "troubleshooting"],
	api: ["api-reference", "configuration-reference", "troubleshooting", "examples"],
	release: ["github-releases", "release-notes"],
	migration: ["migration-guide", "release-notes", "github-releases"],
	repo: ["repository-home", "repository-page"],
	bugfix: ["troubleshooting", "github-issue", "github-discussion", "api-reference", "configuration-reference"],
	architecture: ["architecture-guide", "guide"],
};

export function resolveCanonicalSearchResults(results, context = {}) {
	if (!Array.isArray(results) || results.length < 2) return results || [];
	const queryMode = context.constraintProfile?.queryMode || context.sourceType || "general";
	const desired = DESIRED_TYPES[queryMode];
	if (!desired?.length) return results;
	const top = results[0];
	const candidateIndex = results.findIndex((item, index) => index > 0 && shouldPromoteCanonicalCandidate(item, top, desired, context));
	if (candidateIndex <= 0) return results;
	const candidate = results[candidateIndex];
	const reordered = [
		markPromoted(candidate, queryMode, top),
		...results.slice(0, candidateIndex).map((item) => demote(item, candidate)),
		...results.slice(candidateIndex + 1),
	];
	return reordered;
}

function shouldPromoteCanonicalCandidate(candidate, currentTop, desiredTypes, context) {
	if (!candidate) return false;
	if (!desiredTypes.includes(candidate.resultType)) return false;
	if ((candidate.score || 0) + 12 < (currentTop?.score || 0)) return false;
	const exactTerms = context.constraintProfile?.exactTerms || [];
	const currentExact = matchesExactTerms(currentTop, exactTerms);
	const candidateExact = matchesExactTerms(candidate, exactTerms);
	if (exactTerms.length > 0 && candidateExact && !currentExact) return true;
	const currentDesired = desiredTypes.includes(currentTop?.resultType);
	if (!currentDesired) return true;
	if ((candidate.ranking?.contributions?.["canonical-preference"] || 0) > (currentTop?.ranking?.contributions?.["canonical-preference"] || 0)) return true;
	if ((candidate.ranking?.contributions?.["exact-term-match"] || 0) > (currentTop?.ranking?.contributions?.["exact-term-match"] || 0)) return true;
	return false;
}

function matchesExactTerms(item, exactTerms) {
	if (!item || !exactTerms?.length) return false;
	const haystack = normalize(`${item.title || ""} ${item.url || ""} ${item.snippet || ""}`);
	return exactTerms.some((term) => normalize(term) && haystack.includes(normalize(term)));
}

function normalize(value) {
	return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function markPromoted(item, queryMode, previousTop) {
	const reason = `canonical resolver promoted this ${item.resultType || "result"} for ${queryMode} intent ahead of ${previousTop?.title || previousTop?.url || "the prior top result"}`;
	return {
		...item,
		ranking: {
			...(item.ranking || {}),
			reasons: [...(item.ranking?.reasons || []), "canonical-resolver:+999"],
			contributions: {
				...(item.ranking?.contributions || {}),
				"canonical-resolver": 999,
			},
			explanation: appendExplanation(item.ranking?.explanation, reason),
			canonicalPromotion: true,
		},
	};
}

function demote(item, promoted) {
	if (!item) return item;
	const reason = `ranked below ${promoted?.title || promoted?.url || "the promoted canonical result"} after canonical resolution`;
	return {
		...item,
		ranking: {
			...(item.ranking || {}),
			explanation: appendExplanation(item.ranking?.explanation, reason),
		},
	};
}

function appendExplanation(existing, addition) {
		return existing ? `${existing}; ${addition}` : addition;
}
