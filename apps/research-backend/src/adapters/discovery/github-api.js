import { classifyUpstreamSearchError } from "../../errors.js";
import { hostnameFromUrl } from "../../lib/utils.js";

const API_BASE = "https://api.github.com";

export async function searchGitHubApi(config, params, plan, fetchWithTimeout, logger, requestId) {
	if (!config.githubToken) {
		return { status: "no_results", results: [], errors: [], diagnostics: { provider: "github-api", enabled: false } };
	}
	const queries = pickQueries(plan);
	const githubEntityType = plan?.constraintProfile?.githubEntityType;
	const errors = [];
	const collected = [];
	const diagnostics = {
		provider: "github-api",
		enabled: true,
		queryRewrites: queries,
		searchTypes: pickSearchTypes(githubEntityType, plan?.intent),
		directResolvers: [],
	};

	const directResolved = await resolveDirectGitHubTargets(config, plan, fetchWithTimeout, logger, requestId);
	collected.push(...directResolved.results);
	diagnostics.directResolvers = directResolved.diagnostics;

	for (const query of queries.slice(0, 4)) {
		for (const searchType of diagnostics.searchTypes) {
			try {
				const results = await runGitHubApiQuery(config, query, searchType, fetchWithTimeout);
				collected.push(...results);
			} catch (error) {
				const typed = classifyUpstreamSearchError(error, { provider: `github-api:${searchType}`, query });
				errors.push({ code: typed.code, message: typed.message, retryable: typed.retryable, details: typed.details });
				logger?.warn("search.github_api_failed", { requestId, provider: `github-api:${searchType}`, query, error: typed });
			}
		}
	}

	const results = dedupe(maybeAddReleasePages(collected, queries.join(" "), githubEntityType));
	return {
		status: results.length > 0 ? (errors.length > 0 ? "partial_success" : "success") : (errors.length > 0 ? "failure" : "no_results"),
		results,
		errors,
		diagnostics,
	};
}

async function resolveDirectGitHubTargets(config, plan, fetchWithTimeout, logger, requestId) {
	const repoCandidates = (plan?.constraintProfile?.repoCandidates || []).filter((value) => value.includes("/"));
	const githubEntityType = plan?.constraintProfile?.githubEntityType;
	if (repoCandidates.length === 0 || !["repository", "release"].includes(githubEntityType)) {
		return { results: [], diagnostics: [] };
	}
	const results = [];
	const diagnostics = [];
	for (const candidate of repoCandidates.slice(0, 4)) {
		try {
			const repo = await fetchRepo(config, candidate, fetchWithTimeout);
			if (repo) {
				results.push(repo);
				diagnostics.push({ candidate, matched: true, type: "repository" });
				if (githubEntityType === "release") {
					results.push(buildReleaseResult(candidate, repo));
					diagnostics.push({ candidate, matched: true, type: "release" });
				}
			} else {
				diagnostics.push({ candidate, matched: false, type: githubEntityType });
			}
		} catch (error) {
			logger?.warn("search.github_api_direct_failed", { requestId, candidate, error });
			diagnostics.push({ candidate, matched: false, type: githubEntityType, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { results, diagnostics };
}

async function runGitHubApiQuery(config, query, searchType, fetchWithTimeout) {
	if (searchType === "repositories" || searchType === "releases") {
		const payload = await getJson(config, `/search/repositories?q=${encodeURIComponent(query)}&per_page=5&sort=stars&order=desc`, fetchWithTimeout);
		return (payload.items || []).map(normalizeRepositoryItem).filter(Boolean);
	}
	const issueType = searchType === "pullrequests" ? "pr" : "issue";
	const payload = await getJson(config, `/search/issues?q=${encodeURIComponent(`${query} type:${issueType}`)}&per_page=5&sort=updated&order=desc`, fetchWithTimeout);
	return (payload.items || []).map((item) => normalizeIssueItem(item, issueType)).filter(Boolean);
}

async function fetchRepo(config, candidate, fetchWithTimeout) {
	const payload = await getJson(config, `/repos/${candidate}`, fetchWithTimeout, true);
	if (!payload?.full_name) return undefined;
	return normalizeRepositoryItem(payload);
}

function normalizeRepositoryItem(item) {
	const fullName = item.full_name || item?.repo?.full_name;
	if (!fullName) return undefined;
	const url = item.html_url || `https://github.com/${fullName}`;
	return {
		title: fullName,
		url,
		snippet: item.description || `Official repository page for ${fullName}.`,
		domain: hostnameFromUrl(url),
		sourceType: "github",
		sourceCategory: "github-repo",
		resultType: "repository-home",
		publishedAt: item.updated_at || item.pushed_at || item.created_at,
		stargazerCount: item.stargazers_count,
	};
}

function normalizeIssueItem(item, issueType) {
	const url = item.html_url;
	if (!url) return undefined;
	const fullName = item.repository_url?.replace(`${API_BASE}/repos/`, "") || inferRepoFromIssueUrl(url);
	const category = issueType === "pr" ? "github-pr" : (url.includes("/discussions/") ? "github-discussion" : "github-issue");
	const resultType = issueType === "pr" ? "github-pr" : (url.includes("/discussions/") ? "github-discussion" : "github-issue");
	return {
		title: fullName ? `${fullName} ${item.title || ""}`.trim() : (item.title || url),
		url,
		snippet: item.body ? String(item.body).replace(/\s+/g, " ").slice(0, 220) : undefined,
		domain: hostnameFromUrl(url),
		sourceType: "github",
		sourceCategory: category,
		resultType,
		publishedAt: item.updated_at || item.created_at,
	};
}

function buildReleaseResult(candidate, repo) {
	return {
		title: `${repo.title} releases`,
		url: `https://github.com/${candidate}/releases`,
		snippet: `Release notes and tagged versions for ${repo.title}.`,
		domain: "github.com",
		sourceType: "github",
		sourceCategory: "release-notes",
		resultType: "github-releases",
		publishedAt: repo.publishedAt,
	};
}

async function getJson(config, path, fetchWithTimeout, allowNotFound = false) {
	const response = await fetchWithTimeout(`${API_BASE}${path}`, {
		method: "GET",
		headers: {
			"user-agent": config.userAgent,
			accept: "application/vnd.github+json",
			authorization: `Bearer ${config.githubToken}`,
			"x-github-api-version": "2022-11-28",
		},
	}, config.requestTimeoutMs, undefined);
	if (allowNotFound && response.status === 404) return undefined;
	if (!response.ok) throw new Error(`GitHub API failed: HTTP ${response.status}`);
	return await response.json();
}

function inferRepoFromIssueUrl(url) {
	const match = String(url || "").match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\//i);
	return match?.[1];
}

function maybeAddReleasePages(results, query, githubEntityType) {
	if (!/release|changelog|upgrade|migration/i.test(query) && githubEntityType !== "release") return results;
	const extras = [];
	for (const result of results) {
		if (result.sourceCategory !== "github-repo") continue;
		const match = String(result.url || "").match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/?$/i);
		if (!match?.[1]) continue;
		extras.push(buildReleaseResult(match[1], result));
		if (githubEntityType === "release") break;
	}
	return [...extras, ...results];
}

function pickQueries(plan) {
	const repoCandidates = plan?.constraintProfile?.repoCandidates || [];
	const variants = [...repoCandidates, ...(plan?.variants || [])];
	return [...new Set(variants.filter(Boolean))].slice(0, 8);
}

function pickSearchTypes(githubEntityType, intent) {
	switch (githubEntityType) {
		case "repository":
			return ["repositories"];
		case "release":
			return ["releases", "repositories"];
		case "issue":
			return ["issues", "repositories"];
		case "pull-request":
			return ["pullrequests", "repositories"];
		default:
			return intent === "bugfix" ? ["issues", "repositories"] : ["repositories", "issues"];
	}
}

function dedupe(results) {
	const seen = new Set();
	const output = [];
	for (const item of results) {
		if (!item?.url || seen.has(item.url)) continue;
		seen.add(item.url);
		output.push(item);
	}
	return output;
}
