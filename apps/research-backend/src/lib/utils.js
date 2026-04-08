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

export function nowIso() {
	return new Date().toISOString();
}
