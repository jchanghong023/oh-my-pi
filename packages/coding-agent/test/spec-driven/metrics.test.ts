import { expect, test } from "bun:test";
import { specRequestCost } from "../../src/spec-driven/metrics";

test("records positive usage cost and keeps missing or zero cost unknown", () => {
	expect(specRequestCost({ total: 0.25 })).toEqual({ amount: 0.25, currency: "USD" });
	expect(specRequestCost({ total: 0 })).toBeNull();
	expect(specRequestCost({})).toBeNull();
	expect(specRequestCost(undefined)).toBeNull();
	expect(specRequestCost({ total: -1 })).toBeNull();
});
