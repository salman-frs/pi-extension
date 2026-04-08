const STOPWORDS = new Set([
	"the","a","an","and","or","but","for","to","of","in","on","at","by","with","from","is","are","was","were","be","been","being","that","this","these","those","it","its","as","into","about","after","before","during","over","under","than","then","also","can","could","should","would","will","just","not","no","yes","if","we","you","they","he","she","them","his","her","their","our","us"
]);

export function decodeEntities(text) {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

export function cleanupWhitespace(text) {
	return (text || "")
		.replace(/\r/g, "")
		.replace(/\t/g, " ")
		.replace(/[ \u00A0]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line, index, arr) => line.length > 0 || (index > 0 && arr[index - 1].length > 0))
		.join("\n")
		.trim();
}

export function htmlToText(html) {
	const withoutScripts = (html || "")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
	const withBreaks = withoutScripts
		.replace(/<(br|hr)\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|main|aside|header|footer|li|ul|ol|h1|h2|h3|h4|h5|h6)>/gi, "\n");
	const stripped = withBreaks.replace(/<[^>]+>/g, " ");
	return cleanupWhitespace(decodeEntities(stripped));
}

export function stripMarkdownFrontmatter(markdown) {
	return String(markdown || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

export function extractFrontmatterValue(markdown, key) {
	const body = String(markdown || "");
	const match = body.match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
	return match?.[1]?.trim();
}

export function extractMarkdownTitle(markdown) {
	const frontmatterTitle = extractFrontmatterValue(markdown, "title");
	if (frontmatterTitle) return cleanupWhitespace(frontmatterTitle.replace(/^['\"]|['\"]$/g, ""));
	const heading = String(markdown || "").match(/^#\s+(.+)$/m);
	return heading ? cleanupWhitespace(heading[1]) : undefined;
}

export function markdownToText(markdown) {
	const withoutFrontmatter = stripMarkdownFrontmatter(markdown);
	const normalized = withoutFrontmatter
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, "\n"))
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*\]\(([^)]+)\)/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
		.replace(/^>\s?/gm, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^[-*+]\s+/gm, "- ")
		.replace(/^\d+\.\s+/gm, "- ")
		.replace(/\|/g, " ");
	return cleanupWhitespace(decodeEntities(normalized));
}

export function extractTitle(html) {
	const match = (html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? cleanupWhitespace(decodeEntities(match[1])) : undefined;
}

export function extractCanonicalUrl(html) {
	const match = (html || "").match(/<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i);
	return match?.[1];
}

export function extractHeadings(html, limit = 8) {
	const matches = [...String(html || "").matchAll(/<(h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>/gi)];
	return matches
		.map((match) => cleanupWhitespace(decodeEntities(match[2].replace(/<[^>]+>/g, " "))))
		.filter(Boolean)
		.slice(0, limit);
}

export function extractCodeBlocks(html, limit = 5) {
	const matches = [...String(html || "").matchAll(/<(pre|code)[^>]*>([\s\S]*?)<\/\1>/gi)];
	return matches
		.map((match) => cleanupWhitespace(decodeEntities(match[2].replace(/<[^>]+>/g, " "))))
		.filter((item) => item.length >= 6)
		.slice(0, limit);
}

export function extractCallouts(text, limit = 8) {
	return splitSentences(text)
		.filter((sentence) => /warning|deprecated|breaking|good to know|note|important|caution/i.test(sentence))
		.slice(0, limit);
}

export function splitSentences(text) {
	return cleanupWhitespace(text)
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 0);
}

export function tokenize(text) {
	return (text || "")
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

export function topKeywords(texts, limit = 10) {
	const counts = new Map();
	for (const text of texts) {
		for (const token of tokenize(text)) {
			counts.set(token, (counts.get(token) || 0) + 1);
		}
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([token]) => token);
}

export function scoreSentence(sentence, queryTokens) {
	const tokens = new Set(tokenize(sentence));
	let score = 0;
	for (const token of queryTokens) {
		if (tokens.has(token)) score += 1;
	}
	return score;
}

export function bestSentences(text, query, limit = 5) {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return splitSentences(text).slice(0, limit);
	return splitSentences(text)
		.map((sentence) => ({ sentence, score: scoreSentence(sentence, queryTokens) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((item) => item.sentence);
}
