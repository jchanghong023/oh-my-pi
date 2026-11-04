#!/usr/bin/env bun
/** Local lexical stand-ins for the company embedding and rerank APIs; not neural models. */

const EMBEDDING_MODEL = "Qwen3-Embedding-8B";
const RERANK_MODEL = "Qwen3-Reranker-8B";
const DIMENSIONS = 4096;
const USAGE = `Usage: bun scripts/mock-retrieval-models.ts [port]\n\nLocal-only mock: POST /v1/embeddings and POST /v1/rerank.\nModels: ${EMBEDDING_MODEL}, ${RERANK_MODEL}.\nVectors and scores are lexical simulations, not Qwen model outputs.`;

const portArg = process.argv[2];
if (portArg === "--help" || portArg === "-h") {
	console.log(USAGE);
	process.exit(0);
}
const port = portArg === undefined ? 18080 : Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535 || process.argv.length > 3) {
	throw new Error(USAGE);
}

const han = /\p{Script=Han}/u;
const wordCharacter = /[\p{L}\p{N}_]/u;

/** Produce deterministic lexical vectors with the company's response dimensions. */
function embed(text: string): Float32Array {
	const counts = new Float64Array(DIMENSIONS);
	const digest = new Uint8Array(20);
	let featureCount = 0;
	const add = (feature: string) => {
		Bun.SHA1.hash(feature, digest);
		const index = ((digest[0] << 8) | digest[1]) % DIMENSIONS;
		counts[index]++;
		featureCount++;
	};
	let word = "";
	let previousHan = "";
	for (const character of text.normalize("NFKC").toLowerCase()) {
		if (han.test(character)) {
			if (word) add(word);
			word = "";
			add(character);
			if (previousHan) add(previousHan + character);
			previousHan = character;
		} else {
			previousHan = "";
			if (wordCharacter.test(character)) {
				word += character;
			} else if (word) {
				add(word);
				word = "";
			}
		}
	}
	if (word) add(word);
	if (featureCount === 0) add("\0");
	// A small fixed component prevents zero lanes. The orthogonal transform makes
	// responses dense while preserving lexical cosine similarity.
	counts[0] += 0.0001;
	let squaredNorm = 0;
	for (const value of counts) squaredNorm += value * value;
	for (let half = 1; half < DIMENSIONS; half *= 2) {
		for (let start = 0; start < DIMENSIONS; start += half * 2) {
			for (let i = start; i < start + half; i++) {
				const left = counts[i];
				const right = counts[i + half];
				counts[i] = left + right;
				counts[i + half] = left - right;
			}
		}
	}
	const norm = Math.sqrt(squaredNorm * DIMENSIONS);
	return Float32Array.from(counts, value => value / norm);
}

function invalid(message: string, status = 400): Response {
	return Response.json({ error: { message, type: "invalid_request_error" } }, { status });
}

function embeddings(body: Record<string, unknown>): Response {
	if (body.model !== EMBEDDING_MODEL) return invalid(`model must be ${EMBEDDING_MODEL}`);
	if (body.encoding_format !== undefined && body.encoding_format !== "float" && body.encoding_format !== "base64") {
		return invalid('encoding_format must be "float" or "base64"');
	}
	if (body.dimensions !== undefined && body.dimensions !== DIMENSIONS) {
		return invalid(`dimensions must be ${DIMENSIONS}`);
	}
	const input = typeof body.input === "string" ? [body.input] : body.input;
	if (!Array.isArray(input) || input.length === 0 || !input.every(value => typeof value === "string")) {
		return invalid("input must be a string or a non-empty array of strings");
	}
	return Response.json({
		object: "list",
		model: EMBEDDING_MODEL,
		data: input.map((text, index) => {
			const vector = embed(text);
			const embedding =
				body.encoding_format === "base64" ? Buffer.from(vector.buffer).toString("base64") : Array.from(vector);
			return { object: "embedding", index, embedding };
		}),
		usage: { prompt_tokens: 0, total_tokens: 0 },
	});
}

type Document = string | { text: string };

function rerank(body: Record<string, unknown>): Response {
	if (body.model !== RERANK_MODEL) return invalid(`model must be ${RERANK_MODEL}`);
	if (typeof body.query !== "string") return invalid("query must be a string");
	if (
		!Array.isArray(body.documents) ||
		body.documents.length === 0 ||
		!body.documents.every(
			doc => typeof doc === "string" || (doc !== null && typeof doc === "object" && typeof doc.text === "string"),
		)
	) {
		return invalid("documents must be a non-empty array of strings or objects with text");
	}
	if (body.top_n != null && (typeof body.top_n !== "number" || !Number.isInteger(body.top_n) || body.top_n < 1)) {
		return invalid("top_n must be a positive integer");
	}
	if (body.return_documents != null && typeof body.return_documents !== "boolean") {
		return invalid("return_documents must be a boolean");
	}
	const query = embed(body.query);
	const documents = body.documents as Document[];
	const results = documents.map((document, index) => {
		const text = typeof document === "string" ? document : document.text;
		const vector = embed(text);
		let score = 0;
		for (let i = 0; i < DIMENSIONS; i++) score += query[i] * vector[i];
		return {
			index,
			relevance_score: Math.min(1, Math.max(0, score)),
			...(body.return_documents === true && { document: { text } }),
		};
	});
	results.sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
	return Response.json({
		model: RERANK_MODEL,
		results: results.slice(0, typeof body.top_n === "number" ? body.top_n : undefined),
		usage: { total_tokens: 0, cost: 0 },
	});
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	async fetch(request) {
		const pathname = new URL(request.url).pathname;
		if (request.method !== "POST" || (pathname !== "/v1/embeddings" && pathname !== "/v1/rerank")) {
			return invalid("not found", 404);
		}
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return invalid("invalid JSON body");
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("body must be a JSON object");
		return pathname === "/v1/embeddings"
			? embeddings(body as Record<string, unknown>)
			: rerank(body as Record<string, unknown>);
	},
});

console.log(`Mock retrieval server listening at ${server.url}v1`);
console.log(`Embedding: ${EMBEDDING_MODEL} (${DIMENSIONS} dimensions); rerank: ${RERANK_MODEL}`);
console.log("Lexical simulation only; do not mix these vectors with real model data.");
