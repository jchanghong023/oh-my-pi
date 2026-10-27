import { buildCodeFenceMask, SCENARIO_HEADER } from './requirement-text.js';
export function normalizeRequirementName(name) {
    // An ATX heading may end in a closing run of `#`s: `### Requirement: Foo ###`
    // renders as `Foo`, so the run is not part of the name. As for scenario names,
    // only a run preceded by a space or tab closes the heading, so `C#` keeps its
    // `#`, and `[ \t]` rather than `\s` keeps an NBSP-separated run in the name.
    return name.replace(/[ \t]+#+[ \t]*$/, '').trim();
}
/**
 * Case- and whitespace-insensitive fold of a requirement name. Requirement
 * matching itself is case-sensitive (normalizeRequirementName); this fold
 * exists only for typo detection - near-miss REMOVED, ADDED and RENAMED
 * headers and the RENAMED+REMOVED cross-section conflict - where two spellings
 * that differ only in case or interior whitespace mean a mistake, never two
 * requirements.
 */
export function foldRequirementName(name) {
    return normalizeRequirementName(name).toLowerCase().replace(/\s+/g, ' ');
}
/** The canonical requirement header the delta reader recognizes. */
const REQUIREMENT_HEADER_REGEX = /^###\s*Requirement:\s*(.+)\s*$/i;
/**
 * Extracts the Requirements section from a spec file and parses requirement blocks.
 */
export function extractRequirementsSection(content) {
    const normalized = normalizeLineEndings(content);
    const lines = normalized.split('\n');
    const fenceMask = buildCodeFenceMask(lines);
    const reqHeaderIndex = lines.findIndex((l, i) => !fenceMask[i] && /^##\s+Requirements\s*$/i.test(l));
    if (reqHeaderIndex === -1) {
        // No requirements section; create an empty one at the end
        const before = content.trimEnd();
        const headerLine = '## Requirements';
        return {
            before: before ? before + '\n\n' : '',
            headerLine,
            preamble: '',
            bodyBlocks: [],
            after: '\n',
        };
    }
    // Find end of this section: next line that starts with '## ' at same or higher level
    let endIndex = lines.length;
    for (let i = reqHeaderIndex + 1; i < lines.length; i++) {
        if (!fenceMask[i] && /^##\s+/.test(lines[i])) {
            endIndex = i;
            break;
        }
    }
    const before = lines.slice(0, reqHeaderIndex).join('\n');
    const headerLine = lines[reqHeaderIndex];
    const sectionBodyLines = lines.slice(reqHeaderIndex + 1, endIndex);
    const sectionBodyMask = fenceMask.slice(reqHeaderIndex + 1, endIndex);
    const isRequirementHeader = (cursor) => !sectionBodyMask[cursor] && REQUIREMENT_HEADER_REGEX.test(sectionBodyLines[cursor]);
    const isTopLevelHeader = (cursor) => !sectionBodyMask[cursor] && /^##\s+/.test(sectionBodyLines[cursor]);
    // Parse requirement blocks within section body
    const blocks = [];
    let cursor = 0;
    let preambleLines = [];
    // Collect preamble lines until first requirement header
    while (cursor < sectionBodyLines.length && !isRequirementHeader(cursor)) {
        preambleLines.push(sectionBodyLines[cursor]);
        cursor++;
    }
    while (cursor < sectionBodyLines.length) {
        const headerLineCandidate = sectionBodyLines[cursor];
        if (!isRequirementHeader(cursor)) {
            // Not a requirement header; skip line defensively
            cursor++;
            continue;
        }
        const headerMatch = headerLineCandidate.match(REQUIREMENT_HEADER_REGEX);
        const name = normalizeRequirementName(headerMatch[1]);
        cursor++;
        // Gather lines until next requirement header or end of section
        const bodyLines = [headerLineCandidate];
        while (cursor < sectionBodyLines.length && !isRequirementHeader(cursor) && !isTopLevelHeader(cursor)) {
            bodyLines.push(sectionBodyLines[cursor]);
            cursor++;
        }
        const raw = bodyLines.join('\n').trimEnd();
        blocks.push({ headerLine: headerLineCandidate, name, raw });
    }
    const after = lines.slice(endIndex).join('\n');
    const preamble = preambleLines.join('\n').trimEnd();
    return {
        before: before.trimEnd() ? before + '\n' : before,
        headerLine,
        preamble,
        bodyBlocks: blocks,
        after: after.startsWith('\n') ? after : '\n' + after,
    };
}
function normalizeLineEndings(content) {
    // Strip a UTF-8 BOM: Windows editors and PowerShell redirects prepend one,
    // and it would keep the first line's `## ADDED Requirements` from matching.
    return content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}
/**
 * Parse a delta-formatted spec change file content into a DeltaPlan with raw blocks.
 */
export function parseDeltaSpec(content) {
    const normalized = normalizeLineEndings(content);
    const lines = normalized.split('\n');
    const fenceMask = buildCodeFenceMask(lines);
    const sections = splitTopLevelSections(lines, fenceMask);
    const addedLookup = getSectionsCaseInsensitive(sections, 'ADDED Requirements');
    const modifiedLookup = getSectionsCaseInsensitive(sections, 'MODIFIED Requirements');
    const removedLookup = getSectionsCaseInsensitive(sections, 'REMOVED Requirements');
    const renamedLookup = getSectionsCaseInsensitive(sections, 'RENAMED Requirements');
    const skippedHeaders = [];
    const added = addedLookup.bodies.flatMap((body) => parseRequirementBlocksFromSection(body, {
        section: addedLookup.title,
        bodyStartLine: body.bodyStartLine,
        sink: skippedHeaders,
    }));
    const modified = modifiedLookup.bodies.flatMap((body) => parseRequirementBlocksFromSection(body, {
        section: modifiedLookup.title,
        bodyStartLine: body.bodyStartLine,
        sink: skippedHeaders,
    }));
    const removedNames = removedLookup.bodies.flatMap((body) => parseRemovedNames(body));
    const removedBlocks = removedLookup.bodies.flatMap((body) => parseRequirementBlocksFromSection(body));
    // Pairs are read per section, so a FROM in one copy of the header can never
    // pair with a TO in another: a FROM left pending at the end of one copy is
    // reported as unpaired rather than carried into the next.
    const unpairedRenames = [];
    const renamedPairs = renamedLookup.bodies.flatMap((body) => parseRenamedPairs(body, unpairedRenames));
    unpairedRenames.sort((a, b) => a.line - b.line);
    skippedHeaders.sort((a, b) => a.line - b.line);
    return {
        added,
        modified,
        removed: removedNames,
        removedBlocks,
        renamed: renamedPairs,
        unpairedRenames,
        orphanedRequirements: findOrphanedRequirements(lines, fenceMask),
        unappliedContent: findUnappliedContent(lines, fenceMask),
        skippedHeaders,
        sectionPresence: {
            added: addedLookup.found,
            modified: modifiedLookup.found,
            removed: removedLookup.found,
            renamed: renamedLookup.found,
        },
    };
}
/**
 * The four section titles the delta reader acts on, folded the way
 * `getSectionsCaseInsensitive` folds them. Matching the reader exactly matters:
 * a looser test (say, any run of whitespace) would treat `## ADDED  Requirements`
 * as a delta section here while the reader ignores it, and the requirements
 * under it would be dropped without this warning.
 */
const DELTA_SECTION_TITLES = new Set(['ADDED Requirements', 'MODIFIED Requirements', 'REMOVED Requirements', 'RENAMED Requirements'].map((title) => title.toLowerCase()));
/**
 * Every canonical `### Requirement:` header that is not inside a delta section,
 * in document order.
 *
 * Walks the whole file rather than the parsed sections so a requirement written
 * ABOVE the first `## ` header is reported too - it is dropped just as silently
 * as one under `## Notes`. Fenced lines are skipped, so a requirement shown
 * inside a markdown example is not mistaken for an authored one.
 */
function findOrphanedRequirements(lines, fenceMask) {
    const orphans = [];
    let section = null;
    for (let i = 0; i < lines.length; i++) {
        if (fenceMask[i])
            continue;
        // The same `## ` test splitTopLevelSections uses, so both agree on sections.
        const sectionMatch = lines[i].match(/^(##)\s+(.+)$/);
        if (sectionMatch) {
            section = sectionMatch[2].trim();
            continue;
        }
        if (section !== null && DELTA_SECTION_TITLES.has(section.toLowerCase()))
            continue;
        const header = lines[i].match(REQUIREMENT_HEADER_REGEX);
        if (header) {
            orphans.push({
                name: normalizeRequirementName(header[1]),
                section,
                line: i + 1,
            });
        }
    }
    return orphans;
}
export function describeUnappliedContent(content, sentenceStart = false) {
    const text = content.section === null
        ? 'text above the first "## " section'
        : DELTA_SECTION_TITLES.has(content.section.toLowerCase())
            ? `text before the first requirement in "## ${content.section}"`
            : `section "## ${content.section}"`;
    return sentenceStart ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
/**
 * Where text the merge never reads begins. HTML comments, `# ` titles, Purpose
 * (warned about separately), REMOVED/RENAMED bodies, and stray `###` headers
 * before the first requirement (INFO since #498) are not reported.
 */
function findUnappliedContent(lines, fenceMask) {
    // Blank out comments outside fences, keeping line count; an unterminated one
    // runs to EOF. Comments only decide whether a line holds text: sections come
    // from the same split the merge reads, where a `## ` line inside a comment is
    // still a boundary. Fenced lines keep their text, so a `<!--` in a code sample
    // never hides what follows the fence.
    const comments = lines
        .map((line, i) => (fenceMask[i] ? '' : line))
        .join('\n')
        .replace(/<!--[\s\S]*?(?:--!?>|$)/g, (m) => m.replace(/[^\n]/g, ' '))
        .split('\n');
    const masked = lines.map((line, i) => (fenceMask[i] ? line : comments[i]));
    const sections = splitTopLevelSections(lines, fenceMask);
    const firstText = (from, to, skip) => {
        for (let i = from; i < to; i++)
            if (masked[i].trim() && !skip?.test(masked[i]))
                return i;
        return -1;
    };
    const found = [];
    const preamble = firstText(0, sections.length ? sections[0].body.bodyStartLine - 2 : lines.length, /^#\s/);
    if (preamble !== -1)
        found.push({ section: null, line: preamble + 1 });
    for (const { title, body } of sections) {
        const folded = title.toLowerCase();
        const start = body.bodyStartLine - 1;
        if (folded === 'added requirements' || folded === 'modified requirements') {
            const block = body.lines.findIndex((l, i) => !body.fenceMask[i] && REQUIREMENT_HEADER_REGEX.test(l));
            const first = firstText(start, start + (block === -1 ? body.lines.length : block), /^###\s/);
            if (first !== -1)
                found.push({ section: title, line: first + 1 });
        }
        else if (!DELTA_SECTION_TITLES.has(folded)) {
            // The Purpose carry-over reads past commented-out headers, so only a
            // `## Purpose` outside a comment is the one archive handles.
            if (folded === 'purpose' && masked[start - 1].trim())
                continue;
            if (firstText(start, start + body.lines.length) !== -1)
                found.push({ section: title, line: start });
        }
    }
    return found;
}
/**
 * Every `## ` section, as a LIST rather than a title-keyed record.
 *
 * Keying by title silently dropped a repeated header: a delta that wrote
 * `## ADDED Requirements` twice kept only the last body, so every requirement
 * under the first copy was discarded before any validation or merge rule could
 * see it. A list keeps each occurrence, and the lookup below merges them.
 */
function splitTopLevelSections(lines, fenceMask) {
    const sections = [];
    const indices = [];
    for (let i = 0; i < lines.length; i++) {
        if (fenceMask[i])
            continue;
        const m = lines[i].match(/^(##)\s+(.+)$/);
        if (m) {
            indices.push({ title: m[2].trim(), index: i });
        }
    }
    for (let i = 0; i < indices.length; i++) {
        const current = indices[i];
        const next = indices[i + 1];
        const end = next ? next.index : lines.length;
        sections.push({
            title: current.title,
            body: {
                lines: lines.slice(current.index + 1, end),
                fenceMask: fenceMask.slice(current.index + 1, end),
                bodyStartLine: current.index + 2,
            },
        });
    }
    return sections;
}
/**
 * Every section body whose title folds to `desired`, in document order.
 *
 * Returning all of them - rather than the first match - is what makes a
 * repeated header (`## ADDED Requirements` twice) and a case variant
 * (`## ADDED Requirements` + `## Added Requirements`) both apply in full. Each
 * body keeps its own `bodyStartLine`, so reported line numbers stay correct for
 * the copy the header actually came from.
 *
 * `title` is the first spelling the author used, which is what diagnostics quote.
 */
function getSectionsCaseInsensitive(sections, desired) {
    const target = desired.toLowerCase();
    const matches = sections.filter((section) => section.title.toLowerCase() === target);
    if (matches.length === 0) {
        return { title: desired, bodies: [], found: false };
    }
    return {
        title: matches[0].title,
        bodies: matches.map((section) => section.body),
        found: true,
    };
}
function parseRequirementBlocksFromSection(sectionBody, skipped) {
    const { lines, fenceMask } = sectionBody;
    if (lines.length === 0)
        return [];
    const isRequirementHeader = (i) => !fenceMask[i] && REQUIREMENT_HEADER_REGEX.test(lines[i]);
    const isTopLevelHeader = (i) => !fenceMask[i] && /^##\s+/.test(lines[i]);
    const recordIfSkippedHeader = (index) => {
        if (!skipped || fenceMask[index])
            return;
        const h3 = lines[index].match(/^###\s+(.+?)\s*$/);
        if (h3 && !REQUIREMENT_HEADER_REGEX.test(lines[index])) {
            skipped.sink.push({
                header: h3[1].trim(),
                section: skipped.section,
                line: skipped.bodyStartLine + index,
            });
        }
    };
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        // Seek next requirement header
        while (i < lines.length && !isRequirementHeader(i)) {
            recordIfSkippedHeader(i);
            i++;
        }
        if (i >= lines.length)
            break;
        const headerLine = lines[i];
        const m = headerLine.match(REQUIREMENT_HEADER_REGEX);
        if (!m) {
            i++;
            continue;
        }
        const name = normalizeRequirementName(m[1]);
        const buf = [headerLine];
        i++;
        while (i < lines.length && !isRequirementHeader(i) && !isTopLevelHeader(i)) {
            recordIfSkippedHeader(i);
            buf.push(lines[i]);
            i++;
        }
        blocks.push({ headerLine, name, raw: buf.join('\n').trimEnd() });
    }
    return blocks;
}
/**
 * Requirement names listed in `## REMOVED Requirements`, in document order.
 *
 * Two spellings are accepted: a plain `### Requirement:` header, and a bullet
 * carrying one. Every CommonMark bullet marker counts for the second form -
 * see the pattern below for why that matters.
 */
function parseRemovedNames(sectionBody) {
    const { lines, fenceMask } = sectionBody;
    if (lines.length === 0)
        return [];
    const names = [];
    for (let i = 0; i < lines.length; i++) {
        if (fenceMask[i])
            continue;
        const line = lines[i];
        const m = line.match(REQUIREMENT_HEADER_REGEX);
        if (m) {
            names.push(normalizeRequirementName(m[1]));
            continue;
        }
        // Also support bullet list of headers. Every CommonMark bullet marker
        // counts: `*` and `+` open a list exactly as `-` does, so accepting only
        // `-` turned a removal written with either of them into a silent no-op -
        // archive reported success while the requirement stayed in the spec.
        const bullet = line.match(/^\s*[-*+]\s*`?###\s*Requirement:\s*(.+?)`?\s*$/);
        if (bullet) {
            names.push(normalizeRequirementName(bullet[1]));
        }
    }
    return names;
}
/**
 * Read `FROM:`/`TO:` entries into rename pairs, recording every line that never
 * formed one.
 *
 * A pair is a `FROM:` followed by a `TO:` with no second `FROM:` in between -
 * the shape the documented format uses. Anything else is reported through
 * `unpaired` rather than absorbed:
 *
 *   - a `FROM:` displaced by another `FROM:` before its `TO:` arrived
 *   - a `TO:` with no pending `FROM:`
 *   - a `FROM:` still pending when the section ends
 *
 * Silently dropping these is what let a requested rename not happen, and what
 * let interleaved lines (`FROM a`, `FROM b`, `TO x`, `TO y`) pair b with x -
 * renaming a requirement the author never named, under a name meant for a
 * different one. Callers refuse the delta instead of guessing.
 *
 * The bullet is optional, and every CommonMark bullet marker is accepted: a
 * rename written with `*` or `+` used to match nothing at all, so the rename
 * silently never happened while archive still reported success.
 */
function parseRenamedPairs(sectionBody, unpaired) {
    const { lines, fenceMask, bodyStartLine } = sectionBody;
    if (lines.length === 0)
        return [];
    const pairs = [];
    let pending;
    const drop = (side, name, line) => {
        unpaired?.push({ side, name, line });
    };
    for (let i = 0; i < lines.length; i++) {
        if (fenceMask[i])
            continue;
        const line = lines[i];
        // The bullet stays optional, and any CommonMark marker is accepted: a rename
        // written with `*` or `+` used to match nothing at all, so the rename never
        // happened while archive still reported success.
        const fromMatch = line.match(/^\s*[-*+]?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/);
        const toMatch = line.match(/^\s*[-*+]?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/);
        if (fromMatch) {
            if (pending)
                drop('FROM', pending.name, pending.line);
            pending = { name: normalizeRequirementName(fromMatch[1]), line: bodyStartLine + i };
        }
        else if (toMatch) {
            const to = normalizeRequirementName(toMatch[1]);
            if (!pending) {
                drop('TO', to, bodyStartLine + i);
                continue;
            }
            pairs.push({ from: pending.name, to });
            pending = undefined;
        }
    }
    if (pending)
        drop('FROM', pending.name, pending.line);
    return pairs;
}
/**
 * Compare the scenario names of a current requirement block and an incoming
 * (MODIFIED) one, in both directions.
 *
 * `missing` is the loss the guard exists to catch: a MODIFIED requirement
 * replaces the whole block, so every name there would be dropped from the main
 * spec. `added` and the two counts are reported alongside it, because they are
 * the first thing a reader checks once it fires (#1697) - a block that omits
 * two names and introduces two is shaped like a rename, one that omits two and
 * introduces none is shaped like a truncation. Neither is proof, and intent is
 * not recoverable from structure, so this decides nothing and only says what
 * the two blocks contain.
 */
export function diffScenarioNames(current, incoming) {
    const currentNames = parseScenarioBlocks(current.raw).map((scenario) => scenario.name);
    const incomingNames = parseScenarioBlocks(incoming.raw).map((scenario) => scenario.name);
    // Multiplicity-aware: a name present N times on one side and M times on the
    // other leaves max(0, N - M) instances unmatched. Set membership would treat
    // N>M as fully covered and let archive silently drop duplicates (residual
    // #1246 / duplicate-scenario-name blind spot).
    const unmatched = (names, against) => {
        const remaining = new Map();
        for (const name of against)
            remaining.set(name, (remaining.get(name) ?? 0) + 1);
        const out = [];
        for (const name of names) {
            const left = remaining.get(name) ?? 0;
            if (left > 0)
                remaining.set(name, left - 1);
            else
                out.push(name);
        }
        return out;
    };
    return {
        missing: unmatched(currentNames, incomingNames),
        added: unmatched(incomingNames, currentNames),
        currentCount: currentNames.length,
        incomingCount: incomingNames.length,
    };
}
/**
 * Scenario names the current requirement block has and the incoming
 * (MODIFIED) block does not. A MODIFIED requirement replaces the whole block,
 * so every name reported here would be dropped from the main spec.
 *
 * The `missing` half of diffScenarioNames, which archive (refusing to apply
 * the block) and validate (reporting the same loss at authoring time, #1477)
 * both go through, so the two cannot disagree about what counts as a dropped
 * scenario.
 */
export function findMissingCurrentScenarios(current, incoming) {
    return diffScenarioNames(current, incoming).missing;
}
/** At most this many added names are listed before the rest are counted. */
const MAX_LISTED_ADDED_SCENARIOS = 3;
/**
 * The one sentence archive and validate both append when the guard fires, so
 * the counts a reader sees cannot differ between the two commands.
 */
export function describeScenarioBalance(diff) {
    const count = (value) => `${value} ${value === 1 ? 'scenario' : 'scenarios'}`;
    const scale = `The modified block has ${count(diff.incomingCount)}; the current spec has ${count(diff.currentCount)}.`;
    if (diff.added.length === 0) {
        return `${scale} It adds none.`;
    }
    const listed = diff.added
        .slice(0, MAX_LISTED_ADDED_SCENARIOS)
        .map((name) => `"${name}"`)
        .join(', ');
    const rest = diff.added.length - MAX_LISTED_ADDED_SCENARIOS;
    const names = rest > 0 ? `${listed} and ${rest} more` : listed;
    return `${scale} It adds ${count(diff.added.length)} not in the current spec: ${names}.`;
}
/**
 * Any non-fenced level-4 header on the given (masked) line. Reuses the spec
 * path's SCENARIO_HEADER so the two counters cannot drift apart.
 */
function scenarioHeaderAt(lines, mask, index) {
    return !mask[index] && SCENARIO_HEADER.test(lines[index]);
}
/**
 * The scenario name for a `#### ` header, matching the label the author reads:
 * the header text with the leading `####`, an optional CommonMark closing `#`
 * run (`#### Foo ####` renders as `Foo`), and an optional `Scenario:` prefix
 * stripped. Both the current and incoming blocks run through here, so the
 * comparison in findMissingCurrentScenarios stays internally consistent
 * regardless of label — and two headers that render to the same title (one
 * ATX-closed, one not) are not mistaken for a dropped scenario.
 */
function scenarioNameAt(line) {
    return scenarioNameFromHeaderText(line.replace(SCENARIO_HEADER, ''));
}
/**
 * scenarioNameAt for header text whose leading `####` is already gone, as the
 * section parser (MarkdownParser) holds it, so `show --json` names a scenario
 * exactly as the MODIFIED loss check does.
 */
export function scenarioNameFromHeaderText(headerText) {
    return headerText
        // Optional ATX closing sequence. CommonMark only treats a trailing `#` run
        // as a close when it is preceded by a space or tab — not any Unicode space —
        // so this uses `[ \t]`, not `\s`. A looser `\s` could strip a `#` run after
        // an exotic space (e.g. NBSP) that CommonMark keeps, folding two distinct
        // scenario names into one and masking a real loss. `[ \t]` keeps the fold
        // faithful to how the header actually renders.
        .replace(/[ \t]+#+[ \t]*$/, '')
        .replace(/^Scenario:\s*/i, '')
        .trim();
}
function parseScenarioBlocks(requirementRaw) {
    const lines = requirementRaw.replace(/\r\n?/g, '\n').split('\n');
    // A scenario is ANY non-fenced `#### ` header, matching the spec path's
    // SCENARIO_HEADER / countScenarios (requirement-text.ts) exactly — not only
    // `#### Scenario:`. The two MUST agree: a level-4 child whose header is not
    // literally `Scenario:` (e.g. `#### Edge case`) is still a scenario the spec
    // path counts, so a MODIFIED block that drops it would otherwise slip past
    // this loss check and be deleted by archive with no error (the parity the
    // SCENARIO_HEADER comment warns not to break). A `####` inside a fenced
    // example is masked out, matching countScenarios.
    const mask = buildCodeFenceMask(lines);
    const scenarios = [];
    let index = 0;
    while (index < lines.length) {
        if (!scenarioHeaderAt(lines, mask, index)) {
            index++;
            continue;
        }
        const start = index;
        const name = scenarioNameAt(lines[index]);
        index++;
        while (index < lines.length && !scenarioHeaderAt(lines, mask, index)) {
            index++;
        }
        scenarios.push({
            name,
            raw: lines.slice(start, index).join('\n').trimEnd(),
        });
    }
    return scenarios;
}
//# sourceMappingURL=requirement-blocks.js.map