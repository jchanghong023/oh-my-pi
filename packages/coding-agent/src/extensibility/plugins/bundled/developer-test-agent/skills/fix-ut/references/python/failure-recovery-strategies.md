# Failure Recovery Strategies

## When to Use

- Step 4: After 3 debugging attempts without resolving test failures
- Step 5.1: After 3 coverage validation cycles without reaching >=90%
- Tests consistently fail with same error pattern
- Coverage stuck at specific percentage despite targeted test additions

## Offline Mode (`ENV_MODE=offline`)

When no Python interpreter is available, the entire workflow runs in offline mode:
- **Step 4**: Skipped — tests are generated but not executed. All recovery strategies below apply only to normal mode.
- **Step 5**: Static coverage estimation replaces runtime coverage. Recovery for estimation shortfalls uses the same branch-specific test addition logic, but cannot verify whether mocks correctly trigger branches.
- **Step 5.1**: Applies with static estimation — create one test per uncovered branch, re-estimate. Max 3 cycles.
- **Key risk**: Mock setup errors that would only surface at runtime are undetectable in offline mode. Strongly recommend re-running with a live interpreter when one becomes available.

## Terminal Fallback

If all recovery cycles (3 in Step 4 + 3 in Step 5.1) are exhausted without reaching >=90%: report the following to the user: (a) the achieved coverage percentage, (b) the list of uncovered lines mapped to their branch conditions, (c) a summary of recovery strategies attempted for each uncovered branch. Suggest that the user manually review the uncovered branches — they may require runtime state, framework internals, or environment conditions that cannot be simulated in unit tests. Do NOT silently finalize with <90% coverage.

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

Check `tests/conftest.py` for existing fixtures. Use `app`, `client`, `authenticate` fixtures instead of mocking. Use real framework test context (e.g., test_request_context) instead of mocking request. Use `pytest.mark.settings` or framework config override for configuration instead of mocking config.

### Strategy 4: Check Environment

> `$PYTHON` refers to the interpreter resolved in Environment Setup (SKILL.md).

```bash
# Verify module importable
$PYTHON -c "from module import function; print('OK')"
$PYTHON -c "import sys; print(sys.path)"

# If $PYTHON is the system interpreter (venv creation failed during setup):
# - Project deps may not be installed; install missing ones: $PYTHON -m pip install --user <package>
# - Check whether $PYTHON points to a venv or system: $PYTHON -c "import sys; print(sys.prefix)"
#   A venv prefix differs from the system site-packages prefix.
```

### Strategy 5: Reduce Test Complexity

Break complex multi-assertion tests into simpler single-assertion tests. Isolate failing scenario, fix, then re-expand.

### Strategy 6: Escalate

Document failure pattern: function name, error message, debugging attempts, strategies tried, root cause hypothesis.

## Step 5.1 Recovery: Coverage <90% After 3 Cycles

### Strategy 1: Branch-Specific Tests

Run `parse_coverage.py` to identify missing lines. Map each to its branch condition. Create exactly ONE targeted test per missing branch.

### Strategy 2: Integration Approach

Use real helper functions instead of mocking them. This covers helper branches through target function tests.

### Strategy 3: Alternative Patterns

1. Configuration-based branches: `pytest.mark.settings` or `PropertyMock`
2. Exception simulation: mock specific exception types (not generic Exception)
3. State-dependent branches: test different object states explicitly
4. Direct function call: if HTTP client approach misses branches
5. PropertyMock for properties: if `@pytest.mark.settings` doesn't trigger branch

### Strategy 4: Document Limitations

Document: current coverage, missing lines, strategies attempted, remaining gaps.

## Recovery Decision Matrix

| Failure Type | Primary Strategy | Secondary Strategy | Escalation |
|---|---|---|---|
| Mock patching errors | Fix patching (Strategy 1) | Simplify mocking | Escalate |
| Import errors | Check environment | Fix imports | Escalate |
| Logic errors | Reduce complexity | Break tests | Escalate |
| Coverage stuck | Branch-specific tests | Integration approach | Document |
| Config branches | pytest.mark.settings | PropertyMock | Document |
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
2. AsyncMock coroutine warnings: replace with MagicMock for sync methods
3. DetachedInstanceError: use simple mock classes instead of real ORM objects
4. Custom fixture conflicts: use existing conftest.py fixtures; never create new framework app instances
5. Missing model fields: include required fields in custom model classes or use existing fixtures

## .coveragerc Recovery

1. **Primary approach**: `coverage run --rcfile=NUL -m pytest <test_file>` then `coverage json -o coverage.json --rcfile=NUL` — bypasses all .coveragerc issues
2. Fallback: `pytest <test_file> --cov=<source_module> --cov-report=json -v`
3. Do NOT modify tracked project configuration files — always use command-line overrides or temporary configs
4. If `parse_coverage.py` reports `total_executable_lines=0`: re-run coverage to generate fresh data
5. If `parse_coverage.py` reports unexpected results but direct coverage.json inspection confirms >=90%, accept the direct evidence and proceed
6. If both coverage commands fail: check for import errors in the test output, fix imports and retry

## parse_coverage.py Troubleshooting

If parse_coverage.py reports significantly lower coverage than expected:
1. Ensure `source_file_path` argument is provided to prevent cross-file contamination
2. Verify the source_file_path matches the actual file path in coverage.json (check keys in `files` dict)
3. If results still seem wrong, inspect coverage.json directly: `$PYTHON -c "import json; d=json.load(open('coverage.json')); [print(k) for k in d['files']]"`
4. Accept direct coverage.json evidence over script output when they conflict

## Recovery Anti-Patterns

1. Trying same strategy repeatedly → Move to next strategy
2. Over-writing working tests to fix style → Only fix failing tests
3. Coverage scope loss during rewrite → Enumerate branches before rewriting
4. Silent partial coverage → Document missing branches
5. Accepting `total_executable_lines=0` from parse_coverage.py → Re-run coverage to generate fresh data
6. Modifying project config files to work around tool issues → Use command-line overrides instead
7. Insisting on script output when direct evidence confirms the result → Accept direct evidence and proceed
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
| ModuleNotFoundError for package | Module not installed in venv | Run `$PYTHON -c "import X"` to verify. If missing, install via `$PYTHON -m pip install X` |
| ImportError: cannot import name | Wrong import path or name | Re-read source file to verify exact class/function name and import path |
| ModuleNotFoundError for project modules | sys.path does not include project root | Add sys.path.insert(0, project_root) at top of test file |
| AttributeError after correct import | Importing from wrong submodule | Check __init__.py re-exports; import from actual defining module instead |
| Wrong Python executable | Using wrong interpreter | Always use `$PYTHON -m pytest` explicitly — see Environment Setup in SKILL.md |

**Recovery steps**:
1. Read the error traceback to identify the exact failing import
2. Verify the module exists: `$PYTHON -c "import module_name"`
3. If module not found: install via `$PYTHON -m pip install module_name` or check sys.path
4. If name not found: re-read source file to verify exact export names
5. If path issue: add sys.path.insert(0, ...) at test file top
6. Re-run tests after each fix. Max 3 import-fix iterations within the Step 4 budget

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
2. Check if the mock uses spec=ClassName - if so, replace with __new__ + manual attributes (Step 3 rule 15)
3. Check if the attribute is a property - if so, use patch.object with new_callable=PropertyMock
4. Check if the mock is for a self-call - if so, use instance-level assignment instead of patch.object
5. Check if dict-like attributes are uninitialized - initialize as real empty dicts (Step 3 rule 18)
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
| Fixture scope conflict | Shared fixture state leaking between tests | Use function-scoped fixtures; reset shared state in setup_method |
| RuntimeError: generator ignored GeneratorExit | Generator not properly closed in test | Use with pytest.raises(...) context instead of manual next() calls |

**Recovery steps**:
1. If test hangs: add --timeout=10 to pytest command
2. Identify the hanging test from output
3. Check for real blocking primitives (Event, Queue, sleep) - mock all of them
4. Check for while-loops - ensure side_effect lists provide termination
5. Check for fixture conflicts - replace @patch with with patch(...) context managers
6. Simplify mock setup: remove complex side_effect chains; use direct return_value
7. Re-run with timeout. Max 3 timeout-fix iterations within the Step 4 budget

## Step 5.1 Failure Branch: Coverage Shortfall After Tests Pass

**Symptom**: All tests pass but coverage is below 90%.

**Recovery steps** (supplements existing Step 5.1 guidance):

1. Run with --cov-report=term-missing to get exact uncovered lines:
   $PYTHON -m pytest test_file --cov=source_module --cov-report=term-missing -v
2. Map each uncovered line to its branch condition by re-reading the source
3. For each uncovered branch, identify WHY existing tests do not cover it:
   - Missing branch test: No test triggers this condition - Create a targeted test
   - Mock interception: A mock replaces the real code path - Use real objects or adjust mock scope
   - Dead code: Line is unreachable in current code - Document as dead code
   - Framework-managed code: Line requires framework runtime - Try integration approach
4. Create ONE targeted test per uncovered branch (not per uncovered line)
5. After adding tests, re-run coverage validation
6. Maximum 3 coverage-improvement cycles
7. Terminal fallback: If coverage remains below 90% after 3 cycles, report: (a) achieved coverage %, (b) uncovered lines mapped to branch conditions, (c) recovery strategies attempted. Do NOT silently finalize below the gate.
