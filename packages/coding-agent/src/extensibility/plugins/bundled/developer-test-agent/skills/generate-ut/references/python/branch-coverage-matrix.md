# Branch Coverage Matrix Templates

## Overview

Use branch coverage matrices during Step 2 (Plan Test Coverage) for complex functions. The matrix tracks both branches and their associated method calls.

## Matrix Template

| Branch ID | Condition | Method Calls in Branch | Expected Outcome | Test Name | Verify Approach |
|---|---|---|---|---|---|
| B1 | if condition_a | `self.method_x`, `self.method_y` | outcome_a | test_<func>_condition_a | merge |
| B2 | elif condition_b | `self.method_z` | outcome_b | test_<func>_condition_b | merge |
| B3 | else | (none) | default_outcome | test_<func>_default | — |
| B4 | try block success | `self.setup()`, `self.execute()`, `self.teardown()` | success_path | test_<func>_success + test_<func>_execution_order | merge + dedicated |
| B5 | except SpecificError | `self._log.error(...)` | error_handling | test_<func>_specific_error | merge |
| S1 | Security-critical branch | `auth.check(...)`, `auth.deny(...)` | security_outcome | test_<func>_security_case | dedicated |

### Column Guide

- **Method Calls in Branch**: List every method call that executes in this branch path, including logging calls and `super()` calls
- **Verify Approach**:
  - `merge` — verify method call arguments within the branch test
  - `dedicated` — create a separate test for this call's argument verification
  - Use `dedicated` when: call has ordering requirements, call arguments are computed values needing explicit `assert_called_once_with()`, call is upstream and differs from downstream, call is a `super()` call, or verification requires intermediate state checks

## Security-Critical Branch Markers

Mark as CRITICAL when involving: auth/authorization, CSRF, passwords/tokens, input sanitization, session management, access control. CRITICAL branches MUST be covered even if overall coverage >=90%.

## Compound Condition Decomposition

For `if a and b`:

| Branch ID | Condition | Test Name |
|---|---|---|
| B1a | a=True, b=True | test_<func>_a_and_b_both_true |
| B1b | a=True, b=False | test_<func>_a_true_b_false |
| B1c | a=False, b=True | test_<func>_a_false_b_true |
| B2 | else | test_<func>_neither |

## Falsy Variant Testing

For branches depending on falsy values (security-critical only):

| Config Value | Test Name |
|---|---|
| `None` | test_<func>_config_none |
| `False` | test_<func>_config_false |
| `[]` | test_<func>_config_empty_list |
| `""` | test_<func>_config_empty_string |

## Timestamp Boundary Testing

| Comparison | Test Case | Test Name |
|---|---|---|
| `a < b` | a clearly less than b | test_<func>_a_less_than_b |
| `a < b` | a exactly equal to b | test_<func>_a_equal_b |
| `a < b` | a clearly greater than b | test_<func>_a_greater_than_b |

## Error Message Verification

For every `raise` statement, plan a test that verifies:
- The exact exception type
- The COMPLETE error message content (not just a partial substring)
- All semantically important portions of the message
- For TypeError/ValueError with repr formatting: test with 2-3 distinct types (e.g., int, list, dict, None)

Example: If the error message is `"This consumer can no longer be used"`, verify the full message, not just `"This consumer"`.

## Intermediate State Change Verification

For any line that modifies intermediate state, plan a test that explicitly verifies the state change:

| State Change | Test Name | Assertion |
|---|---|---|
| `del callargs['self']` | test_self_removed_from_callargs | `assert 'self' not in result` |
| `dict.pop(key, None)` | test_key_removed_when_absent | `assert key not in result` |
| `self._dict[key] = value` | test_value_stored_in_dict | `assert container._dict[key] is expected_value` |
| `self._flag = True` | test_flag_set_before_operation | side_effect callback verifies flag at call time |
| `collection.update(items)` | test_collection_updated | `mock_update.assert_called_once_with(expected_items)` AND `assert expected in collection` |
| `collection.extend(items)` | test_collection_extended | `mock_extend.assert_called_once_with(expected_items)` AND `assert len(collection) == expected` |

**Key principle**: Do NOT rely on output equality assertions to implicitly verify intermediate state changes. Equality comparisons may pass even if intermediate state changes are skipped, because the expected output may not include the removed key or may match with a wrong value.

**Conditional application**: Only create dedicated intermediate state tests when the mutation is in a separate code path from any existing branch test. If the mutation is naturally verified within a branch test, no dedicated test is needed.

**Multi-step mutations to the same data structure**: When a function performs multiple sequential mutations to the same data structure (e.g., 3 `dict.update()` calls with different sources), a single merged test may verify the final state but miss intermediate override semantics. Plan a dedicated test for each mutation step:

| Mutation Step | Test Name | Assertion |
|---|---|---|
| First `dict.update(base)` | test_base_headers_applied | `assert base_keys in result` |
| Second `dict.update(override1)` | test_override1_takes_precedence | `assert override1_keys replace base_keys` |
| Third `dict.update(override2)` | test_override2_overrides_both | `assert override2_keys replace both earlier sources` |

This ensures last-writer-wins override precedence is explicitly verified for each step, not just the final state.

## Guard Clause Priority

When the function has 2+ sequential guard clauses with short-circuit behavior:

| Guard Clause | Test Name | Assertion |
|---|---|---|
| Guard A fires first | test_guard_a_fires_before_b | Early return at A, B's operation `assert_not_called()` |
| Guard B fires when A False | test_guard_b_fires | B's operation called, A's operation not called |
| No guard fires | test_no_guard | Normal path executes |

## Sequential Workflow Ordering

When method calls follow a setup/execute/teardown pattern:

1. Add a row to the matrix with Verify Approach = `dedicated`
2. The dedicated test uses a shared call tracker (see `examples/test-patterns.md` Pattern 2)
3. The ordering test MUST include ALL method calls in the pipeline — do not omit intermediate calls
4. **Include super() calls**: `super().stop()`, `super().__init__()`, etc. are method calls that participate in the execution sequence. Add them to the ordering test pipeline. Use `patch.object(ParentClass, 'method')` to mock and verify.
5. **Exclude logging calls**: `_log.debug`, `_log.warning`, `_log.error` are observational side effects. Exclude them from ordering tests unless they have causal ordering dependencies.
6. Use side_effect callbacks to record call order, then assert the exact sequence
7. For state-at-call-time verification, see `references/sequential-workflow-testing.md` Section 1

## Constructor Verification

When verifying object construction (e.g., `self._pool = ThreadPool(size=max_workers)`), assert both the type and the constructor arguments:

| Verification Level | Assertion | Sufficient? |
|---|---|---|
| Existence only | `assert obj._pool is not None` | NO -- passes with any truthy value |
| Type only | `assert isinstance(obj._pool, ThreadPool)` | Partial -- doesn't verify configuration |
| Type + arguments | `mock_pool_cls.assert_called_once_with(size=N)` | YES -- verifies both type and configuration |

## Usage

1. Read target function and identify all branch points
2. Fill in matrix for each branch, including method calls (including super() and logging calls)
3. Mark security-critical branches as CRITICAL
4. Decompose compound conditions into sub-conditions
5. Enumerate falsy variants for security-critical branches
6. Plan error message verification tests for every raise statement
7. Plan intermediate state change verification tests for every state mutation
8. Decide verify approach (merge vs dedicated) for each method call
9. Use matrix as checklist during test generation
10. Verify each row has a corresponding test before finalizing
