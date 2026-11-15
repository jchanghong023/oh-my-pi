/**
 * Strings rendered into agent guidance can come from cloned content
 * (spec directory names, Purpose lines, config-declared remotes). One
 * line in, one line out: control characters and newlines must never
 * let hostile content forge instruction lines (slice 6.1 hardening).
 */
export function sanitizeInline(value: string, maxLength = 300): string {
  const flattened = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]+/g, ' ')
    .trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength)}…` : flattened;
}

/**
 * The tags the instruction printer uses to frame its blocks. A block ends at
 * its own closing tag and nowhere else, so this is the entire breakout
 * surface: neutralize these and repo-supplied text cannot escape the element
 * that marks it as data.
 */
const ENVELOPE_TAGS = [
  'artifact',
  'dependencies',
  'dependency',
  'description',
  'instruction',
  'output',
  'path',
  'project_context',
  'rules',
  'success_criteria',
  'task',
  'template',
  'unlocks',
  'warning',
] as const;

// The attribute tail uses `[^<>]` rather than `[^>]` so a run of unterminated
// `<task ...` openers cannot make each start position scan to end of input,
// which is how the first version of this escape became quadratic. The separator
// is `\s`, not a space or tab: XML allows a line break before `>` or an
// attribute, so a multiline repo value could otherwise split a tag past this.
const ENVELOPE_TAG = new RegExp(
  `<(/?)(${ENVELOPE_TAGS.join('|')})(\\s[^<>]*)?>`,
  'gi'
);

/**
 * Neutralize the envelope's own tags - opening and closing - in repo-supplied
 * text, so it cannot close the block that frames it as data nor forge a new
 * block that carries authority.
 *
 * Deliberately narrow: only this fixed vocabulary is touched. Escaping every
 * angle bracket also works, but it mangles ordinary content for everyone.
 * OpenSpec's own spec-driven schema writes `### Requirement: <name>` and
 * `omp openspec show "<spec-id>"`; custom templates carry `<details>`; and
 * `context:` routinely holds `R&D`, `pnpm build && pnpm test` or
 * `Result<T, E>`. All of those would reach the agent entity-encoded - a real
 * cost paid by every user, against a threat only these tags can carry.
 */
export function escapeEnvelopeTags(value: string): string {
  return value.replace(
    ENVELOPE_TAG,
    (_match, slash: string, tag: string, attrs: string | undefined) =>
      `&lt;${slash}${tag}${attrs ?? ''}&gt;`
  );
}

/**
 * Attribute values are ids and directory names, never prose, so escaping every
 * metacharacter here costs nothing and stops a quote from closing the
 * attribute and forging siblings on the tag.
 */
export function escapeEnvelopeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
