export function createCacheStore(config = {}) {
	const namespaces = new Map();
	const stats = new Map();
	const enabled = config.cacheEnabled !== false;

	return {
		enabled,
		get(namespace, key) {
			if (!enabled) return undefined;
			const bucket = namespaces.get(namespace);
			if (!bucket) return undefined;
			const entry = bucket.get(key);
			if (!entry) {
				record(namespace, "misses");
				return undefined;
			}
			if (entry.expiresAt <= Date.now()) {
				bucket.delete(key);
				record(namespace, "misses");
				return undefined;
			}
			record(namespace, "hits");
			return entry.value;
		},
		set(namespace, key, value, ttlMs) {
			if (!enabled) return value;
			const bucket = ensureBucket(namespace);
			bucket.set(key, {
				value,
				expiresAt: Date.now() + Math.max(1, ttlMs || 1),
			});
			record(namespace, "writes");
			return value;
		},
		delete(namespace, key) {
			const bucket = namespaces.get(namespace);
			if (!bucket) return false;
			return bucket.delete(key);
		},
		clear(namespace) {
			if (!namespace) {
				namespaces.clear();
				stats.clear();
				return;
			}
			namespaces.delete(namespace);
			stats.delete(namespace);
		},
		stats() {
			const output = {};
			for (const [namespace, bucket] of namespaces.entries()) {
				const namespaceStats = stats.get(namespace) || { hits: 0, misses: 0, writes: 0 };
				output[namespace] = {
					entries: bucket.size,
					...namespaceStats,
				};
			}
			return output;
		},
		memo(namespace, key, ttlMs, compute) {
			const cached = this.get(namespace, key);
			if (cached !== undefined) return Promise.resolve({ value: cached, cache: { hit: true, namespace, key } });
			return Promise.resolve(compute()).then((value) => {
				this.set(namespace, key, value, ttlMs);
				return { value, cache: { hit: false, namespace, key } };
			});
		},
	};

	function ensureBucket(namespace) {
		if (!namespaces.has(namespace)) namespaces.set(namespace, new Map());
		return namespaces.get(namespace);
	}

	function record(namespace, field) {
		const current = stats.get(namespace) || { hits: 0, misses: 0, writes: 0 };
		current[field] += 1;
		stats.set(namespace, current);
	}
}

export function stableCacheKey(value) {
	return JSON.stringify(sortValue(value));
}

function sortValue(value) {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value && typeof value === "object") {
		return Object.keys(value)
			.sort()
			.reduce((acc, key) => {
				acc[key] = sortValue(value[key]);
				return acc;
			}, {});
	}
	return value;
}
