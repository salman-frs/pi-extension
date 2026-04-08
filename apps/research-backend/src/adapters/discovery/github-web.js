import { classifyUpstreamSearchError } from "../../errors.js";
import { hostnameFromUrl } from "../../lib/utils.js";

export async function searchGitHubWeb(config, params, plan, fetchWithTimeout, logger, requestId) {
	const queries = pickQueries(plan);
	const searchTypes = pickSearchTypes(plan?.constraintProfile?.githubEntityType, plan?.intent);
	const errors = [];
	const collected = [];
	const diagnostics = {
		provider: "github-web",
		queryRewrites: queries,
		searchTypes,
		directResolvers: [],
	};

	const directResolved = await resolveDirectGitHubTargets(config, plan, fetchWithTimeout, logger, requestId);
	collected.push(...directResolved.results);
	diagnostics.directResolvers = directResolved.diagnostics;
	if (shouldShortCircuitWithDirectResults(plan?.constraintProfile?.githubEntityType, directResolved.results)) {
		return {
			status: directResolved.results.length > 0 ? "success" : "no_results",
			results: dedupe(directResolved.results),
			errors,
			diagnostics: { ...diagnostics, shortCircuited: true },
		};
	}

	for (const query of queries) {
		for (const searchType of searchTypes) {
			try {
				const results = await runGitHubQuery(config, query, searchType, fetchWithTimeout);
				collected.push(...results);
			} catch (error) {
				const typed = classifyUpstreamSearchError(error, { provider: `github:${searchType}`, query });
				errors.push({ code: typed.code, message: typed.message, retryable: typed.retryable, details: typed.details });
				logger?.warn("search.github_failed", { requestId, provider: `github:${searchType}`, query, error: typed });
			}
		}
	}

	const deduped = dedupe(collected);
	const enriched = maybeAddReleasePages(deduped, queries.join(" "), plan?.constraintProfile?.githubEntityType);
	return {
		status: enriched.length > 0 ? (errors.length > 0 ? "partial_success" : "success") : (errors.length > 0 ? "failure" : "no_results"),
		results: enriched,
		errors,
		diagnostics,
	};
}

async function runGitHubQuery(config, query, searchType, fetchWithTimeout) {
	const url = new URL("https://github.com/search");
	url.searchParams.set("q", query);
	url.searchParams.set("type", searchType);
	const response = await fetchWithTimeout(
		url.toString(),
		{
			method: "GET",
			headers: {
				"user-agent": config.userAgent,
				accept: "text/html,application/xhtml+xml",
			},
		},
		config.requestTimeoutMs,
		undefined,
	);
	if (!response.ok) throw new Error(`GitHub search failed: HTTP ${response.status}`);
	const html = await response.text();
	const payload = extractEmbeddedPayload(html);
	const results = Array.isArray(payload?.results) ? payload.results : [];
	return results.map((item) => normalizeGitHubResult(item, searchType)).filter(Boolean);
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
			const repo = await fetchGitHubRepoCandidate(config, candidate, fetchWithTimeout);
			if (repo) {
				results.push(repo);
				diagnostics.push({ candidate, matched: true, type: "repository" });
				if (githubEntityType === "release") {
					const releasePage = await fetchGitHubReleaseCandidate(config, candidate, repo, fetchWithTimeout);
					if (releasePage) {
						results.push(releasePage);
						diagnostics.push({ candidate, matched: true, type: "release" });
					}
				}
			} else {
				diagnostics.push({ candidate, matched: false, type: "repository" });
			}
		} catch (error) {
			logger?.warn("search.github_direct_resolve_failed", { requestId, candidate, error });
			diagnostics.push({ candidate, matched: false, type: githubEntityType, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { results, diagnostics };
}

async function fetchGitHubRepoCandidate(config, candidate, fetchWithTimeout) {
	const url = `https://github.com/${candidate}`;
	const response = await fetchWithTimeout(
		url,
		{
			method: "GET",
			headers: {
				"user-agent": config.userAgent,
				accept: "text/html,application/xhtml+xml",
			},
		},
		config.requestTimeoutMs,
		undefined,
	);
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`GitHub repo resolve failed: HTTP ${response.status}`);
	const html = await response.text();
	if (!looksLikeRepositoryPage(response.url, html)) return undefined;
	const title = extractOgTitle(html) || candidate;
	const description = extractDescription(html);
	return {
		title: cleanHtml(title),
		url: response.url,
		snippet: cleanHtml(description || `Official repository page for ${candidate}.`),
		domain: hostnameFromUrl(response.url),
		sourceType: "github",
		sourceCategory: "github-repo",
		resultType: "repository-home",
	};
}

async function fetchGitHubReleaseCandidate(config, candidate, repo, fetchWithTimeout) {
	const url = `https://github.com/${candidate}/releases`;
	const response = await fetchWithTimeout(
		url,
		{
			method: "GET",
			headers: {
				"user-agent": config.userAgent,
				accept: "text/html,application/xhtml+xml",
			},
		},
		config.requestTimeoutMs,
		undefined,
	);
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`GitHub release resolve failed: HTTP ${response.status}`);
	const html = await response.text();
	if (!/releases/i.test(response.url) && !/releases/i.test(html)) return undefined;
	return {
		title: `${repo.title} releases`,
		url: response.url,
		snippet: cleanHtml(extractDescription(html) || `Release notes and tagged versions for ${repo.title}.`),
		domain: hostnameFromUrl(response.url),
		sourceType: "github",
		sourceCategory: "release-notes",
		resultType: "github-releases",
	};
}

function looksLikeRepositoryPage(url, html) {
	if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+\/?(?:\?.*)?$/i.test(url)) return false;
	return /Repository|git clone|Issues|Pull requests/i.test(html);
}

function extractOgTitle(html) {
	const match = String(html || "").match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
	return match?.[1];
}

function extractDescription(html) {
	const og = String(html || "").match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
	if (og?.[1]) return og[1];
	const standard = String(html || "").match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
	return standard?.[1];
}

function extractEmbeddedPayload(html) {
	const match = html.match(/<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/i);
	if (!match) throw new Error("GitHub search payload not found");
	const parsed = JSON.parse(match[1]);
	return parsed?.payload || {};
}

function normalizeGitHubResult(item, searchType) {
	const repo = item?.repo?.repository;
	if (!repo) return undefined;
	const owner = repo.owner_login;
	const name = repo.name;
	const baseUrl = `https://github.com/${owner}/${name}`;
	if (searchType === "repositories") {
		return {
			title: cleanHtml(item.hl_name) || `${owner}/${name}`,
			url: baseUrl,
			snippet: cleanHtml(item.hl_trunc_description || ""),
			domain: hostnameFromUrl(baseUrl),
			sourceType: "github",
			sourceCategory: "github-repo",
			publishedAt: repo.updated_at,
			resultType: "repository-home",
			stargazerCount: item.followers,
		};
	}
	const number = item.number;
	const url = searchType === "pullrequests"
		? `${baseUrl}/pull/${number}`
		: `${baseUrl}/${searchType === "issues" ? "issues" : "discussions"}/${number}`;
	const mapping = searchType === "issues"
		? { sourceCategory: "github-issue", resultType: "github-issue" }
		: searchType === "pullrequests"
			? { sourceCategory: "github-pr", resultType: "github-pr" }
			: { sourceCategory: "github-discussion", resultType: "github-discussion" };
	return {
		title: `${owner}/${name}#${number} ${cleanHtml(item.hl_title || "")}`.trim(),
		url,
		snippet: cleanHtml(item.hl_text || item.hl_title || ""),
		domain: hostnameFromUrl(url),
		sourceType: "github",
		sourceCategory: mapping.sourceCategory,
		publishedAt: item.created,
		resultType: mapping.resultType,
		stargazerCount: item.num_comments,
	};
}

function maybeAddReleasePages(results, query, githubEntityType) {
	if (!/release|changelog|upgrade|migration/i.test(query) && githubEntityType !== "release") return results;
	const extras = [];
	for (const result of results) {
		if (result.sourceCategory !== "github-repo") continue;
		extras.push({
			title: `${result.title} releases`,
			url: `${result.url.replace(/\/+$/, "")}/releases`,
			snippet: `Release notes and tagged versions for ${result.title}.`,
			domain: result.domain,
			sourceType: "github",
			sourceCategory: "release-notes",
			publishedAt: result.publishedAt,
			resultType: "github-releases",
		});
		if (githubEntityType === "release") break;
	}
	return dedupe([...extras, ...results]);
}

function cleanHtml(value) {
	return String(value || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&#x2F;/g, "/")
		.replace(/\s+/g, " ")
		.trim();
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
			return ["repositories"];
		case "issue":
			return ["issues", "discussions", "repositories"];
		case "discussion":
			return ["discussions", "issues", "repositories"];
		case "pull-request":
			return ["pullrequests", "repositories"];
		default:
			return intent === "bugfix" ? ["issues", "discussions", "repositories"] : ["repositories", "issues", "discussions"];
	}
}

function shouldShortCircuitWithDirectResults(githubEntityType, results) {
	if (!results?.length) return false;
	if (githubEntityType === "repository") {
		return results.some((item) => item.resultType === "repository-home");
	}
	if (githubEntityType === "release") {
		return results.some((item) => item.resultType === "github-releases");
	}
	return false;
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
