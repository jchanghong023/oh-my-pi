/**
 * Built-in runtime provider "zcode-api": the local ZCode Proxy relaying the
 * domestic Zhipu coding-plan GLM models over its native Anthropic Messages
 * route.
 *
 * Rows are built here instead of shipping in `models.json`: the bundled
 * catalog must never carry loopback endpoints
 * (packages/ai/test/models-json-no-local-endpoints.test.ts), and this provider
 * has no discovery endpoint to materialize rows from. Wire policy (thinking
 * modes, tool-result ids) lives in `rules/providers/zcode-api.kdl` and is
 * applied by the compat engine inside `buildModel`.
 *
 * Roster and parameters mirror the `zhipu-coding-plan` lane.
 * `glm-5.2-highspeed[1m]` is intentionally absent: it is a collapsed alias of
 * `glm-5.2-highspeed` in that lane's provider-scoped variant table, which
 * this provider does not have.
 */
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";

export const ZCODE_API_PROVIDER_ID = "zcode-api";

/** Default endpoint of the local ZCode Proxy (its `server.port` default). */
export const ZCODE_API_DEFAULT_BASE_URL = "http://127.0.0.1:8080";

/** Resolves the proxy endpoint; `ZCODE_API_BASE_URL` overrides the loopback default. */
export function resolveZcodeApiBaseUrl(): string {
	// A value that reduces to nothing (`/`, `///`) would leave the rows with an
	// empty base URL, which the Anthropic transport treats as unset and reroutes
	// to the public API; keep the loopback default instead.
	const override = Bun.env.ZCODE_API_BASE_URL?.trim().replace(/\/+$/, "");
	if (!override) return ZCODE_API_DEFAULT_BASE_URL;
	// No `/v1` handling here: `normalizeAnthropicBaseUrl` (packages/ai/src/providers/
	// anthropic.ts) already trims, drops trailing slashes and strips a trailing `/v1`
	// for every anthropic-messages row before the route is appended.
	return override;
}

let cachedBaseUrl: string | undefined;
let cachedModels: Model<"anthropic-messages">[] | undefined;

/** Runtime rows, memoized per resolved endpoint. */
export function getZcodeApiModels(): Model<"anthropic-messages">[] {
	const baseUrl = resolveZcodeApiBaseUrl();
	if (cachedModels && cachedBaseUrl === baseUrl) return cachedModels;
	cachedBaseUrl = baseUrl;
	cachedModels = seedModels<"anthropic-messages">(ZCODE_API_PROVIDER_ID).map(spec =>
		buildModel({
			...spec,
			baseUrl,
		}),
	);
	return cachedModels;
}
