export function createLogger(config = {}) {
	const enabled = config.telemetryEnabled !== false;
	return {
		info(event, data = {}) {
			log("info", event, data);
		},
		warn(event, data = {}) {
			log("warn", event, data);
		},
		error(event, data = {}) {
			log("error", event, data);
		},
	};

	function log(level, event, data) {
		if (!enabled) return;
		const payload = {
			ts: new Date().toISOString(),
			level,
			event,
			...safeJson(data),
		};
		console.log(JSON.stringify(payload));
	}
}

function safeJson(value) {
	return JSON.parse(JSON.stringify(value, (_key, current) => {
		if (current instanceof Error) {
			return { message: current.message, stack: current.stack };
		}
		return current;
	}));
}

let requestCounter = 0;
export function nextRequestId() {
	requestCounter += 1;
	return `req_${Date.now()}_${requestCounter}`;
}
