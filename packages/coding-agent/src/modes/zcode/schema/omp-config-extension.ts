// Optional OMP configuration extension, developed with the Host adapter; not part of the pinned upstream baseline.
import { z } from "zod";
// Optional OMP configuration extension. Session identity is explicit; profile is
// derived by the server from the trusted connection, never supplied by the UI.
export const ompModelRefSchema = z
	.object({
		provider: z.string().min(1),
		modelId: z.string().min(1),
		thinkingLevel: z.string().optional(),
	})
	.strict();
const ompTeamModelRefSchema = ompModelRefSchema.omit({ thinkingLevel: true });
export const ompRoleSelectionSchema = z.union([
	z.object({ kind: z.literal("model"), model: ompModelRefSchema }).strict(),
	z.object({ kind: z.literal("auto") }).strict(),
	z.null(),
]);
const ompConfigSourceSchema = z.enum(["default", "global", "project", "overlay", "runtime"]);
export const ompRoleDescriptorSchema = z
	.object({
		roleId: z.string(),
		name: z.string(),
		description: z.string().optional(),
		configurable: z.boolean(),
		nonConfigurableReason: z.string().optional(),
		explicitValue: z.string().optional(),
		userValue: z.string().nullable(),
		projectValue: z.string().nullable(),
		candidateModels: z.array(ompModelRefSchema),
		effectiveModel: ompModelRefSchema.optional(),
		unresolvedReason: z.string().optional(),
		source: ompConfigSourceSchema,
		writableScopes: z.array(z.enum(["user", "project"])),
		hidden: z.boolean(),
		section: z.enum(["chat", "kind"]),
		revision: z.string().min(1),
	})
	.strict();
export const ompTeamMemberSlotSchema = z
	.object({
		index: z.number().int().nonnegative(),
		rawSelector: z.string(),
		model: ompTeamModelRefSchema.nullable(),
		name: z.string().optional(),
		status: z.enum(["available", "unavailable", "unresolved"]),
		reasonCode: z.string().optional(),
		reason: z.string().optional(),
	})
	.strict();
const ompTeamIssueSchema = z
	.object({
		code: z.string(),
		message: z.string(),
		target: z.enum(["member", "session_model", "config", "storage"]),
		list: z
			.enum([
				"userMembers",
				"persistentMembers",
				"effectiveMembers",
				"preview.userMembers",
				"preview.effectiveMembers",
			])
			.optional(),
		source: z.string().optional(),
		index: z.number().int().optional(),
		selector: z.string().optional(),
		side: z.enum(["active", "persistent"]).optional(),
	})
	.strict();
const ompParticipantsSchema = z.array(
	z
		.object({
			index: z.number().int(),
			label: z.string(),
			model: ompTeamModelRefSchema,
		})
		.strict(),
);
const ompTeamPreviewSchema = z
	.object({
		clientRevision: z.string().min(1),
		userMembers: z.array(ompTeamMemberSlotSchema).nullable(),
		effectiveMembers: z.array(ompTeamMemberSlotSchema).nullable(),
		source: ompConfigSourceSchema.nullable(),
		participants: ompParticipantsSchema,
		issues: z.array(ompTeamIssueSchema),
	})
	.strict();
const ompReadStateSchema = z.enum(["present", "missing", "invalid", "unreadable", "not_applicable"]);
export const ompTeamConfigSchema = z
	.object({
		profile: z.string().nullable(),
		revision: z.string().nullable(),
		userMembers: z.array(ompTeamMemberSlotSchema).nullable().optional(),
		persistentMembers: z.array(ompTeamMemberSlotSchema).nullable().optional(),
		effectiveMembers: z.array(ompTeamMemberSlotSchema).nullable(),
		source: ompConfigSourceSchema.nullable(),
		sessionModel: z
			.object({ model: ompTeamModelRefSchema, name: z.string(), available: z.boolean() })
			.strict()
			.nullable(),
		participants: ompParticipantsSchema,
		issues: z.array(ompTeamIssueSchema),
		writableScopes: z.array(z.literal("user")),
		storage: z
			.object({
				mode: z.enum(["single", "offline_shm"]),
				syncState: z.enum(["in_sync", "different", "unknown", "not_applicable"]),
				active: z.object({ readState: ompReadStateSchema }).strict(),
				persistent: z.object({ readState: ompReadStateSchema }).strict(),
			})
			.strict(),
		preview: ompTeamPreviewSchema.optional(),
	})
	.strict();
export const ompTeamModelsSchema = z
	.object({
		models: z.array(
			z
				.object({
					model: ompTeamModelRefSchema,
					name: z.string(),
					selectable: z.boolean(),
					reasonCode: z.string().optional(),
					reason: z.string().optional(),
				})
				.strict(),
		),
	})
	.strict();
const ompWriteReceiptSchema = z
	.object({
		status: z.enum(["saved", "unchanged", "failed", "not_attempted", "unknown", "not_applicable"]),
		message: z.string().optional(),
	})
	.strict();
export const ompSaveReceiptSchema = z
	.object({
		saveState: z.enum(["complete", "partial", "failed", "unknown"]),
		writes: z.object({ active: ompWriteReceiptSchema, persistent: ompWriteReceiptSchema }).strict(),
		config: ompTeamConfigSchema.optional(),
		issues: z.array(ompTeamIssueSchema).optional(),
		effectiveMatchesRequested: z.boolean().optional(),
		effectiveNote: z.string().optional(),
	})
	.strict();
const ompPreviewInputSchema = z
	.object({
		clientRevision: z.string().min(1),
		members: z.array(z.union([ompTeamModelRefSchema, z.object({ rawSelector: z.string() }).strict()])).nullable(),
	})
	.strict();
export const zcodeSessionConfigureParamsSchema = z.discriminatedUnion("operation", [
	z
		.object({
			sessionId: z.string().min(1),
			operation: z.literal("get_model_roles"),
			roleId: z.string().min(1).optional(),
		})
		.strict(),
	z
		.object({
			sessionId: z.string().min(1),
			operation: z.literal("set_model_role"),
			roleId: z.string().min(1),
			scope: z.literal("user"),
			expectedRevision: z.string().min(1),
			selection: ompRoleSelectionSchema,
		})
		.strict(),
	z
		.object({
			sessionId: z.string().min(1),
			operation: z.literal("get_team_config"),
			preview: ompPreviewInputSchema.optional(),
		})
		.strict(),
	z
		.object({ sessionId: z.string().min(1), operation: z.literal("get_team_models"), query: z.string().optional() })
		.strict(),
	z
		.object({
			sessionId: z.string().min(1),
			operation: z.literal("set_team_config"),
			scope: z.literal("user"),
			expectedRevision: z.string().min(1),
			members: z.array(ompTeamModelRefSchema).nullable(),
		})
		.strict(),
]);
export const zcodeSessionConfigureResultSchema = z.discriminatedUnion("operation", [
	z
		.object({
			operation: z.literal("get_model_roles"),
			data: z
				.object({
					roles: z.array(ompRoleDescriptorSchema),
					sessionModel: z.object({ model: ompModelRefSchema.optional() }).strict().optional(),
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			operation: z.literal("set_model_role"),
			data: z
				.object({
					role: ompRoleDescriptorSchema,
					persisted: z.literal(true),
					effectiveNote: z.string().optional(),
				})
				.strict(),
		})
		.strict(),
	z.object({ operation: z.literal("get_team_config"), data: ompTeamConfigSchema }).strict(),
	z.object({ operation: z.literal("get_team_models"), data: ompTeamModelsSchema }).strict(),
	z
		.object({
			operation: z.literal("set_team_config"),
			data: ompSaveReceiptSchema.extend({
				config: ompTeamConfigSchema,
				effectiveMatchesRequested: z.boolean(),
			}),
		})
		.strict(),
]);
export type OmpModelRef = z.infer<typeof ompModelRefSchema>;
export type OmpRoleSelection = z.infer<typeof ompRoleSelectionSchema>;
export type OmpRoleDescriptor = z.infer<typeof ompRoleDescriptorSchema>;
export type OmpTeamConfig = z.infer<typeof ompTeamConfigSchema>;
export type OmpTeamMemberSlot = z.infer<typeof ompTeamMemberSlotSchema>;
export type OmpTeamModels = z.infer<typeof ompTeamModelsSchema>;
export type OmpSaveReceipt = z.infer<typeof ompSaveReceiptSchema>;
export type ZCodeSessionConfigureParams = z.infer<typeof zcodeSessionConfigureParamsSchema>;
export type ZCodeSessionConfigureResult = z.infer<typeof zcodeSessionConfigureResultSchema>;
