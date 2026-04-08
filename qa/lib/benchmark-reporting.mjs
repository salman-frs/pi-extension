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
