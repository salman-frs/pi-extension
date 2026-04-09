const ECOSYSTEMS = {
	npm: {
		name: "npm",
		docsDomains: ["docs.npmjs.com", "npmjs.com"],
		registryDomains: ["npmjs.com"],
		supportDomains: ["github.com"],
		clues: [/\bnpm\b/i, /\bnode(?:\.js)?\b/i, /\bjavascript\b/i, /\btypescript\b/i, /\byarn\b/i, /\bpnpm\b/i],
	},
	pypi: {
		name: "pypi",
		docsDomains: ["pypi.org", "readthedocs.io"],
		registryDomains: ["pypi.org"],
		supportDomains: ["github.com"],
		clues: [/\bpypi\b/i, /\bpip\b/i, /\bpython\b/i, /\bpoetry\b/i],
	},
	crates: {
		name: "crates",
		docsDomains: ["docs.rs"],
		registryDomains: ["crates.io"],
		supportDomains: ["github.com"],
		clues: [/\bcrates?\.io\b/i, /\bcargo\b/i, /\brust\b/i],
	},
	hex: {
		name: "hex",
		docsDomains: ["hexdocs.pm"],
		registryDomains: ["hex.pm"],
		supportDomains: ["github.com"],
		clues: [/\bhexdocs\b/i, /\bhex\.pm\b/i, /\bhex\b/i, /\belixir\b/i, /\berlang\b/i],
	},
	go: {
		name: "go",
		docsDomains: ["pkg.go.dev", "go.dev"],
		registryDomains: ["pkg.go.dev"],
		supportDomains: ["github.com"],
		clues: [/\bpkg\.go\.dev\b/i, /\bgo package\b/i, /\bgo module\b/i, /\bgolang\b/i],
	},
	maven: {
		name: "maven",
		docsDomains: ["javadoc.io"],
		registryDomains: ["search.maven.org", "central.sonatype.com"],
		supportDomains: ["github.com"],
		clues: [/\bmaven\b/i, /\bgradle\b/i, /\bjvm\b/i, /\bkotlin\b/i, /\bartifact\b/i, /[a-z0-9_.-]+:[a-z0-9_.-]+/i],
	},
};

const GENERIC_PACKAGE_TOKENS = new Set([
	"official", "docs", "documentation", "guide", "guides", "reference", "references", "api", "config", "configuration", "release", "releases", "release-notes", "notes", "changelog", "migration", "migrate", "upgrade", "upgrading", "breaking", "changes", "impact", "compare", "comparison", "tradeoffs", "trade-offs", "architecture", "best", "practice", "practices", "community", "issue", "issues", "discussion", "discussions", "github", "repo", "repository", "server", "runtime", "framework", "library", "libraries", "tool", "tools", "package", "packages", "version", "versions", "latest", "current", "with", "without", "what", "which", "how", "from", "into", "using", "vercel", "next", "nextjs", "react", "aws", "sqs", "eventbridge"
]);

export function resolveEcosystemHints(params = {}) {
	const rawQuery = String(params.rawQuery || "").trim();
	const normalizedQuery = String(params.normalizedQuery || "").trim();
	const queryMode = String(params.queryMode || "general");
	const preferredDomains = Array.isArray(params.preferredDomains) ? params.preferredDomains : [];
	const exactTerms = Array.isArray(params.exactTerms) ? params.exactTerms : [];
	const packageCandidates = detectPackageCandidates(rawQuery, exactTerms);
	if (packageCandidates.length === 0) {
		return { packageCandidates: [], hints: [] };
	}
	if (!["migration", "technical-change", "release", "bugfix", "repo", "architecture"].includes(queryMode)) {
		return { packageCandidates, hints: [] };
	}
	const explicit = detectExplicitEcosystems(rawQuery, normalizedQuery);
	const inferred = explicit.length > 0 ? explicit : inferEcosystemsFromCandidates(packageCandidates, normalizedQuery, queryMode);
	const hints = [];
	for (const ecosystemName of inferred.slice(0, 3)) {
		const ecosystem = ECOSYSTEMS[ecosystemName];
		if (!ecosystem) continue;
		for (const packageName of packageCandidates.slice(0, 2)) {
			if (!shouldHintForPackage(packageName, ecosystemName)) continue;
			const mergedPreferredDomains = unique([
				...preferredDomains,
				...ecosystem.docsDomains,
				...ecosystem.registryDomains,
			]);
			hints.push({
				ecosystem: ecosystem.name,
				packageName,
				confidence: explicit.includes(ecosystemName) ? "high" : queryMode === "migration" || queryMode === "technical-change" ? "medium" : "low",
				preferredDomains: mergedPreferredDomains,
				docsDomains: ecosystem.docsDomains,
				registryDomains: ecosystem.registryDomains,
				supportDomains: ecosystem.supportDomains,
				queryHints: buildQueryHints(packageName, ecosystem, queryMode),
			});
		}
	}
	return {
		packageCandidates,
		hints: dedupeHints(hints).slice(0, 4),
	};
}

function detectExplicitEcosystems(rawQuery, normalizedQuery) {
	const combined = `${rawQuery} ${normalizedQuery}`;
	return Object.entries(ECOSYSTEMS)
		.filter(([, ecosystem]) => ecosystem.clues.some((pattern) => pattern.test(combined)))
		.map(([name]) => name);
}

function inferEcosystemsFromCandidates(packageCandidates, normalizedQuery, queryMode) {
	const inferred = [];
	const joined = packageCandidates.join(" ");
	if (/\bnode\b|\btypescript\b|\bjavascript\b/.test(normalizedQuery) || packageCandidates.some((candidate) => candidate.startsWith("@") || candidate.includes("-"))) {
		inferred.push("npm");
	}
	if (/\bpython\b|\bpip\b|\bpypi\b/.test(normalizedQuery) || packageCandidates.some((candidate) => candidate.includes("_"))) {
		inferred.push("pypi");
	}
	if (/\brust\b|\bcargo\b|\bcrate\b/.test(normalizedQuery)) {
		inferred.push("crates");
	}
	if (/\belixir\b|\berlang\b|\bhex\b/.test(normalizedQuery) || /[A-Z].*[A-Z]/.test(joined) || packageCandidates.some(looksLikeCamelCasePackage)) {
		inferred.push("hex");
	}
	if (/\bgolang\b|\bgo module\b|\bpkg\.go\.dev\b/.test(normalizedQuery) || packageCandidates.some((candidate) => candidate.includes("."))) {
		inferred.push("go");
	}
	if (/\bmaven\b|\bgradle\b|\bartifact\b/.test(normalizedQuery) || packageCandidates.some((candidate) => candidate.includes(":"))) {
		inferred.push("maven");
	}
	if (inferred.length === 0 && ["migration", "technical-change", "release", "bugfix"].includes(queryMode)) {
		if (packageCandidates.some(looksLikeCamelCasePackage)) inferred.push("hex");
		if (packageCandidates.some((candidate) => candidate.includes("-") || candidate.startsWith("@"))) inferred.push("npm");
		inferred.push("pypi");
	}
	return unique(inferred);
}

function detectPackageCandidates(rawQuery, exactTerms) {
	const candidates = new Set();
	for (const term of exactTerms || []) {
		const normalized = normalizePackageCandidate(term);
		if (normalized) candidates.add(normalized);
	}
	for (const token of String(rawQuery || "").split(/\s+/)) {
		const normalized = normalizePackageCandidate(token);
		if (normalized) candidates.add(normalized);
	}
	return [...candidates].slice(0, 4);
}

function normalizePackageCandidate(value) {
	const original = String(value || "").trim();
	if (!original) return undefined;
	const cleaned = original.replace(/^[^\p{L}\p{N}@._:/-]+|[^\p{L}\p{N}@._:/-]+$/gu, "");
	if (!cleaned || cleaned.length < 3 || cleaned.length > 64) return undefined;
	if (/^v?\d+(?:\.\d+){0,3}$/i.test(cleaned)) return undefined;
	if (/^(site:|https?:\/\/)/i.test(cleaned)) return undefined;
	if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned) && !cleaned.includes("/")) return undefined;
	if (GENERIC_PACKAGE_TOKENS.has(cleaned.toLowerCase())) return undefined;
	if (!/[A-Za-z]/.test(cleaned)) return undefined;
	if (!looksLikePackageCandidate(cleaned)) return undefined;
	return cleaned;
}

function looksLikePackageCandidate(value) {
	return /^@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(value)
		|| /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(value)
		|| looksLikeCamelCasePackage(value);
}

function looksLikeCamelCasePackage(value) {
	return /^[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+$/.test(String(value || ""));
}

function shouldHintForPackage(packageName, ecosystemName) {
	if (!packageName) return false;
	if (ecosystemName === "npm") return !/^[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+$/.test(packageName) || packageName.startsWith("@");
	if (ecosystemName === "go") return packageName.includes(".") || packageName.includes("/");
	if (ecosystemName === "maven") return packageName.includes(":") || packageName.includes(".");
	return true;
}

function buildQueryHints(packageName, ecosystem, queryMode) {
	const hints = [];
	for (const domain of ecosystem.docsDomains.slice(0, 2)) {
		hints.push(`"${packageName}" site:${domain}`);
		if (["migration", "technical-change"].includes(queryMode)) hints.push(`"${packageName}" migration guide site:${domain}`);
		if (["release", "migration", "technical-change"].includes(queryMode)) hints.push(`"${packageName}" release notes site:${domain}`);
		if (queryMode === "bugfix") hints.push(`"${packageName}" troubleshooting site:${domain}`);
	}
	for (const domain of ecosystem.registryDomains.slice(0, 2)) {
		hints.push(`"${packageName}" site:${domain}`);
		if (["release", "migration", "technical-change"].includes(queryMode)) hints.push(`"${packageName}" version changelog site:${domain}`);
	}
	for (const domain of ecosystem.supportDomains.slice(0, 1)) {
		hints.push(`"${packageName}" site:${domain}`);
		if (["migration", "technical-change", "bugfix", "release"].includes(queryMode)) hints.push(`"${packageName}" migration issue discussion site:${domain}`);
	}
	return unique(hints).slice(0, 8);
}

function dedupeHints(hints) {
	const seen = new Set();
	const output = [];
	for (const hint of hints) {
		const key = JSON.stringify([hint.ecosystem, hint.packageName]);
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(hint);
	}
	return output;
}

function unique(values) {
	return [...new Set((values || []).filter(Boolean))];
}
