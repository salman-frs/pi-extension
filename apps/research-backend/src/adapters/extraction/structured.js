import { cleanupWhitespace, decodeEntities, extractCallouts, extractHeadings, htmlToText } from "../../lib/text.js";
import { clip } from "../../lib/utils.js";

const CONTENT_SELECTORS = [
	/article[^>]*>[\s\S]*?<\/article>/i,
	/<main[^>]*>[\s\S]*?<\/main>/i,
	/<div[^>]+id=["'][^"']*(?:content|main-content|docs-content)[^"']*["'][^>]*>[\s\S]*?<\/div>/i,
	/<div[^>]+class=["'][^"']*(?:theme-doc-markdown|markdown|documentation|content-body|docs-content|prose|vp-doc)[^"']*["'][^>]*>[\s\S]*?<\/div>/i,
	/<section[^>]+class=["'][^"']*(?:content|docs|prose|documentation)[^"']*["'][^>]*>[\s\S]*?<\/section>/i,
];

export function extractStructuredContent(html, options = {}) {
	const normalizedHtml = String(html || "");
	const cleanedHtml = stripNoise(normalizedHtml);
	const frameworkHints = detectFrameworkHints(cleanedHtml, options.url);
	const contentFragment = pickBestContentFragment(cleanedHtml);
	const contentHtml = contentFragment || cleanedHtml;
	const fullText = htmlToText(cleanedHtml);
	const focusedText = htmlToText(contentHtml);
	const content = pickBestText(fullText, focusedText);
	const headings = extractHeadings(contentHtml, 10);
	const codeSnippets = extractCodeSnippets(contentHtml, 6);
	const callouts = extractAdmonitions(contentHtml, focusedText, 6);
	const shellLikelihood = estimateShellLikelihood({ normalizedHtml, cleanedHtml, content, headings, codeSnippets, frameworkHints });
	const extractionConfidence = classifyExtractionConfidence({ content, headings, codeSnippets, shellLikelihood, frameworkHints });
	return {
		content,
		headings,
		codeSnippets,
		callouts,
		frameworkHints,
		diagnostics: {
			strategy: "structured-html-extractor",
			frameworkHints,
			contentLength: content.length,
			headingsCount: headings.length,
			codeBlockCount: codeSnippets.length,
			shellLikelihood,
			extractionConfidence,
			usedFocusedFragment: Boolean(contentFragment),
		},
	};
}

function stripNoise(html) {
	return String(html || "")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ")
		.replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");
}

function pickBestContentFragment(html) {
	const candidates = [];
	for (const pattern of CONTENT_SELECTORS) {
		const match = String(html || "").match(pattern);
		if (match?.[0]) {
			candidates.push(match[0]);
		}
	}
	if (candidates.length === 0) return undefined;
	return candidates
		.map((candidate) => ({ candidate, score: scoreFragment(candidate) }))
		.sort((a, b) => b.score - a.score)[0]?.candidate;
}

function scoreFragment(fragment) {
	const text = htmlToText(fragment);
	const headingCount = (fragment.match(/<h[1-3][^>]*>/gi) || []).length;
	const codeCount = (fragment.match(/<(pre|code)[^>]*>/gi) || []).length;
	const paragraphCount = (fragment.match(/<p[^>]*>/gi) || []).length;
	return text.length + headingCount * 180 + codeCount * 220 + paragraphCount * 60;
}

function pickBestText(fullText, focusedText) {
	const best = focusedText.length >= Math.max(300, fullText.length * 0.35) ? focusedText : fullText;
	return cleanupWhitespace(best);
}

function extractCodeSnippets(html, limit = 6) {
	const snippets = [];
	for (const match of String(html || "").matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)) {
		const code = cleanupWhitespace(decodeEntities(match[1].replace(/<[^>]+>/g, " ")));
		if (!code || code.length < 12) continue;
		snippets.push(clip(code, 320));
		if (snippets.length >= limit) break;
	}
	if (snippets.length > 0) return snippets;
	for (const match of String(html || "").matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gi)) {
		const code = cleanupWhitespace(decodeEntities(match[1].replace(/<[^>]+>/g, " ")));
		if (!code || code.length < 18) continue;
		snippets.push(clip(code, 240));
		if (snippets.length >= limit) break;
	}
	return snippets;
}

function extractAdmonitions(html, text, limit = 6) {
	const outputs = [];
	for (const match of String(html || "").matchAll(/<(div|aside)[^>]+class=["'][^"']*(?:admonition|callout|warning|tip|note|caution|danger|info)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi)) {
		const value = cleanupWhitespace(decodeEntities(match[2].replace(/<[^>]+>/g, " ")));
		if (!value || value.length < 20) continue;
		outputs.push(clip(value, 240));
		if (outputs.length >= limit) return outputs;
	}
	return extractCallouts(text, limit).map((item) => clip(item, 240));
}

function detectFrameworkHints(html, url) {
	const combined = `${String(html || "")} ${String(url || "")}`.toLowerCase();
	const hints = [];
	if (/mintlify|mintlify-content|__mintlify/.test(combined)) hints.push("mintlify");
	if (/__docusaurus|docusaurus|theme-doc-markdown/.test(combined)) hints.push("docusaurus");
	if (/vitepress|vp-doc|vp-content/.test(combined)) hints.push("vitepress");
	if (/nextra|nextra-theme-docs/.test(combined)) hints.push("nextra");
	if (/mkdocs|material for mkdocs/.test(combined)) hints.push("mkdocs");
	return [...new Set(hints)];
}

function estimateShellLikelihood({ normalizedHtml, content, headings, codeSnippets, frameworkHints }) {
	let score = 0;
	const text = String(content || "").toLowerCase();
	const html = String(normalizedHtml || "").toLowerCase();
	if (text.length < 220) score += 0.35;
	if (headings.length === 0) score += 0.15;
	if (codeSnippets.length === 0) score += 0.05;
	if (/enable javascript|app shell|loading\.\.\.|javascript required|hydration|next-router-announcer/.test(text)) score += 0.35;
	if (/__next|__docusaurus|vitepress|mintlify/.test(html) && text.length < 500) score += 0.2;
	if (frameworkHints.length > 0 && text.length < 400) score += 0.15;
	return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function classifyExtractionConfidence({ content, headings, codeSnippets, shellLikelihood, frameworkHints }) {
	if (shellLikelihood >= 0.65) return "low";
	if (content.length >= 1200 && headings.length >= 2) return frameworkHints.length > 0 || codeSnippets.length > 0 ? "high" : "medium";
	if (content.length >= 500 && headings.length >= 1) return "medium";
	if (content.length >= 240) return "medium";
	return "low";
}
