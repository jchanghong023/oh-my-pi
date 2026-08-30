import type { DocumentEntityKind, DocumentPredicate, DocumentSchemaField, DocumentSchemaV1 } from "../types";

const field = (
	name: string,
	type: DocumentSchemaField["type"],
	description: string,
	required = false,
): DocumentSchemaField => ({ name, type, description, ...(required ? { required: true } : {}) });

const kind = (
	name: string,
	description: string,
	identity: DocumentEntityKind["identity"],
	fields: DocumentSchemaField[],
): DocumentEntityKind => ({ name, description, identity, fields });

const named = (name: string, description: string, extra: DocumentSchemaField[] = []): DocumentEntityKind =>
	kind(name, description, { scope: "global", fields: ["name"] }, [
		field("name", "string", "Verbatim canonical name.", true),
		field("summary", "string", "Concise documented purpose or behavior."),
		...extra,
	]);

const predicate = (
	name: string,
	description: string,
	sourceKinds: string[],
	targetKinds: string[],
	cardinality: DocumentPredicate["cardinality"] = "many",
): DocumentPredicate => ({ name, description, sourceKinds, targetKinds, cardinality });

const executableKinds = ["command", "mode", "stage", "flow", "step", "tool"];
const allKinds = [
	"command",
	"option",
	"mode",
	"stage",
	"flow",
	"step",
	"tool",
	"version",
	"test_case",
	"input",
	"output",
	"artifact",
	"example",
	"constraint",
	"error",
	"group",
];

export const DFT_DOCUMENT_SCHEMA: DocumentSchemaV1 = {
	id: "dft",
	version: 1,
	title: "DFT Engineering Documentation",
	description:
		"Commands, configuration, flows, verification, artifacts, constraints, failures, and versioned behavior found in DFT engineering material.",
	instructions: [
		"Extract only claims explicitly supported by a verbatim quote and exact source line range; preserve OCR, transcript, table, option, and command spelling.",
		"Use the nearest fixed entity kind for corpus concepts outside the vocabulary and represent the extra concept as a field assertion rather than inventing a kind.",
		"Do not invent required identity fields. Reject an entity missing its required identity, and reject a parent-scoped entity without a resolvable parent relation.",
		"Treat tables as records: headers define fields, each row supplies values, and merged or blank cells remain unknown unless surrounding text states them.",
		"Treat fenced command examples as examples and link them to the command or tool they demonstrate; do not infer defaults solely from an invocation.",
		"Treat transcript timestamps and speakers as evidence context only when explicit; never attribute an unattributed utterance.",
		"Distinguish requirements, prohibitions, ranges, compatibility conditions, dependencies, uniqueness rules, validity rules, and defaults as constraints.",
		"Use requiredness only as required|optional|conditional|unknown; status only as active|deprecated|unknown; severity only as must|should|informational|unknown.",
		"Use constraint kind only as requirement|prohibition|range|compatibility|dependency|uniqueness|validity|default. Keep defaults and value types as verbatim strings.",
		"Confidence is a number from 0 through 1. Lower confidence for OCR corruption, incomplete tables, slide fragments, and ambiguous transcript speakers.",
		"Preserve contradictory claims as separate assertions or relations with their own evidence; never reconcile them by guessing.",
	],
	entityKinds: [
		kind("command", "A shell, EDA, Tcl, platform, or workflow command.", { scope: "global", fields: ["name"] }, [
			field("name", "string", "Command name exactly as documented.", true),
			field("syntax", "string", "Verbatim invocation syntax."),
			field("summary", "string", "Documented behavior."),
			field("domain", "string", "DFT or tool domain."),
			field("status", "string", "active|deprecated|unknown."),
		]),
		kind(
			"option",
			"An option or argument owned by a command.",
			{ scope: "parent", fields: ["name"], parentKind: "command", parentPredicate: "has_option" },
			[
				field("name", "string", "Option spelling including prefix.", true),
				field("value_type", "string", "Verbatim value type."),
				field("requiredness", "string", "required|optional|conditional|unknown."),
				field("default", "string", "Verbatim default."),
				field("allowed_values", "string[]", "Explicit allowed values."),
				field("repeatable", "boolean", "Whether repeatable."),
				field("summary", "string", "Documented behavior."),
			],
		),
		named("mode", "A named operating, pattern, scan, simulation, or tool mode."),
		named("stage", "A named lifecycle or DFT implementation/verification stage.", [
			field("ordinal", "number", "Documented order when present."),
		]),
		named("flow", "A named ordered engineering or tool flow.", [
			field("ordinal", "number", "Documented order when present."),
		]),
		kind(
			"step",
			"An ordered action inside a flow.",
			{ scope: "parent", fields: ["ordinal"], parentKind: "flow", parentPredicate: "contains_step" },
			[
				field("name", "string", "Step label."),
				field("ordinal", "number", "One-based or documented order.", true),
				field("action", "string", "Verbatim action."),
			],
		),
		named("tool", "A software, platform, script suite, or EDA tool."),
		kind("version", "A named product, document, flow, or tool version.", { scope: "global", fields: ["name"] }, [
			field("name", "string", "Version identifier.", true),
			field("date", "string", "Verbatim date."),
			field("summary", "string", "Release or change summary."),
		]),
		kind("test_case", "A document-scoped verification case or scenario.", { scope: "document", fields: ["id"] }, [
			field("id", "string", "Documented case identifier.", true),
			field("title", "string", "Case title."),
			field("purpose", "string", "Verification purpose."),
			field("control_input", "string", "Control or stimulus input."),
			field("observation_output", "string", "Observed output."),
		]),
		...(["input", "output", "artifact"] as const).map(name =>
			kind(
				name,
				`A document-scoped ${name} used or produced by engineering work.`,
				{ scope: "document", fields: ["name"] },
				[
					field("name", "string", `${name} name.`, true),
					field("format", "string", "Verbatim format."),
					field("path", "string", "Verbatim path."),
					field("summary", "string", "Purpose or content."),
				],
			),
		),
		kind("example", "A section-scoped source-order example.", { scope: "section", fields: ["ordinal"] }, [
			field("title", "string", "Example title."),
			field("ordinal", "number", "Source order within the section.", true),
			field("language", "string", "Fence or code language."),
			field("code", "string", "Verbatim example code."),
			field("expected", "string", "Expected result."),
		]),
		kind(
			"constraint",
			"A section-scoped normative condition or documented default.",
			{ scope: "section", fields: ["statement"] },
			[
				field("title", "string", "Short label."),
				field(
					"kind",
					"string",
					"requirement|prohibition|range|compatibility|dependency|uniqueness|validity|default.",
				),
				field("statement", "string", "Verbatim normative statement.", true),
				field("severity", "string", "must|should|informational|unknown."),
			],
		),
		kind(
			"error",
			"A document-scoped error, diagnostic, mismatch, or failure.",
			{ scope: "document", fields: ["message"] },
			[
				field("code", "string", "Error code."),
				field("message", "string", "Verbatim diagnostic or failure message.", true),
				field("cause", "string", "Documented cause."),
				field("remedy", "string", "Documented remedy."),
			],
		),
		kind(
			"group",
			"A named grouping, category, bus, chain, suite, or collection.",
			{ scope: "global", fields: ["name"] },
			[
				field("name", "string", "Group name.", true),
				field("kind", "string", "Verbatim group category."),
				field("summary", "string", "Purpose or membership rule."),
			],
		),
	],
	predicates: [
		predicate("has_option", "Command owns option.", ["command"], ["option"]),
		predicate("has_mode", "Entity exposes or supports mode.", ["command", "tool", "flow", "stage"], ["mode"]),
		predicate("belongs_to_stage", "Entity belongs to lifecycle stage.", executableKinds, ["stage"], "one"),
		predicate("contains_step", "Flow contains ordered step.", ["flow"], ["step"]),
		predicate("has_member", "Group or aggregate contains member.", ["group", "flow", "stage"], allKinds),
		predicate(
			"uses_command",
			"Entity invokes command.",
			["flow", "step", "example", "test_case", "tool"],
			["command"],
		),
		predicate("uses_tool", "Entity uses software tool.", executableKinds.concat(["test_case", "example"]), ["tool"]),
		predicate("precedes", "Source occurs before target.", ["stage", "step", "flow"], ["stage", "step", "flow"]),
		predicate("requires", "Source depends on target.", allKinds, allKinds),
		predicate("conflicts_with", "Source is incompatible or contradictory with target.", allKinds, allKinds),
		predicate("valid_when", "Source is valid under target condition.", allKinds, ["constraint", "mode", "version"]),
		predicate("consumes", "Source consumes input or artifact.", executableKinds.concat(["test_case"]), [
			"input",
			"artifact",
		]),
		predicate("produces", "Source produces output or artifact.", executableKinds.concat(["test_case"]), [
			"output",
			"artifact",
		]),
		predicate("demonstrates", "Example demonstrates entity.", ["example"], executableKinds.concat(["option"])),
		predicate(
			"tests",
			"Test case verifies entity.",
			["test_case"],
			executableKinds.concat(["constraint", "artifact"]),
		),
		predicate(
			"applies_to",
			"Constraint, error, version, or artifact applies to entity.",
			["constraint", "error", "version", "artifact"],
			allKinds,
		),
		predicate("introduced_in", "Entity was introduced in version.", allKinds, ["version"], "one"),
		predicate("changed_in", "Entity changed in version.", allKinds, ["version"]),
		predicate("deprecated_in", "Entity was deprecated in version.", allKinds, ["version"], "one"),
	],
};
