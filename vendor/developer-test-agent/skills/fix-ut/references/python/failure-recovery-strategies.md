# Failure Recovery Strategies

## When to Use

- Step 4: After 3 debugging attempts without resolving test failures
- Coverage improvement: After 3 measured cycles without reaching the applicable task threshold
- Tests consistently fail with same error pattern
- Coverage stuck at specific percentage despite targeted test additions

## Offline Mode (`ENV_MODE=offline`)

When no compatible interpreter is available, mark runtime verification blocked:
- **Step 4**: Not run; record the missing interpreter. When the interpreter is available but a required test dependency is missing, report that dependency instead of switching runners or installing it.
- **Coverage validation**: Static branch analysis may guide test design, but is not measured coverage and cannot satisfy the gate. If only coverage tooling is unavailable, still run tests with the selected runner and report coverage as unverified.

## Terminal Fallback

If the test or coverage recovery budget is exhausted, report the failing tests and attempted fixes, plus the measured coverage, uncovered lines mapped to branch conditions and coverage strategies attempted where available. Distinguish missing data and diagnostic data from a failed run from a measured shortfall; none can be marked as passing the coverage gate.

## Step 4 Recovery: Test Failure After 3 Debugging Attempts

### Strategy 1: Fix Mock Patching

Common mock patching failures and their fixes:

| Error Pattern | Root Cause | Fix |
|---|---|---|
| Real network/message-queue connection attempt | `patch('module.Class')` doesn't intercept class attribute | Use `patch.object(OwnerClass, 'attr')` instead |
| `isinstance` check failure | Patching framework class (e.g., Response) | Use real objects instead of patching |
| Fixture ordering error | `@patch` decorator with pytest fixtures | Replace with `with patch(...)` context manager |
| `KeyError` on dict key removal | `del dict[key]` when key may not exist | Use `dict.pop(key, None)` |
| `AttributeError` on patch.object | Instance attribute not a class attribute | Assign directly on instance: `obj.attr = mock` |
| `AttributeError` on side_effect | Real method object has no mock attributes | Replace with `MagicMock()` first: `obj.method = MagicMock(...)` |
| side_effect + return_value conflict | Both set on same mock; side_effect wins | Use side_effect function that returns the value |
| Exception identity mismatch | New exception instances in mock call args | Use `isinstance()` instead of `is` comparison |
| Shared class instance pitfall | PropertyMock patches all instances | Assign directly on instance: `obj.attr = MagicMock()` |
| Class property override leakage | `fget` captures already-overridden value | Save original before overriding, or use subclass |
| Test hangs/timeouts | Real Event.wait() or blocking primitives | Always mock Event class; never use real blocking calls |
| Argument style mismatch | KeyError on call_args inspection | Check positional vs keyword arguments in source |
| super() MRO patching failure | AttributeError on wrong parent class | Verify MRO with `[c for c in cls.__mro__ if method in c.__dict__]` |
| Self-call intercepted by patch.object | `patch.object(ClassName, 'method')` on self-call | Use instance-level: `obj.method = MagicMock()` — patch.object intercepts the initial call too |
| Exception attribute missing | `exc.timeout` fails on simple Exception subclass | Use `exc.args[0]` — simple subclasses store in .args tuple |
| Mock infinite loop in while-generator | `mock_queue.get.return_value` in while loop | Use side_effect that mutates loop-termination state, or mock the state mutation |
| Missing method call arg verification | Only assert_called/assert_called_once used | Add assert_called_once_with() or assert_called_with() to verify actual arguments |

### Strategy 2: Simplify Mocking

Replace complex mock chains with simple return values. Remove `side_effect` lambdas, use direct `return_value`. Use `MagicMock()` without spec for simpler behavior. Test one mock interaction at a time.

### Strategy 3: Use Real Fixtures

Reuse existing project helpers. With pytest, use existing `conftest.py` fixtures (`app`, `client`, `authenticate`) or settings markers if the project provides them. With unittest, use `setUp`/`addCleanup` or project helpers, not pytest fixtures or markers. Prefer a real framework test context (e.g., `test_request_context`) to mocking it.

### Strategy 4: Check Environment

> Keep the interpreter, runner, command and working directory selected in [fix-rules.md](./fix-rules.md). Use `"$PYTHON"` in Bash and `& $PYTHON` in PowerShell.

```bash
# Verify module importable
"$PYTHON" -c "from module import function; print('OK')"
"$PYTHON" -c "import sys; print(sys.executable, sys.version, sys.prefix); print(sys.path)"
```

If the chosen environment lacks a required dependency, report the missing package and the chosen environment. Never install dependencies automatically or switch interpreters to make a failing run pass.

### Strategy 5: Reduce Test Complexity

Break complex multi-assertion tests into simpler single-assertion tests. Isolate failing scenario, fix, then re-expand.

### Strategy 6: Escalate

Document failure pattern: function name, error message, debugging attempts, strategies tried, root cause hypothesis.

## Coverage Recovery: Below the Target After 3 Cycles

### Strategy 1: Branch-Specific Tests

Use the current coverage report; if missing, follow [Coverage Data Recovery](#coverage-data-recovery). Use `read` to load `skill://bundled-developer-test-agent/generate-ut` for its baseDir only; NEVER start the generation workflow. From the project directory, run:

```bash
"$PYTHON" "{GENERATE_SKILL_DIR}/scripts/python/parse_coverage.py" "$COV_DIR/coverage.json" --source "<source_file_path>" --function "<function_name>" <start_line> <end_line>
```

Replace `{GENERATE_SKILL_DIR}` with the returned baseDir. Pass `--threshold <percent>` when the task specifies a threshold. Omit `--function` for module scope or replace it with `--changed-lines '<JSON line-number array>'` for incremental line scope. A nonzero parser status means below threshold or no valid data; distinguish them in the report. Map valid missing lines to their branch conditions and create one targeted test per missing branch.

### Strategy 2: Integration Approach

Use real helper functions instead of mocking them. This covers helper branches through target function tests.

### Strategy 3: Alternative Patterns

1. Configuration-based branches: a project-provided pytest marker (pytest only), framework config override or `PropertyMock`
2. Exception simulation: mock specific exception types (not generic Exception)
3. State-dependent branches: test different object states explicitly
4. Direct function call: if HTTP client approach misses branches
5. Use `PropertyMock` if the framework config override does not reach a property-based branch

### Strategy 4: Document Limitations

Document: current coverage, missing lines, strategies attempted, remaining gaps.

## Recovery Decision Matrix

| Failure Type | Primary Strategy | Secondary Strategy | Escalation |
|---|---|---|---|
| Mock patching errors | Fix patching (Strategy 1) | Simplify mocking | Escalate |
| Import errors | Check environment | Fix imports | Escalate |
| Logic errors | Reduce complexity | Break tests | Escalate |
| Coverage stuck | Branch-specific tests | Integration approach | Document |
| Config branches | Framework config override (or existing pytest marker with pytest) | PropertyMock | Document |
| Exception branches | Mock specific types | Integration test | Document |
| Self-call interception | Instance-level mock | Simplify mocking | Escalate |
| Infinite loop in while-generator | side_effect with state mutation | Real objects for loop control | Escalate |

## Framework-Specific Recovery

### Container/Service Framework Recovery

1. Container mock failures: ensure mock has `config`, `service_name`, `max_workers`, `shared_extensions`
2. Network/message-queue connection errors: never try real connections; mock all external connections
3. Concurrency primitive failures: patch `spawn`, `Event`, and `Queue` explicitly
4. Extension binding errors: use `MagicMock()` for container (weakref proxy compatibility)
5. Call-order verification failures: use `mock.mock_calls` or shared call tracker instead of independent `assert_called_once`
6. For ordering-sensitive lifecycle tests: prefer real container with lightweight service class
7. Patching Response breaks isinstance: use real Response objects instead of mocking Response class
8. `patch('module.Class')` failing to intercept class attribute: use `patch.object(OwnerClass, 'attr')` instead
9. `patch.object` AttributeError on instance attributes: assign directly on the instance
10. Shared class instance pitfall: assign directly on instance, not PropertyMock on class
11. Real method objects don't support mock attributes: replace with MagicMock() first
12. Context manager calling _log methods: use `call_args_list` filtering instead of `assert_called_once_with`
13. Timeout context manager mocking: use FakeTimeout class with `__enter__`/`__exit__` that properly suppresses timeout exception when `exception=False`
14. For inspect.getmembers-based discovery: use real service classes with decorators instead of mocking inspect predicates
15. Self-call patch.object trap: for `self.method()` calls, use instance-level `obj.method = MagicMock()` instead of `patch.object(ClassName, 'method')` which blocks the initial call
16. Exception attribute access: if `exc.attr` fails on simple Exception subclass, use `exc.args[0]` instead

### Web Framework Recovery

1. Proxy/thread-local object RuntimeError: never patch proxy objects directly; use framework test client or patch underlying function
2. Async mocking: use `MagicMock` only for synchronous methods. For a Python 3.6 target, use an `async def` stub and `loop.run_until_complete()` for coroutines; do not introduce `AsyncMock` or other newer APIs/syntax.
3. DetachedInstanceError: use simple mock classes instead of real ORM objects
4. Custom setup conflicts: reuse pytest fixtures or unittest setup helpers according to the chosen runner; avoid duplicate framework app instances
5. Missing model fields: include required fields in custom model classes or use existing fixtures

## Coverage Data Recovery

1. Reuse the selected interpreter and runner; follow the temporary-directory, project configuration and exit-code rules in `skill://bundled-developer-test-agent/generate-ut/references/python/generation-rules.md`. `coverage run` supports unittest discovery and pytest; pytest-cov is an option only for a pytest run with the plugin already available.
2. Keep project config unchanged. Use only this run's isolated data. Save the test exit status in the same shell before generating any diagnostic report; data from a failed run cannot satisfy the gate.
3. If no compatible coverage tool is available, run tests without coverage and report the gate unverified. Do not install dependencies or change runners.
4. If the parser reports zero executable lines, verify the source identity and scope. Regenerate isolated data only if the previous measurement used the wrong scope or is stale; never accept an empty denominator.
5. If reporting fails, inspect the test/coverage output for the actual error. Use a project-provided alternative only if it yields verifiable coverage for the same target scope, not merely an aggregate percentage.

## parse_coverage.py Troubleshooting

If parse_coverage.py reports significantly lower coverage than expected:
1. Supply the exact target source file with `--source`; add the requested line scope if not measuring the whole module
2. Verify that the source path resolves to the same file as a key in `coverage.json`'s `files` map
3. If results still seem wrong, inspect coverage.json directly: `"$PYTHON" -c "import json, sys; print(*json.load(open(sys.argv[1], encoding='utf-8'))['files'], sep='\n')" "$COV_DIR/coverage.json"`
4. If inspecting JSON directly, verify the same source and target line scope. Do not replace scoped evidence with project totals or infer success from missing data.

## Recovery Anti-Patterns

1. Trying same strategy repeatedly → Move to next strategy
2. Over-writing working tests to fix style → Only fix failing tests
3. Coverage scope loss during rewrite → Enumerate branches before rewriting
4. Silent partial coverage → Document missing branches
5. Accepting zero executable lines → Verify source and scope; report unavailable if not resolvable
6. Modifying project config to work around tool issues → Keep the config and isolate only the new data and reports
7. Treating aggregate or failed-run coverage as acceptance evidence → Require passing tests and valid scoped data
8. Full file rewrites when only specific tests need fixes → Use targeted edits instead
9. Using patch.object for self-calls → Use instance-level assignment instead
10. Assuming exception constructor args are named attributes → Check with .args tuple


## Step 4 Failure Branches: Common Test Execution Failures

These failure branches supplement the Step 4 common fixes list with explicit recovery paths for recurring failure modes.

### Failure Branch 1: Import Errors in Generated Tests

**Symptom**: ModuleNotFoundError, ImportError, or AttributeError on module attribute when running tests.

**Root causes and fixes**:

| Error Pattern | Root Cause | Fix |
|---|---|---|
| ModuleNotFoundError for package | Module is missing from the chosen environment | Run `"$PYTHON" -c "import X"` to verify; report a missing dependency |
| ImportError: cannot import name | Wrong import path or name | Re-read source file to verify exact class/function name and import path |
| ModuleNotFoundError for project modules | Wrong working directory or project import path | Reuse the project working directory and existing import setup |
| AttributeError after correct import | Importing from wrong submodule | Check __init__.py re-exports; import from the defining module instead |
| Wrong Python executable | Runner invoked outside its intended runtime | Reuse the interpreter and runner recorded in [fix-rules.md](./fix-rules.md) |

**Recovery steps**:
1. Read the error traceback to identify the exact failing import
2. Verify the module exists: `"$PYTHON" -c "import module_name"`
3. If a required third-party module is absent, report it; do not install it
4. If the imported name is absent, verify exact exports in the source
5. For project import errors, follow its working directory and import setup; do not hide environment errors by injecting paths into tests
6. Re-run the same test command after each fix. Max 3 import-fix iterations within the Step 4 budget

### Failure Branch 2: Mock Setup Failures / AttributeError During Execution

**Symptom**: AttributeError on MagicMock object, TypeError: Mock object is not callable, or unexpected mock behavior.

**Root causes and fixes**:

| Error Pattern | Root Cause | Fix |
|---|---|---|
| MagicMock has no attribute X | Attribute accessed before being set on spec-limited mock | Remove spec=ClassName or use __new__ + manual attribute assignment |
| Mock object is not callable | Mocking a property instead of a method | Use patch.object with new_callable=PropertyMock for properties |
| AttributeError on real object | Attribute only set conditionally in __init__ | Use __new__ + manual attribute assignment to bypass __init__ |
| TypeError on side_effect | side_effect function signature does not match call signature | Match side_effect parameters to the real function signature |
| AssertionError on assert_called_once_with | Real method replaced after patch | Use instance-level obj.method = MagicMock() for self-calls |

**Recovery steps**:
1. Read the error traceback to identify the failing attribute/method
2. Check if the mock uses `spec=ClassName`; if needed, construct the subject with `__new__` and initialize required attributes as described in [fix-rules.md](./fix-rules.md)
3. Check if the attribute is a property - if so, use patch.object with new_callable=PropertyMock
4. Check if the mock is for a self-call - if so, use instance-level assignment instead of patch.object
5. Initialize uninitialized dict-like attributes as real empty dicts where the test scenario requires them
6. Re-run tests after each fix. Max 3 mock-fix iterations within the Step 4 budget

### Failure Branch 3: Test Timeout or Fixture Conflict

**Symptom**: Tests hang indefinitely, pytest timeout triggers, or fixture teardown errors.

**Root causes and fixes**:

| Error Pattern | Root Cause | Fix |
|---|---|---|
| Test hangs / no output | Real Event.wait() or blocking call | Always mock Event.wait() with return_value or side_effect |
| Test hangs in while-loop | side_effect single value causes infinite loop | Use side_effect list: [None, Exception()] to ensure termination |
| Fixture teardown error | Fixture dependency ordering | Replace @patch decorators with with patch(...) context managers |
| pytest.timeout expired | Complex mock chain causing slow execution | Simplify mock setup; reduce test interdependence |
| Fixture scope conflict | Shared fixture state leaking between tests | Use function-scoped fixtures with pytest or reset state in unittest `setUp` / `addCleanup` |
| RuntimeError: generator ignored GeneratorExit | Generator not properly closed in test | Close the generator and assert expected errors with `pytest.raises` or `TestCase.assertRaises` |

**Recovery steps**:
1. If a test hangs, add `--timeout=10` only for pytest when the selected interpreter's `-m pytest --help` lists it; otherwise use the shell tool's timeout
2. Identify the hanging test from output
3. Check for real blocking primitives (Event, Queue, sleep) - mock all of them
4. Check for while-loops - ensure side_effect lists provide termination
5. Check for fixture conflicts - replace @patch with with patch(...) context managers
6. Simplify mock setup: remove complex side_effect chains; use direct return_value
7. Re-run with the same timeout mechanism. Max 3 timeout-fix iterations within the Step 4 budget

## Failure Branch: Coverage Shortfall After Tests Pass

**Symptom**: The target tests pass but measured coverage is below the applicable task threshold.

**Recovery steps** (supplement [Coverage Recovery](#coverage-recovery-below-the-target-after-3-cycles)):

1. Reuse [Coverage Data Recovery](#coverage-data-recovery). With pytest-cov, use `--cov-report=term-missing` for diagnostics; evaluate the gate with scoped line data.
2. Map each uncovered line to its branch condition by re-reading the source
3. For each uncovered branch, identify WHY existing tests do not cover it:
   - Missing branch test: No test triggers this condition - Create a targeted test
   - Mock interception: A mock replaces the real code path - Use real objects or adjust mock scope
   - Dead code: Line is unreachable in current code - Document as dead code
   - Framework-managed code: Line requires framework runtime - Try integration approach
4. Create ONE targeted test per uncovered branch (not per uncovered line)
5. After adding tests, re-run coverage validation
6. Maximum 3 coverage-improvement cycles
7. Terminal fallback: If coverage stays below the gate, report achieved coverage, uncovered lines mapped to branch conditions and strategies attempted. If valid scoped data is unavailable, report coverage unverified instead.
