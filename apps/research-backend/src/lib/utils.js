export function trim(value) {
	const result = typeof value === "string" ? value.trim() : "";
	return result ? result : undefined;
}

export function hostnameFromUrl(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

export function normalizeDomain(domain) {
	return trim(domain)?.toLowerCase().replace(/^www\./, "");
}

export function domainMatches(domain, target) {
	const a = normalizeDomain(domain);
	const b = normalizeDomain(target);
	if (!a || !b) return false;
	return a === b || a.endsWith(`.${b}`);
}

export function dedupeBy(items, keyFn) {
	const seen = new Set();
	const output = [];
	for (const item of items) {
		const key = keyFn(item);
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(item);
	}
	return output;
}

export function safeArray(value) {
	return Array.isArray(value) ? value : [];
}

export function arrayOfStrings(value) {
	return safeArray(value).filter((item) => typeof item === "string" && item.trim().length > 0);
}

export function clip(text, maxChars) {
	if (!text) return "";
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

export function unique(values) {
	return [...new Set(values.filter(Boolean))];
}

export function normalizeComparableUrl(url) {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		parsed.search = "";
		let path = parsed.pathname || "/";
		path = path
			.replace(/\/index\.(md|html?)$/i, "/")
			.replace(/\/(llms-full|llms)\.txt$/i, "/")
			.replace(/\.md$/i, "")
			.replace(/\/(v\d+(?:\.\d+)*)\//i, "/")
			.replace(/\/+/g, "/");
		if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
		parsed.pathname = path || "/";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

export function comparableUrlKey(url) {
	return normalizeComparableUrl(url) || trim(url) || "";
}

export function versionHintFromUrl(url) {
	const value = String(url || "");
	const match = value.match(/\/(v\d+(?:\.\d+)*)\//i);
	return match?.[1]?.toLowerCase();
}

export function ageInDays(value) {
	const ts = Date.parse(String(value || ""));
	if (!Number.isFinite(ts)) return undefined;
	return Math.max(0, Math.round((Date.now() - ts) / 86_400_000));
}

export function nowIso() {
	return new Date().toISOString();
}
