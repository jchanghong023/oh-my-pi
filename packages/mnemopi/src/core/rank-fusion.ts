/** Iterate ranked lists, counting each key only once per list. */
export function forEachRankContribution<T, K>(
	lists: readonly (readonly T[])[],
	key: (item: T) => K,
	visit: (item: T, key: K, contribution: number) => void,
	k = 60,
): void {
	for (const list of lists) {
		const seen = new Set<K>();
		for (const item of list) {
			const id = key(item);
			if (seen.has(id)) continue;
			seen.add(id);
			visit(item, id, 1 / (k + seen.size));
		}
	}
}

/** Fuse already-ranked lists using RRF and an explicit stable identity tie-breaker. */
export function fuseRanked<T, K>(
	lists: readonly (readonly T[])[],
	key: (item: T) => K,
	compareKeys: (a: K, b: K) => number,
	k = 60,
): Array<{ key: K; item: T; score: number }> {
	const fused = new Map<K, { key: K; item: T; score: number }>();
	forEachRankContribution(
		lists,
		key,
		(item, id, contribution) => {
			const existing = fused.get(id);
			if (existing) existing.score += contribution;
			else fused.set(id, { key: id, item, score: contribution });
		},
		k,
	);
	return [...fused.values()].sort((a, b) => b.score - a.score || compareKeys(a.key, b.key));
}
