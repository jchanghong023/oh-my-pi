import { type } from "@oh-my-pi/omptype";
import { marked, type Tokens } from "marked";
import type { AgentSession } from "../session/agent-session";

const checksSchema = type({ id: "string > 0", command: "string > 0", "+": "reject" }).array();
export type ApprovedPlanChecks = readonly Readonly<(typeof checksSchema.infer)[number]>[];

export function readApprovedPlanChecks(value: unknown): ApprovedPlanChecks | undefined {
	const checks = checksSchema(value);
	if (checks instanceof type.errors || checks.length === 0) return undefined;
	const ids = new Set<string>();
	for (const { id, command } of checks) {
		if (!id.trim() || !command.trim() || ids.has(id)) return undefined;
		ids.add(id);
	}
	return checks;
}

export function planVerificationChecks(content: string): ApprovedPlanChecks | undefined {
	if (!content.includes("spec-verification")) return undefined;
	try {
		const blocks = marked
			.lexer(content)
			.filter((token): token is Tokens.Code => token.type === "code" && token.lang === "spec-verification");
		if (blocks.length === 1) return readApprovedPlanChecks(JSON.parse(blocks[0].text));
	} catch {
		// A malformed verification block grants no execution capability.
	}
	return undefined;
}

/** Include the complete grant even in a host that shows only a plan preview. */
export function verificationApprovalDetails(checks: ApprovedPlanChecks | undefined): string {
	return checks ? `\n\nExecutable verification checks:\n${JSON.stringify(checks, null, 2)}` : "";
}

/** Keep the exact commands shown to the approver; never derive authority from the mutable plan file. */
export function recordApprovedPlanReference(session: AgentSession, path: string, checks?: ApprovedPlanChecks): void {
	session.setPlanReferencePath(path);
	session.sessionManager.appendModeChange("none", {
		approvedPlanFilePath: path,
		...(checks && { approvedPlanChecks: checks }),
	});
}
