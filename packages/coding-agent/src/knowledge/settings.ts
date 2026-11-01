import { register } from "../config/registry";

export const cfgKnowledgeRerankerModel = register({
	id: "knowledge.reranker.model",
	type: "string",
	default: undefined,
});
export const cfgKnowledgeRerankerBaseUrl = register({
	id: "knowledge.reranker.baseUrl",
	type: "string",
	default: undefined,
});
export const cfgKnowledgeRerankerApiKey = register({
	id: "knowledge.reranker.apiKey",
	type: "string",
	credential: true,
	default: undefined,
});
