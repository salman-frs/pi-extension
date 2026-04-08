export class ResearchError extends Error {
	constructor(code, message, options = {}) {
		super(message);
		this.name = "ResearchError";
		this.code = code;
		this.status = options.status ?? 500;
		this.retryable = options.retryable ?? false;
		this.details = options.details;
	}
}

export function errorPayload(error) {
	if (error instanceof ResearchError) {
		return {
			error: error.message,
			code: error.code,
			retryable: error.retryable,
			details: error.details,
		};
	}
	if (error instanceof SyntaxError) {
		return {
			error: error.message,
			code: "INVALID_JSON",
			retryable: false,
		};
	}
	return {
		error: error instanceof Error ? error.message : String(error),
		code: "INTERNAL_ERROR",
		retryable: false,
	};
}

export function classifyUpstreamSearchError(error, context = {}) {
	const message = error instanceof Error ? error.message : String(error);
	if (/abort|timed out|timeout/i.test(message)) {
		return new ResearchError("UPSTREAM_TIMEOUT", `Search upstream timed out for query: ${context.query || "unknown"}`, {
			status: 502,
			retryable: true,
			details: { provider: context.provider, query: context.query },
		});
	}
	if (/HTTP 5\d\d/.test(message)) {
		return new ResearchError("UPSTREAM_5XX", `Search upstream returned a server error for query: ${context.query || "unknown"}`, {
			status: 502,
			retryable: true,
			details: { provider: context.provider, query: context.query, raw: message },
		});
	}
	if (/HTTP 403/.test(message)) {
		return new ResearchError("UPSTREAM_FORBIDDEN", `Search upstream rejected the request for query: ${context.query || "unknown"}`, {
			status: 502,
			retryable: false,
			details: { provider: context.provider, query: context.query, raw: message },
		});
	}
	if (/Unexpected token|JSON|parse/i.test(message)) {
		return new ResearchError("PARSER_FAILURE", `Search upstream returned an unreadable response for query: ${context.query || "unknown"}`, {
			status: 502,
			retryable: true,
			details: { provider: context.provider, query: context.query, raw: message },
		});
	}
	return new ResearchError("UPSTREAM_SEARCH_FAILURE", `Search upstream failed for query: ${context.query || "unknown"}`, {
		status: 502,
		retryable: true,
		details: { provider: context.provider, query: context.query, raw: message },
	});
}

export function classifyFetchError(error, context = {}) {
	const message = error instanceof Error ? error.message : String(error);
	if (/HTTP 403/.test(message)) {
		return new ResearchError("FETCH_FORBIDDEN", `Fetch blocked by target site: ${context.url || "unknown"}`, {
			status: 502,
			retryable: false,
			details: { url: context.url, raw: message },
		});
	}
	if (/abort|timed out|timeout/i.test(message)) {
		return new ResearchError("FETCH_TIMEOUT", `Fetch timed out for URL: ${context.url || "unknown"}`, {
			status: 502,
			retryable: true,
			details: { url: context.url, raw: message },
		});
	}
	return new ResearchError("FETCH_FAILURE", `Fetch failed for URL: ${context.url || "unknown"}`, {
		status: 502,
		retryable: true,
		details: { url: context.url, raw: message },
	});
}
