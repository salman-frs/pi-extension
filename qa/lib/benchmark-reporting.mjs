export function annotateBenchmarkCases(mode, cases) {
	return (cases || []).map((item) => ({
		...item,
		benchmarkStyle: describeBenchmarkStyle(mode, item.name),
	}));
}

export function summarizeBenchmarkFamilies(cases) {
	const summary = new Map();
	for (const item of cases || []) {
		const family = item.benchmarkStyle?.family || "custom";
		const current = summary.get(family) || { family, cases: 0, score: 0, maxScore: 0, publicStyles: new Set() };
		current.cases += 1;
		current.score += Number(item.score || 0);
		current.maxScore += Number(item.maxScore || 0);
		for (const style of item.benchmarkStyle?.publicStyles || []) current.publicStyles.add(style);
		summary.set(family, current);
	}
	return [...summary.values()].map((item) => ({
		family: item.family,
		cases: item.cases,
		score: item.score,
		maxScore: item.maxScore,
		publicStyles: [...item.publicStyles],
	}));
}

export function renderBenchmarkMappingSection(report) {
	const lines = [
		"## Benchmark style mapping",
		"",
		"This suite is intentionally composite. It maps internal cases to public benchmark styles instead of claiming that one public benchmark fully covers the product.",
		"",
	];
	for (const family of report.benchmarkFamilies || []) {
		lines.push(`- **${family.family}** — ${family.score}/${family.maxScore} across ${family.cases} case(s)`);
		if (family.publicStyles?.length) lines.push(`  - Public styles: ${family.publicStyles.join(", ")}`);
	}
	lines.push("");
	return lines.join("\n");
}

export function summarizeFailureBuckets(cases) {
	const summary = new Map();
	for (const benchmarkCase of cases || []) {
		for (const rule of benchmarkCase.checks || []) {
			if (rule.pass) continue;
			const bucket = classifyFailureBucket(benchmarkCase, rule);
			const current = summary.get(bucket) || { bucket, failures: 0, pointsLost: 0, examples: [] };
			current.failures += 1;
			current.pointsLost += Number(rule.maxPoints || 0) - Number(rule.points || 0);
			if (current.examples.length < 3) current.examples.push(`${benchmarkCase.name}: ${rule.name}`);
			summary.set(bucket, current);
		}
	}
	return [...summary.values()].sort((a, b) => b.pointsLost - a.pointsLost || b.failures - a.failures);
}

export function renderFailureBucketSection(report) {
	const buckets = report.failureBuckets || [];
	const lines = [
		"## Failure buckets",
		"",
	];
	if (!buckets.length) {
		lines.push("- No failed checks were recorded in this run.");
		lines.push("");
		return lines.join("\n");
	}
	for (const bucket of buckets) {
		lines.push(`- **${bucket.bucket}** — ${bucket.failures} failed check(s), ${bucket.pointsLost} point(s) lost`);
		for (const example of bucket.examples || []) lines.push(`  - ${example}`);
	}
	lines.push("");
	return lines.join("\n");
}

export function summarizeStability(runs) {
	const values = (runs || []).map((item) => Number(item?.percentage)).filter((value) => Number.isFinite(value));
	if (!values.length) return undefined;
	const min = Math.min(...values);
	const max = Math.max(...values);
	const avg = Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
	return {
		runs: values.length,
		min,
		max,
		avg,
		spread: Number((max - min).toFixed(2)),
	};
}

function describeBenchmarkStyle(mode, caseName) {
	const name = String(caseName || "").toLowerCase();
	if (mode === "agent") {
		return {
			family: "assistant-research-workflow",
			publicStyles: ["GAIA-like", "BrowseComp-like"],
			rationale: "End-to-end agent tasks that depend on research tools inside a coding-assistant workflow.",
		};
	}
	if (name.includes("exact-config") || name.includes("canonical") || name.includes("fetch-docs") || name.includes("search-docs") || name.includes("search-github-repo")) {
		return {
			family: "exact-retrieval",
			publicStyles: ["SimpleQA-like", "FRAMES-like"],
			rationale: "Measures precise lookup, exact-reference retrieval, and citation-oriented fetch quality.",
		};
	}
	if (name.includes("discovery") || name.includes("github-official-entity") || name.includes("search-github") || name.includes("research-discovery")) {
		return {
			family: "browsing-discovery",
			publicStyles: ["BrowseComp-like", "GAIA-like"],
			rationale: "Measures persistence and quality on harder discovery-style web research tasks.",
		};
	}
	if (name.includes("research-best-practice") || name.includes("research-technical") || name.includes("research-architecture") || name.includes("cache-effectiveness")) {
		return {
			family: "deep-research",
			publicStyles: ["FRAMES-like", "GAIA-like"],
			rationale: "Measures multi-source synthesis, grounded recommendations, and reasoning over retrieved evidence.",
		};
	}
	return {
		family: "custom-technical-research",
		publicStyles: ["Custom technical benchmark"],
		rationale: "Covers technical web-research behaviors that generic public benchmarks do not fully capture.",
	};
}

function classifyFailureBucket(benchmarkCase, rule) {
	const haystack = `${benchmarkCase?.name || ""} ${rule?.name || ""} ${rule?.detail || ""}`.toLowerCase();
	if (/official|canonical|preferred-domain|preferred domain|exact config|exact reference|release/.test(haystack)) return "official-or-canonical-retrieval";
	if (/ranking|reason|explanation|trace/.test(haystack)) return "ranking-and-explainability";
	if (/trust|authority|freshness/.test(haystack)) return "trust-and-freshness-signals";
	if (/fetch|markdown|html|content|extraction|rendered|shell/.test(haystack)) return "extraction-and-fetch-quality";
	if (/answer|summary|recommendation|agreement|disagreement|citation|ground/.test(haystack)) return "synthesis-and-grounding";
	if (/tool|agent|workflow|section/.test(haystack)) return "agent-orchestration";
	if (/cache|latency|performance/.test(haystack)) return "cache-and-performance";
	if (/result|source|count|search/.test(haystack)) return "retrieval-coverage";
	return "other";
}
