# Conditional Pattern Index

Detailed guidance for conditional test-planning patterns. Consult only when the target function exhibits the corresponding pattern (detected during Step 2 quick-scan).

## State Mutations

- **State mutations** (`del dict[key]`, `dict.pop(key)`, `self.attr = value`): verify the state change explicitly within the branch test that triggers it. Only create a dedicated test if the mutation is in a separate code path. (See `branch-coverage-matrix.md`)
- **`del` statement verification**: For `del` statements (especially `del exc_info`), use a `side_effect` callback on the call preceding the `del` to capture the state before deletion, then verify the attribute/key no longer exists after the function returns
- **Multi-step mutations to the same data structure** (e.g., 3 sequential `dict.update()` calls to the same dict): plan a dedicated test for each mutation step that verifies its effect on the final state, including override precedence. Independent assignments to different attributes are NOT multi-step mutations
- **Collection mutations** (`.update()`, `.extend()`, `.add()`): plan tests verifying the method was called with correct arguments AND the collection contains expected items. **For set-based deduplication** (e.g., `setdefault + add` pattern): plan a test that adds the same element twice and verifies no duplication occurs. **Never use only isinstance checks for collection content** — mock the source function with known return values and verify those values appear in the target collection

## Sequential and Guard Patterns

- **Sequential guard clauses** (2+ short-circuit checks): plan a test verifying the priority order (see `sequential-workflow-testing.md` Section 6)
- **3+ sequential method calls with ordering dependencies**: consult `sequential-workflow-testing.md` Section 1
- **State flags gating downstream operations**: consult Section 2
- **Multiple exception types with different handling**: consult Section 3
- **Recursive data traversal or self-calls**: consult Section 4
- **Deeply nested conditional logic (3+ levels)**: consult Section 5
- **Guard clauses with conditional side effects**: consult Section 6
- **Multiple exception types with different handling per type**: consult Section 3

## Attribute and Lifecycle Patterns

- **Attribute-access edge cases** (descriptors, dynamic properties, deprecation paths): consult `attribute-and-lifecycle-patterns.md` Section 1
- **Resource-lifecycle testing** (context managers, semaphore synchronization, cleanup guarantees): consult `attribute-and-lifecycle-patterns.md` Section 2
- **While-loops with exception-driven termination**: consult `attribute-and-lifecycle-patterns.md` Section 3
- **Generator functions**: consult `attribute-and-lifecycle-patterns.md` Section 4

## Decorator and Closure Patterns

- **Decorator-with-optional-args** (function-type detection, partial application dispatch): test both with-args and without-args paths separately; verify `partial.func` and `partial.keywords`/`partial.args` — isinstance-only is insufficient. Consult `decorator-and-closure-patterns.md` Section 1
- **Closure/callback capture** (gt.link, functools.partial wrapping, weakref.proxy): capture callback from `mock.call_args[0][0]` and invoke to test closure body. Consult `decorator-and-closure-patterns.md` Section 2
- **Contextmanager-factory** (args accumulation, guaranteed finally-block): verify `hasattr(result, __enter__)` and `hasattr(result, __exit__)` explicitly, plus test the finally-block execution. Consult `decorator-and-closure-patterns.md` Section 3

## Type Dispatch

- **isinstance chain / type-dispatch functions**: For each type branch, plan BOTH an inclusion test (value IS handled by that branch) AND an exclusion test (value does NOT enter later branches). When a type is handled by an earlier check, include a test demonstrating it does NOT enter later branches

## Guard Clause Dual-Path Testing (for ALL functions with guard clauses)

1. For every guard clause that conditionally skips side effects: verify BOTH positive case (side effect IS called) AND negative case (side effect is NOT called)
2. **Enumerate all skipped operations**: For each early-return path, list ALL state mutations from the non-early-return path and verify each one does NOT happen
3. Merge negative-case assertions into existing branch tests when the branch test already covers the guard negative path. Only create a separate negative test when no existing test covers the negative path
4. **Caching/guard transition test**: For patterns where a value is set on first access and reused, include a test that calls the method twice on the same instance — do not test the cached branch only by manually pre-setting the cached value

## Execution Order Testing (for functions with sequential call dependencies)

- Plan ordering tests for ALL branch paths that change the call sequence, not just the happy path
- For 2-step sequences: use `mock_calls` verification in a merged test
- For 3+ steps: use `side_effect` callbacks tracking a `call_order` list

## Efficiency Rules

- Merge method call verification into branch tests when the merged test still performs explicit `assert_called_once_with()` argument verification
- Only verify logging calls when they differentiate branches (different log levels for different conditions)
- Prefer flat test functions for <15 tests; class-based for >=15 tests or shared setup
- For simple raise statements with a single condition: use 2-3 representative payload types, not exhaustive parametrization
- Do not read reference files for patterns not present in the target function
- **Shared mock setup**: When multiple tests share the same mock configuration, extract a shared helper function or use `setup_method`/`@pytest.fixture` that pre-configures common mocks. Individual tests should only override what differs
- **Match setup complexity to function complexity**: For simple functions (<10 lines, no complex state), prefer direct MagicMock-based setup. For complex functions requiring shared state, use class-based organization with helper methods
- For simple attribute assignments in constructors: merge multiple attribute checks into a single test
- **weakref.proxy + MagicMock incompatibility**: MagicMock auto-attributes conflict with proxy attribute interception. Use real objects
- **Warning message precision**: verify ALL substrings (name, version, alternative) with exact count == N, not >= 1
- **Large SKILL.md token cost**: only read reference files matching detected patterns - skip irrelevant ones
- **Run scripts directly from their original location** — do not copy them to the task directory
