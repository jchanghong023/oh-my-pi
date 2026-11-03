# Sequential Workflow and Complex Pattern Testing Strategies

## When to Use

Use this reference during Step 2 (Plan Test Coverage) when the target function exhibits any of these patterns:
- 3+ sequential method calls with ordering dependencies
- State flags gating downstream operations
- Multiple exception types with different handling per type
- Recursive data traversal or self-calls
- Deeply nested conditional logic (3+ levels)
- 2+ sequential guard clauses with short-circuit behavior

If none of these patterns are present, the standard branch-analysis workflow in SKILL.md Step 2 is sufficient.

**Important**: For simple try/except functions with only 2-step sequences (e.g., pop then send_exception), a merged branch test with call order verification via `mock_calls` is sufficient — a dedicated ordering test is only required when 3+ sequential calls have ordering dependencies.

**Exclude logging calls from ordering tests**: Logging calls (`_log.debug`, `_log.warning`, `_log.error`) are observational side effects, not causally ordered operations. Including them in ordering tests adds complexity without meaningful verification value. Only include logging if the logging call has a causal ordering dependency.

## 1. Sequential Workflow with Ordering Requirements

### Pattern Recognition

Functions that execute a sequence of method calls where the order is semantically important:
- Setup/execute/teardown patterns
- Lifecycle methods that must run in a specific order
- Multiple stop/shutdown/kill calls with dependencies
- State flags that gate downstream operations

### Mandatory Action

When 3+ sequential method calls with ordering dependencies are detected, you MUST create a dedicated ordering test. This is not optional consultation — it is a required test.

### Testing Strategy

1. **Dedicated ordering test**: Create ONE test that verifies the complete pipeline order using a shared call tracker
2. **Complete pipeline coverage**: The ordering test MUST include ALL method calls in the sequence — do not omit intermediate calls, including `super()` calls
3. **super() calls in ordering**: `super().method()` is a method call that participates in the execution sequence. Include it in the ordering test using `patch.object(ParentClass, 'method')`. A common mistake is to omit super() calls from the tracked sequence.
4. **State-at-call-time verification**: For state flags that gate execution, verify the flag has the correct value at the moment of the gated operation using side_effect callbacks
5. **Merge vs dedicated decision**: Branch-level method call verification can be merged into branch tests, but ordering verification always gets a dedicated test
6. **Exclude logging from ordering**: Logging calls are observational side effects, not causally ordered operations. Exclude them from ordering tests unless they have semantic ordering dependencies.

### side_effect + return_value for Ordering Tests

When a mock needs both tracking (side_effect) and a return value, use a side_effect function that returns the desired value. NEVER set both `return_value` and `side_effect` on the same mock — `side_effect` takes priority and `return_value` is silently ignored:

```python
# CORRECT: side_effect function that both tracks and returns
call_order = []
def track_and_return(name, return_val):
    def fn(*args, **kwargs):
        call_order.append(name)
        return return_val
    return fn

mock_method.side_effect = track_and_return('method_name', expected_return_value)

# AVOID: Setting both on the same mock
mock_method.return_value = expected_value
mock_method.side_effect = track_fn  # return_value is silently ignored!
```

### Example Test Plan

| Test | Setup | Asserts |
|---|---|---|
| Normal path | All mocks return successfully | Correct return value, all calls made |
| Execution order | Shared call tracker on ALL methods (including super()) | `call_order == ['step1', 'step2', 'step3', 'super_step']` |
| State before operation | side_effect callback on gated call | State flag is True at call time |

### Common Mistakes

- Omitting intermediate calls from the ordering test — the ordering guarantee covers the FULL pipeline
- Omitting super() calls from the ordering test — super().stop() etc. are method calls too
- Including logging calls in ordering tests — they are observational, not causally ordered
- Using independent `assert_called_once` checks instead of a shared tracker — these cannot verify sequence
- Checking state only after the function returns — for race-condition-prone code, verify state at call time
- Creating a test named "test_xxx_calls_super_stop" that doesn't actually mock or assert super() was called — this is a false-positive test
- Setting both return_value and side_effect on the same mock — side_effect wins, return_value ignored

## 2. State-Flagged Execution

### Pattern Recognition

Functions that manage state transitions where:
- State flags gate execution paths (e.g., `_started`, `_being_killed`, `_stopped`)
- Multiple entry points can trigger state changes
- Race conditions exist between state checks and state mutations
- Early returns based on state flags
- Event objects that gate execution (e.g., `Event.wait()`, `Event.send()`)
- Idempotent operations where duplicate calls should return early
- Provider tracking via dict/set data structures with conditional branching on remaining items
- Callback registration with `functools.partial` wrapping before passing to consumers
- Consumer registration via dict population (e.g., `self._consumers[provider] = consumer`)

### Testing Strategy

1. **Early-return guard tests**: For each early-return guard (e.g., `if self._started: return`), create a test that sets the guard flag to True, verifies the function returns early, and verifies downstream operations were NOT called
2. **State-at-call-time verification**: Use `side_effect` callbacks on downstream calls to assert that state flags have the expected value at the moment the call is made
3. **Temporal ordering**: Verify state mutations happen before their dependent operations
4. **Concurrent entry simulation**: Test that a second call during an ongoing operation either completes safely or raises the expected error
5. **Mock concurrency primitives**: Replace `Event.wait()`, `Event.ready()` with controllable mocks to simulate different interleaving scenarios
6. **Idempotency tests**: For functions that should be idempotent, call the function twice with the same state and verify the second call returns early without side effects
7. **Guard-before-operation ordering**: Verify that the guard flag is set BEFORE the guarded operation begins using `side_effect` callbacks
8. **Remaining-item branching**: When the function branches based on whether items remain after removal, test both the "items remain" path (multiple items, remove one) and the "no items remain" path (single item, remove it)
9. **Event signaling after state change**: When the function uses Event objects for coordination, verify Event.send() is called at the correct point in the execution sequence using side_effect callbacks
10. **Partial-wrapped callback verification**: When callbacks are wrapped with `functools.partial`, verify the partial object's `func` attribute matches the original, and inspect `partial.args`/`partial.keywords` for bound arguments. Do NOT use identity comparison (`is`) — partial creates a new object each time
11. **Dict registration verification**: When the function registers objects in a dict, verify both key existence AND value identity: `assert provider in obj._consumers` AND `assert obj._consumers[provider] is expected_consumer`

### Example Test Plan

| Test | State Setup | Asserts |
|---|---|---|
| Normal path | Default state | Transitions correctly, cleanup called |
| Already completed | Completion flag True | Early return, no duplicate cleanup |
| In progress | Progress flag True | Waits or raises, no duplicate operation |
| State before critical op | side_effect on critical call | Flag is correct at call time |
| Idempotency | Call twice with same state | Second call returns early, no duplicate side effects |
| Items remain after removal | Multiple items registered | Removed item gone, others remain |
| No items remain after removal | Single item registered | Empty-state branch taken |
| Event signaled after change | side_effect on signaling call | Event.send() called after state change |
| Callback wrapped with partial | Consumer setup | `isinstance(cb, partial)`, `cb.func == original`, `cb.args == expected` |
| Dict registration | Provider + consumer | `provider in _consumers` AND `_consumers[provider] is consumer` |

### Common Mistakes

- Only testing the happy path — race conditions only appear under specific state combinations
- Checking state AFTER the function returns instead of AT the time of critical operations
- Using `assert_called_once()` without verifying the state was correct when the call was made
- Not testing the "already in progress" scenario where two callers race
- Not verifying that downstream operations were NOT called in the early-return path — use `assert_not_called()`
- Assuming `Event.wait()` always succeeds — test timeout and exception paths
- Not testing the "no items remain" branch — only testing the common case where items exist
- Using identity comparison (`is`) for partial-wrapped callbacks — partial creates a new object each time
- Only checking `key in dict` without verifying the value — the value could be wrong or None
- Not verifying Event.send() is called with the correct arguments

## 3. Multi-Exception Error Handling

### Pattern Recognition

Functions that:
- Catch multiple exception types in separate `except` blocks
- Attach or propagate tracking identifiers through exception paths
- Log different messages or perform different cleanup per exception type
- Return different error responses or take different actions per exception type
- Route outcomes based on error type (e.g., requeue vs acknowledge)
- Suppress certain exception types (e.g., BaseException subclasses used for cooperative cancellation) while handling others
- Call self methods recursively within exception handling (e.g., `self.kill()` from within `except`)

### Testing Strategy

1. **One test per exception type**: Each `except` block must have a dedicated test — never group multiple exception types in one test
2. **Tracking identifier propagation**: For each exception path, verify any tracking identifier is:
   - Present in the error response/propagated exception
   - Matches the input identifier exactly
   - Not lost when the exception is caught and re-raised or wrapped
3. **Error message completeness**: Verify the FULL error message content for each exception type, including any embedded identifiers. Check the exception class's `__str__` or `__repr__` method to understand the actual format — do not assume the raw constructor argument is the full message.
4. **Cleanup per exception**: If different exception types trigger different cleanup, verify each cleanup path independently
5. **Logging differentiation**: When different exception types log at different levels (warning vs error), verify the correct level is used
6. **Outcome routing exclusivity**: When different exception types route to different outcomes (e.g., requeue vs acknowledge), verify the correct outcome for each type AND that the outcomes are mutually exclusive (exactly one called, never both, never neither)
7. **Exception suppression verification**: When a specific exception type is caught and suppressed (not re-raised), verify the function does NOT re-raise it and that cleanup operations still execute after suppression. Use `pytest.raises()` to confirm the exception does NOT propagate.
8. **Recursive self-call in exception handling**: When a function calls `self.method()` recursively within exception handling, mock `self.method` on the instance to intercept the recursive call, then call `ClassName.method(instance, ...)` to invoke the real method. Verify the recursive call was made with correct arguments.
9. **Thread/cleanup tracking verification**: For functions that clean up tracked resources (e.g., removing threads from sets), verify removal is called for each resource and that tracking collections are emptied.

### Example Test Plan

| Test | Exception Trigger | Asserts |
|---|---|---|
| Exception type A | `side_effect=ExceptionA` | Correct error response, identifier preserved |
| Exception type B | `side_effect=ExceptionB` | Different error response, identifier preserved |
| Exception type C | `side_effect=ExceptionC` | Cleanup called, identifier in log |
| Identifier in propagated error | exception re-raised | Verify identifier survives catch-and-wrap |
| Outcome routing A | ExceptionA raised | Correct outcome (e.g., requeue), not the other |
| Outcome routing B | ExceptionB raised | Correct outcome (e.g., acknowledge), not the other |
| Exception suppressed | BaseException subclass | No re-raise, cleanup still called |
| Recursive self-call | Exception in handler | `self.method()` called, guard prevents duplicate |
| Resource cleanup | Normal exit | Resources removed from tracking collection |

### Common Mistakes

- Testing only that exceptions are raised, not that tracking identifiers survive the catch-and-handle
- Using `match='partial'` instead of verifying the complete error message including identifier
- Asserting exception string representation without checking the actual format — exception classes may format differently
- Grouping multiple exception types in one parametrized test — each type needs independent verification
- Not verifying that the identifier in the error response matches the input, not just that "an" identifier exists
- Not verifying outcome routing exclusivity — both outcomes could be called or neither could be called
- Treating BaseException subclasses the same as Exception — some are used for cooperative cancellation, not errors
- Not testing that suppressed exceptions do NOT propagate — the function should silently consume them
- Using `except Exception` in tests to catch BaseException subclasses — they inherit from BaseException, not Exception
- Not verifying tracking collections are properly emptied after cleanup

## 4. Recursive Data Traversal

### Pattern Recognition

Functions that recursively traverse and transform nested data structures. Common signals:
- Recursive calls to self or helper functions
- `isinstance(x, dict)` / `isinstance(x, list)` dispatch
- Accumulator or path-tracking parameters
- Pattern matching or string replacement within traversal

### Testing Strategy

1. **Nested fixture construction**: Build test inputs with controlled nesting depth (0, 1, 2, 3+ levels) to verify recursion terminates correctly at each depth
2. **Transformation accuracy per level**: Verify that transformation applies at every nesting level, not just the top
3. **Type preservation**: Verify the function returns the same structure type (dict→dict, list→list) after transformation
4. **Non-matching entries**: Include entries that should NOT be transformed to verify the function doesn't over-apply
5. **Empty structures**: Test with `{}`, `[]`, `None` as inputs
6. **Mixed structures**: Test lists containing dicts, dicts containing lists, etc.
7. **Intermediate state verification**: For any intermediate state changes (e.g., `del callargs['self']`, `dict.pop(key)`), create a dedicated test that explicitly verifies the state change. Do NOT rely on output equality to implicitly cover state changes.

### Recursive Method Call Mocking

When the target function calls `self.method()` recursively (e.g., `self.get_message(correlation_id)`):

```python
# CORRECT: Intercept the recursive call on the instance
consumer.get_message = MagicMock(return_value=expected_result)
# Then call the real method directly
TargetClass.get_message(consumer, correlation_id)

# AVOID: patch.object on the class mocks BOTH the initial and recursive calls
with patch.object(TargetClass, 'get_message', ...):
    # This prevents the real method from executing at all
```

Alternative: Use `side_effect` on dependencies to simulate the retry path without mocking the recursive call directly.

### Example Test Plan

| Test | Input | Asserts |
|---|---|---|
| Shallow structure | Flat dict/list | Transformation applied correctly |
| Nested depth 1 | One level of nesting | Transformation at depth 2 |
| Nested depth 2+ | Two or more levels | Transformation at depth 3+ |
| Mixed types | List of dicts | List preserved, each dict transformed |
| No match | Entries that shouldn't transform | Structure unchanged for those entries |
| Empty | `{}`, `[]`, `None` | Returns empty/null without error |
| Intermediate state | Dict with removable key | `assert key not in result` explicitly |

### Common Mistakes

- Only testing the base case — recursive functions must be tested at multiple depths
- Using `patch.object(ClassName, 'method')` to mock a recursive call — this prevents the real method from executing
- Using simple comparison instead of structural comparison — verify the entire output structure
- Not testing that non-matching entries are preserved unchanged
- Relying on output equality to implicitly verify intermediate state changes — use explicit assertions

## 5. Deeply Nested Conditional Logic

### Pattern Recognition

Functions with 3+ levels of nested conditionals where each level depends on different conditions.

### Testing Strategy

1. **Path enumeration**: Draw the decision tree; each leaf is a test case
2. **Combinatorial coverage**: For N boolean conditions, ensure at least all N+1 basic paths are covered (each condition true/false at least once)
3. **Boundary conditions at each level**: Test the exact boundary that flips each condition
4. **Early return verification**: If deep paths return early, verify that shallow paths do NOT execute the deep logic
5. **State after partial execution**: If a deep path modifies state before an early return, verify the state is correct

### Common Mistakes

- Only testing the deepest path — missing intermediate paths
- Not verifying that early returns prevent deeper logic from executing
- Assuming compound conditions are independent — they may share underlying state

## 6. Guard Clause Priority Testing

### Pattern Recognition

Functions with 2+ sequential guard clauses that short-circuit (early return or raise) based on different conditions. The order of these guards is semantically important — changing the order would change behavior.

### Testing Strategy

1. **Priority order verification**: For each pair of adjacent guard clauses, create a test that triggers the earlier guard and verifies the later guard's operation is NOT called
2. **Guard independence**: For each guard clause, verify it works correctly regardless of the state of other guard conditions
3. **Early-return guard tests**: For each early-return guard (e.g., `if self._started: return`), set the guard condition to True, verify the function returns early, and verify downstream operations were NOT called
4. **Guard-before-operation ordering**: Verify that the guard flag is set BEFORE the guarded operation begins using `side_effect` callbacks

### Example Test Plan

| Test | Guard Setup | Asserts |
|---|---|---|
| Guard A fires before B | Condition A True, B True | Early return at A, B's operation not called |
| Guard B fires when A False | Condition A False, B True | B's operation called, A's operation not called |
| No guard fires | Both conditions False | Normal path executes |

### Common Mistakes

- Not testing guard priority — only testing each guard independently without verifying order
- Not verifying that downstream operations were NOT called in the early-return path — use `assert_not_called()`
- Checking state after the function returns instead of at the time of critical operations
