const DEFAULT_TRACE_LIMIT = 100;
const DEFAULT_PROVIDER_FAILURE_THRESHOLD = 6;
const DEFAULT_PROVIDER_COOLDOWN_MS = 120_000;

export function createTelemetry(config = {}) {
	const enabled = config.telemetryEnabled !== false;
	const traceLimit = Math.max(10, Number(config.traceStoreLimit || DEFAULT_TRACE_LIMIT));
	const traces = [];
	const counters = new Map();
	const histograms = new Map();
	const providerStates = new Map();

	return {
		enabled,
		startRequest(info = {}) {
			const trace = {
				requestId: info.requestId,
				method: info.method,
				path: info.path,
				startedAt: Date.now(),
				spans: [],
				events: [],
				status: "running",
			};
			incrementCounter("requests.total", 1, { path: info.path, method: info.method });
			return trace;
		},
		startSpan(trace, name, attributes = {}) {
			if (!trace) return undefined;
			const span = {
				id: `${trace.requestId || "trace"}.${trace.spans.length + 1}`,
				name,
				startedAt: Date.now(),
				status: "running",
				attributes: { ...attributes },
			};
			trace.spans.push(span);
			return span;
		},
		endSpan(trace, span, status = "ok", attributes = {}) {
			if (!trace || !span) return;
			span.endedAt = Date.now();
			span.durationMs = span.endedAt - span.startedAt;
			span.status = status;
			span.attributes = { ...(span.attributes || {}), ...attributes };
			observeHistogram(`span.duration.${span.name}`, span.durationMs, { status });
		},
		addEvent(trace, name, attributes = {}) {
			if (!trace) return;
			trace.events.push({
				name,
				at: Date.now(),
				attributes: { ...attributes },
			});
		},
		recordProviderResult(name, outcome = {}) {
			const state = getProviderState(name);
			const ok = outcome.ok !== false;
			if (ok) {
				state.successCount += 1;
				state.consecutiveFailures = 0;
				state.lastSuccessAt = new Date().toISOString();
				state.lastStatus = outcome.status || "success";
				state.lastError = undefined;
				if (state.openUntil && Date.now() >= state.openUntil) state.openUntil = undefined;
			} else {
				state.failureCount += 1;
				state.consecutiveFailures += 1;
				state.lastFailureAt = new Date().toISOString();
				state.lastStatus = outcome.status || "failure";
				state.lastError = outcome.error ? String(outcome.error) : outcome.code || "unknown";
				if (config.providerCircuitBreakerEnabled !== false && state.consecutiveFailures >= Number(config.providerFailureThreshold || DEFAULT_PROVIDER_FAILURE_THRESHOLD)) {
					state.openUntil = Date.now() + Number(config.providerCooldownMs || DEFAULT_PROVIDER_COOLDOWN_MS);
				}
			}
			incrementCounter("provider.requests", 1, { provider: name, outcome: ok ? "success" : "failure" });
			if (Number.isFinite(outcome.latencyMs)) observeHistogram("provider.latency", outcome.latencyMs, { provider: name, outcome: ok ? "success" : "failure" });
		},
		shouldAllowProvider(name) {
			const state = getProviderState(name);
			if (!state.openUntil) return { allowed: true };
			if (Date.now() >= state.openUntil) {
				state.openUntil = undefined;
				state.consecutiveFailures = 0;
				return { allowed: true };
			}
			return { allowed: false, retryAt: new Date(state.openUntil).toISOString() };
		},
		finishRequest(trace, outcome = {}) {
			if (!trace) return;
			trace.endedAt = Date.now();
			trace.durationMs = trace.endedAt - trace.startedAt;
			trace.status = outcome.status || "success";
			trace.statusCode = outcome.statusCode;
			trace.error = outcome.error ? String(outcome.error) : undefined;
			trace.summary = summarizeTrace(trace);
			observeHistogram("request.duration", trace.durationMs, { path: trace.path, status: trace.status });
			incrementCounter("requests.completed", 1, { path: trace.path, status: trace.status, method: trace.method });
			if (enabled) {
				traces.unshift(compactTrace(trace));
				if (traces.length > traceLimit) traces.length = traceLimit;
			}
		},
		getRecentTraces(limit = 20) {
			return traces.slice(0, Math.max(1, limit));
		},
		getMetrics() {
			return {
				counters: Object.fromEntries([...counters.entries()].map(([key, value]) => [key, value])),
				histograms: Object.fromEntries([...histograms.entries()].map(([key, value]) => [key, summarizeHistogram(value)])),
			};
		},
		getProviderHealth() {
			return [...providerStates.values()].map((state) => ({
				provider: state.provider,
				health: state.openUntil && state.openUntil > Date.now() ? "circuit_open" : state.consecutiveFailures > 0 ? "degraded" : "healthy",
				successCount: state.successCount,
				failureCount: state.failureCount,
				consecutiveFailures: state.consecutiveFailures,
				lastStatus: state.lastStatus,
				lastSuccessAt: state.lastSuccessAt,
				lastFailureAt: state.lastFailureAt,
				lastError: state.lastError,
				circuitOpenUntil: state.openUntil ? new Date(state.openUntil).toISOString() : undefined,
			}));
		},
		getSummary() {
			const completed = filterCounters("requests.completed");
			return {
				enabled,
				traceMode: config.traceMode || "standard",
				storedTraces: traces.length,
				requestCounts: completed,
				providerHealth: this.getProviderHealth(),
			};
		},
	};

	function getProviderState(name) {
		if (!providerStates.has(name)) {
			providerStates.set(name, {
				provider: name,
				successCount: 0,
				failureCount: 0,
				consecutiveFailures: 0,
				lastStatus: undefined,
				lastSuccessAt: undefined,
				lastFailureAt: undefined,
				lastError: undefined,
				openUntil: undefined,
			});
		}
		return providerStates.get(name);
	}

	function incrementCounter(name, value = 1, labels = {}) {
		const key = metricKey(name, labels);
		counters.set(key, (counters.get(key) || 0) + value);
	}

	function observeHistogram(name, value, labels = {}) {
		const key = metricKey(name, labels);
		const current = histograms.get(key) || [];
		current.push(Number(value || 0));
		if (current.length > 200) current.shift();
		 histograms.set(key, current);
	}

	function filterCounters(prefix) {
		return Object.fromEntries(
			[...counters.entries()]
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, value]) => [key, value]),
		);
	}
}

export async function traceStep(helpers, name, attributes, compute) {
	const span = helpers.telemetry?.startSpan(helpers.trace, name, attributes);
	try {
		const result = await compute();
		helpers.telemetry?.endSpan(helpers.trace, span, "ok");
		return result;
	} catch (error) {
		helpers.telemetry?.endSpan(helpers.trace, span, "error", { error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
}

export function summarizeTrace(trace) {
	if (!trace) return undefined;
	return {
		requestId: trace.requestId,
		path: trace.path,
		method: trace.method,
		status: trace.status,
		durationMs: trace.durationMs,
		spanCount: (trace.spans || []).length,
		eventCount: (trace.events || []).length,
		stages: (trace.spans || []).map((span) => ({
			name: span.name,
			status: span.status,
			durationMs: span.durationMs,
		})),
	};
}

function compactTrace(trace) {
	return {
		requestId: trace.requestId,
		method: trace.method,
		path: trace.path,
		startedAt: new Date(trace.startedAt).toISOString(),
		endedAt: trace.endedAt ? new Date(trace.endedAt).toISOString() : undefined,
		status: trace.status,
		statusCode: trace.statusCode,
		error: trace.error,
		durationMs: trace.durationMs,
		spans: (trace.spans || []).map((span) => ({
			id: span.id,
			name: span.name,
			status: span.status,
			durationMs: span.durationMs,
			attributes: span.attributes,
		})),
		events: (trace.events || []).slice(-40),
		summary: summarizeTrace(trace),
	};
}

function summarizeHistogram(values) {
	if (!values?.length) return { count: 0, min: 0, max: 0, p50: 0, p95: 0, avg: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((acc, value) => acc + value, 0);
	return {
		count: sorted.length,
		min: sorted[0],
		max: sorted[sorted.length - 1],
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		avg: Number((sum / sorted.length).toFixed(2)),
	};
}

function percentile(values, ratio) {
	if (!values.length) return 0;
	const index = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * ratio)));
	return values[index];
}

function metricKey(name, labels = {}) {
	const entries = Object.entries(labels || {}).filter(([, value]) => value != null && value !== "").sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return name;
	return `${name}{${entries.map(([key, value]) => `${key}=${String(value)}`).join(",")}}`;
}
