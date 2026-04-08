import { assertSafeOutboundUrl } from "../extraction/direct.js";

export async function fetchRenderedPage(config, url) {
	assertSafeOutboundUrl(url, config);
	if (!config.playwrightEnabled) {
		throw new Error("Playwright fallback is disabled");
	}
	let playwright;
	try {
		playwright = await import("playwright");
	} catch {
		throw new Error("Playwright package is not installed");
	}
	const browser = await playwright.chromium.launch(config.playwrightLaunchOptions);
	try {
		const page = await browser.newPage({ userAgent: config.userAgent });
		await page.goto(url, { waitUntil: "networkidle", timeout: config.requestTimeoutMs });
		const html = await page.content();
		const title = await page.title();
		return { html, title };
	} finally {
		await browser.close();
	}
}
