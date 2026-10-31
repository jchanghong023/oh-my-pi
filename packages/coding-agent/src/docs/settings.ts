import { register } from "../config/registry";

export const cfgWikiRerankerModel = register({ id: "wiki.reranker.model", type: "string", default: undefined });
export const cfgWikiRerankerBaseUrl = register({ id: "wiki.reranker.baseUrl", type: "string", default: undefined });
export const cfgWikiRerankerApiKey = register({
	id: "wiki.reranker.apiKey",
	type: "string",
	credential: true,
	default: undefined,
});
