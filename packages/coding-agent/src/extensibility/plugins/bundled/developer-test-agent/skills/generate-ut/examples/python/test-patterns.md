# Test Patterns for Python Unit Testing

## Pattern 1: Mocking with unittest.mock

### 1.1 Function Patching with Argument Verification

```python
from unittest.mock import patch, MagicMock

@patch('module.external_api_call')
def test_function_with_mocked_api(mock_api):
    mock_api.return_value = {'status': 'success'}
    result = target_function()
    assert result == expected_value
    mock_api.assert_called_once_with(expected_args)  # Verify call arguments
```

### 1.2 Capturing Mock Call Arguments

When you need to verify computed values passed to mocks, use side_effect callbacks:

```python
def test_sleep_time_computation():
    captured_args = []
    def capture_timeout(*args, **kwargs):
        captured_args.append((args, kwargs))
        raise TimeoutError()  # Or return a mock

    with patch('module.Timeout', side_effect=capture_timeout):
        result = target_function()

    # Verify actual computed values, not just that the call happened
    assert captured_args[0][0][0] == pytest.approx(0.5, abs=0.1)
    assert captured_args[0][1].get('max_retries') == 3
```

**Key principle**: `assert_called_once()` only checks the call happened. `assert_called_once_with(expected_args)` checks the actual argument values. Always prefer the latter for non-trivial verification.

### 1.3 Mocking vs Configuration

| Scenario | Requirement | Correct | Incorrect |
|---|---|---|---|
| External API call | "mocking", "patch" | unittest.mock.patch | pytest.mark.settings |
| Config override | "configuration", "settings" | pytest.mark.settings | unittest.mock.patch |
| Framework context | "context", "request context" | framework test client or test_request_context | unittest.mock.patch |

### 1.4 Bypassing Decorators

```python
result = target_function.__wrapped__(arg1, arg2)
```

## Pattern 2: Call-Order Verification

Independent `assert_called_once` checks on separate MagicMock objects cannot verify execution order.

```python
# CORRECT: Shared call tracker — includes ALL calls in the pipeline
call_order = []
def track_call(name):
    def side_effect(*args, **kwargs):
        call_order.append(name)
    return side_effect

mock_inject.side_effect = track_call('inject')
mock_setup.side_effect = track_call('setup')
mock_execute.side_effect = track_call('execute')
mock_teardown.side_effect = track_call('teardown')
target_function()
assert call_order == ['inject', 'setup', 'execute', 'teardown']

# CORRECT: mock_calls sequence verification
parent_mock = MagicMock()
parent_mock.method_a()
parent_mock.method_b()
assert parent_mock.method_calls == [call.method_a(), call.method_b()]

# AVOID: Independent assertions that don't verify order
mock_a.stop.assert_called_once()  # Confirms call, not sequence
mock_b.stop.assert_called_once()  # Confirms call, not sequence
```

**Key principle**: The ordering test MUST include ALL method calls in the pipeline, including `super()` calls. Do not omit intermediate calls or super() calls just because they are "internal" — the ordering guarantee covers the full pipeline. Exclude logging calls — they are observational, not causally ordered.

### 2.1 State-at-Call-Time Verification

When a method call sets state that affects downstream behavior (e.g., a flag set before a critical operation), verify the state is already set at the time of the downstream call:

```python
# CORRECT: Verify state at call time using side_effect
def verify_flag_before_critical_op(*args, **kwargs):
    assert obj._flag is True  # State already set

obj.critical_op.side_effect = verify_flag_before_critical_op
obj.run()  # If _flag is set after critical_op(), this assertion fails

# AVOID: Only checking final state after all calls complete
obj.run()
assert obj._flag is True  # True, but doesn't prove WHEN it was set
```

## Pattern 3: Exception Testing

### 3.1 Specific Exception Types

Create SEPARATE tests for each named exception type.

```python
# CORRECT
def test_bad_signature_error():
    with patch('module.func', side_effect=BadSignature):
        result = target_function()
        assert result == expected_bad_sig

def test_type_error():
    with patch('module.func', side_effect=TypeError):
        result = target_function()
        assert result == expected_type_err

# AVOID: Generic Exception
@patch('module.func', side_effect=Exception)
def test_error(mock_func):
    ...
```

### 3.2 Complete Error Message Verification

Verify the COMPLETE error message content, not just a partial substring.

```python
# CORRECT: Verify complete message
def test_wait_raises_runtime_error_when_stopped():
    with pytest.raises(RuntimeError, match=r"can no longer be used"):
        consumer.wait()

# AVOID: Partial match misses key content
def test_wait_raises_runtime_error_when_stopped():
    with pytest.raises(RuntimeError, match=r"This consumer"):  # Too vague
        consumer.wait()
```

**Key principle**: A partial match can pass even when key message content is missing. Always match the distinctive portion of the error message.

### 3.3 Multiple TypeError/ValueError Types

For TypeError/ValueError raise statements that format the invalid value using `repr()`, test with 2-3 distinct types to validate the formatting:

```python
# CORRECT: Test with multiple distinct types
@pytest.mark.parametrize('payload', [123, [1, 2], {'key': 'val'}, None])
def test_invalid_payload_type_raises_type_error(payload):
    with pytest.raises(TypeError, match=r"Payload must be a string"):
        process(payload)

# AVOID: Only testing with one type repeated
@pytest.mark.parametrize('payload', [123, 456, 789])
def test_invalid_payload_type_raises_type_error(payload):
    # All integers — doesn't validate repr() formatting for different types
    ...
```

### 3.4 Exception Message Format Verification

Before asserting exception message content, check the exception class's `__str__` or `__repr__` method to understand the actual format. Exception classes often format messages differently from raw constructor arguments:

```python
# CORRECT: Check exception attributes directly
def test_unknown_service_error():
    with pytest.raises(CommandError):
        import_service('unknown_service')
    # Or verify the attribute
    try:
        import_service('unknown_service')
    except CommandError as e:
        assert 'unknown_service' in str(e)

# AVOID: Assuming the raw constructor argument is the full message
# UnknownService('test_service') → str() returns 'Unknown service `test_service`'
# Not just 'test_service'
```

## Pattern 4: Framework Context Testing

For functions that require framework application context (e.g., web framework request context, app context):

```python
def test_request_context(app):
    with app.test_request_context('/path?param=value'):
        result = view_function()
        assert result.status_code == 200
```

**Key principle**: When a function depends on framework context objects (request, session, current_user), prefer the framework's test client or test context over mocking the context directly.

## Pattern 5: Dependency Injection and Container Mocking

### 5.1 Mock Container and Injected Dependencies

```python
container = MagicMock()
container.config = {'connection_uri': 'memory://', 'max_workers': 10}
container.service_name = 'test_service'
container.shared_extensions = {}
```

### 5.2 Minimal Fixture (Skip Binding When Not Needed)

When testing a method that doesn't use container/service bindings, skip the binding step:

```python
# CORRECT: Direct instantiation without binding
handler = RequestHandler('GET', '/test')

# AVOID: Binding that may cause RuntimeError
handler.bind()  # Only needed if method uses container
```

### 5.3 Hybrid Mock + Real for Order-Sensitive Tests

When execution order matters, prefer real container object with lightweight service class.

```python
class FakeService:
    name = "fake"

container = RealContainerClass(FakeService, config)
# Real extension lists provide trackable .stop() calls
```

### 5.4 Concurrency Primitive Mocking

```python
# CORRECT: Mock .wait() for deterministic control
with patch('module._died.wait', side_effect=RuntimeError):
    result = container.kill()

# AVOID: Real timing primitives
# spawn_after(0.1, ...)  # Fragile
```

### 5.5 Avoid Patching Framework Response/Request Classes

Patching framework `Response`/`Request` classes breaks `isinstance` checks. Use real objects instead:

```python
# CORRECT: Use real Response objects
from framework.wrappers import Response
result = target_function()
assert isinstance(result, Response)

# AVOID: Patching Response breaks isinstance
with patch('module.Response') as mock_response:
    ...  # isinstance(result, Response) will fail
```

### 5.6 Class Attribute Patching

When the target accesses a class via a class attribute (e.g., `self.publisher_cls`), use `patch.object` on the owning class:

```python
# CORRECT: Intercept class attribute lookup
with patch.object(Responder, 'publisher_cls', return_value=mock_publisher):
    responder.send_response(...)

# AVOID: Module-level patch doesn't intercept class attribute
with patch('module.Publisher') as MockPublisher:
    responder.send_response(...)  # Still uses real Publisher via self.publisher_cls
```

### 5.7 Shared Class Instance Direct Assignment

When mocking attributes on objects whose class is shared across instances (extension sets, proxy collections), assign MagicMock directly on the instance -- NOT PropertyMock on the class:

```python
# CORRECT: Direct instance assignment -- each instance gets independent mock
container.extensions = MagicMock()
container.extensions.all = mock_extensions
container.dependencies = MagicMock()
container.dependencies.all = mock_dependencies

# AVOID: PropertyMock patches at class level -- all instances share the same mock
patch.object(type(container.extensions), 'all', new_callable=PropertyMock)
# This causes all instances to share the same mock
```

### 5.8 Replacing Instance Methods with Mocks

When mocking instance methods on handler/service objects, replace with `MagicMock()` first before setting side_effect or return_value:

```python
# CORRECT: Replace with MagicMock first
handler.check_signature = MagicMock(side_effect=IncorrectSignature)

# AVOID: Setting side_effect on real method object
handler.check_signature.side_effect = IncorrectSignature
# AttributeError: 'method' object has no attribute 'side_effect'
```

### 5.9 Real Classes for Decorator-Based Discovery

For testing container `__init__` entrypoint/dependency discovery, use real service classes with actual decorators:

```python
# CORRECT: Real service class with decorators
class SimpleService:
    name = "simple"

    @entrypoint_decorator
    def method(self):
        pass

container = RealContainerClass(SimpleService, config)

# AVOID: Mocking inspect.getmembers -- MagicMock fails isfunction predicate
```

## Pattern 6: Security Testing

### 6.1 Falsy Variant Coverage

For security-critical branches depending on falsy values, test ALL falsy variants.

```python
@pytest.mark.parametrize('config_value', [None, False, [], ''])
def test_config_falsy_variants(config_value):
    with patch('module.config', config_value):
        result = security_check()
        assert result == 'denied'
```

### 6.2 URL Validation/Redirect Security

```python
@pytest.mark.parametrize('url', ['//evil.com', '\\\\evil.com', '/\\evil.com'])
def test_open_redirect_blocked(url):
    result = validate_redirect(url)
    assert result != url
```

## Pattern 7: Mock Object Initialization

```python
# CORRECT: Initialize with matching value
mock_user = MagicMock()
mock_user.tf_primary_method = 'sms'  # "if user.tf_primary_method != 'sms'" is False

# AVOID: Default None causes false-positive
mock_user.tf_primary_method = None  # Condition is True unintentionally
```

## Pattern 8: Timestamp Boundary Testing

```python
@patch('module.naive_utcnow', return_value=datetime(2024, 1, 15, 12, 0, 0))
def test_timestamp_boundary(mock_now):
    result_clearly_less = check_timestamp(timestamp_before)
    result_equal = check_timestamp(timestamp_equal)
    result_clearly_greater = check_timestamp(timestamp_after)
```

## Pattern 9: Coverage Approach

**Primary approach** (bypasses .coveragerc issues):

> `$PYTHON` is the interpreter resolved in Environment Setup (SKILL.md); replace `{SKILL_DIR}` with the baseDir returned when loading `generate-ut`.

```bash
# Step 1: Run tests with coverage
$PYTHON -m coverage run --rcfile=NUL -m pytest <test_file> -v

# Step 2: Generate JSON report
$PYTHON -m coverage json -o coverage.json --rcfile=NUL

# Step 3: Parse with function-specific script
$PYTHON "{SKILL_DIR}/scripts/python/parse_coverage.py" coverage.json <func> <start> <end> <source_path>
```

**Fallback** (if primary fails):

```bash
$PYTHON -m pytest <test_file> --cov=<source_module> --cov-report=term-missing --cov-report=json -v
```

Do NOT modify the project's `.coveragerc` directly.

## Pattern 10: Logging Call Verification

When logging calls differentiate branches, verify the log level and message. Use `with patch(...)` context manager -- NOT `@patch` decorator -- to avoid fixture ordering errors:

```python
# CORRECT: Context manager avoids fixture ordering issues
def test_error_branch_logs_warning():
    with patch('module._log') as mock_log:
        container.kill()
    mock_log.warning.assert_called_once_with("Expected message", exc_info=True)
    # Verify error level, not just that logging happened

def test_success_branch_logs_debug():
    with patch('module._log') as mock_log:
        container.process_request(request)
    mock_log.debug.assert_called_with("Processing complete")
    # Verify debug level specifically -- different from error branch

# AVOID: @patch decorator with pytest fixtures causes "fixture not found" errors
@patch('module._log')
def test_error_branch_logs_warning(mock_log, some_fixture):  # ERROR: fixture ordering
    ...
```

**Context manager _log_time note**: When patching a module-level `_log` that is also used by a context manager (e.g., `_log_time`), the context manager may also call `_log` methods. If `assert_called_once_with` fails unexpectedly, use `call_args_list` filtering or `mock_calls` inspection instead.

**Key principle**: When `_log.warning` appears in one branch and `_log.error` in another, verifying the correct log level is a non-trivial assertion that distinguishes the branches. Only verify logging calls when they differentiate branches — skip when logging is informational.

## Pattern 11: Helper Class Naming

Do NOT name helper classes with `Test` prefix — causes pytest collection warnings.

```python
# CORRECT
class MockUser:
    def __init__(self, email):
        self.email = email

# AVOID
class TestUser:
    def __init__(self, email):
        self.email = email
```

## Pattern 12: Merged vs Dedicated Method Call Verification

### When to Merge into Branch Test

```python
# CORRECT: Call is the only one in this branch, and branch test verifies it
def test_success_path():
    with patch('module.process') as mock_process:
        mock_process.return_value = 'ok'
        result = handler.handle(request)
    mock_process.assert_called_once_with(request)  # Merged into branch test
```

### When to Create Dedicated Test

```python
# CORRECT: Upstream call needs independent argument verification
def test_check_signature_called_with_correct_args():
    with patch('module.check_signature') as mock_check:
        mock_check.return_value = True
        handler.handle_request(args, kwargs)
    mock_check.assert_called_once_with(args, kwargs)
    # This is separate because a downstream call verification
    # does NOT verify upstream call arguments

# CORRECT: Ordering requires dedicated test
def test_execution_order():
    call_order = []
    def track(name):
        def fn(*a, **kw):
            call_order.append(name)
        return fn
    mock_inject.side_effect = track('inject')
    mock_setup.side_effect = track('setup')
    mock_execute.side_effect = track('execute')
    target_function()
    assert call_order == ['inject', 'setup', 'execute']
```

**Key principle**: If merging would drop `assert_called_once_with()` or weaken the assertion to just checking a key exists in kwargs, create a dedicated test instead.

## Pattern 13: State-at-Call-Time Verification

For functions where state flags gate execution paths (e.g., lifecycle shutdown with completion/in-progress flags), verify that state has the correct value at the moment a critical operation is called, not just after the function returns.

```python
# CORRECT: Verify state at call time using side_effect callback
def test_flag_set_before_critical_operation():
    state_at_call_time = {}

    def capture_state_on_call(*args, **kwargs):
        # Capture the value of the flag when the critical op is called
        state_at_call_time['flag'] = obj._in_progress

    obj.critical_op.side_effect = capture_state_on_call
    obj.run()

    assert state_at_call_time['flag'] is True
    # This verifies the temporal ordering: flag was set BEFORE critical_op()

# AVOID: Only checking state after return
def test_flag_set_before_critical_operation():
    obj.run()
    assert obj._in_progress is True  # True, but doesn't prove ordering
```

**Key principle**: For race-condition-prone code, checking state after the function completes only proves the final state, not that the state was correct when it mattered. Use side_effect callbacks to capture state at the exact moment of critical operations.

## Pattern 14: Correlation ID Propagation Verification

For functions that propagate tracking identifiers through exception paths, verify the identifier survives the entire chain.

```python
# CORRECT: Verify correlation ID in propagated exception
def test_correlation_id_preserved_on_value_error():
    correlation_id = 'req-abc-123'
    with patch('module.process', side_effect=ValueError("bad data")):
        with pytest.raises(HandlerError) as exc_info:
            handler.handle_request(correlation_id=correlation_id, data=bad_data)

    # Verify identifier is in the propagated error, not just the original
    assert exc_info.value.correlation_id == correlation_id
    # Also verify it appears in the error message if embedded
    assert correlation_id in str(exc_info.value)

# AVOID: Only checking that an exception was raised
def test_value_error_raised():
    with patch('module.process', side_effect=ValueError):
        with pytest.raises(HandlerError):
            handler.handle_request(correlation_id='req-abc-123', data=bad_data)
    # This doesn't verify the identifier survived the catch-and-wrap
```

**Key principle**: When an exception is caught and re-raised or wrapped, any tracking identifier must survive the transformation. Testing only that the exception type is correct misses the critical data integrity requirement.

## Pattern 15: Recursive Depth Testing

For recursive functions (e.g., data structure transformation), test at multiple nesting depths.

```python
# CORRECT: Test at multiple depths
def test_transformation_depth_0():
    # Flat structure — no nesting
    result = transform({'key': 'value'})
    assert result == expected_flat

def test_transformation_depth_1():
    # One level of nesting
    result = transform({'outer': {'key': 'value'}})
    assert result == expected_depth_1

def test_transformation_depth_2():
    # Two levels of nesting
    result = transform({'l1': {'l2': {'key': 'value'}}})
    assert result == expected_depth_2

def test_transformation_list_of_dicts():
    # List containing dicts
    result = transform([{'key': 'v1'}, {'other': 'ok'}])
    assert result == expected_mixed

def test_transformation_preserves_non_matching():
    result = transform({'keep': 'unchanged', 'key': 'value'})
    assert result['keep'] == 'unchanged'  # Not transformed

# AVOID: Only testing at depth 0
def test_transformation_works():
    result = transform({'key': 'value'})
    assert result == expected
    # Misses bugs in recursive traversal of deeper structures
```

**Key principle**: Recursive functions must be tested at multiple depths because the recursive case may have bugs that the base case does not expose. Test depth 0 (base case), depth 1, depth 2+, and mixed structures.

## Pattern 16: Recursive Method Call Mocking

When the target function calls `self.method()` recursively (e.g., `self.get_message(correlation_id)`), intercept the recursive call on the instance, not the class:

```python
# CORRECT: Intercept the recursive call on the instance
consumer.get_message = MagicMock(return_value=expected_result)
# Then invoke the real method directly
TargetClass.get_message(consumer, correlation_id)

# Alternative: Use side_effect on dependencies to simulate the retry path
# without mocking the recursive call directly
mock_drain_events.side_effect = [IOError("connection lost"), None]

# AVOID: patch.object on the class mocks BOTH the initial and recursive calls
with patch.object(TargetClass, 'get_message', ...):
    # This prevents the real method from executing at all
```

**Key principle**: `patch.object(ClassName, 'method')` replaces the method for ALL calls including the initial one, preventing the real method from executing. When you need the real method to run but intercept its recursive calls, set the mock on the instance instead.

## Pattern 17: super() Call Verification

For functions that call `super().method()`, use `patch.object` on the parent class to create a mock, then assert the mock was called. NEVER rely on exception-free execution as evidence that super() was called.

```python
# CORRECT: Mock and assert super() call
with patch.object(ParentClass, 'stop', autospec=True) as mock_super_stop:
    container.stop()

mock_super_stop.assert_called_once()

# CORRECT: Include super() in ordering test
call_order = []
def track(name):
    def fn(*a, **kw):
        call_order.append(name)
    return fn

mock_entrypoints_stop.side_effect = track('entrypoints_stop')
mock_super_stop.side_effect = track('super_stop')
container.stop()
assert call_order == ['entrypoints_stop', 'super_stop']

# AVOID: Relying on exception-free execution as evidence
def test_stop_calls_super_stop():
    container.stop()  # No mock, no assertion — false-positive test
    # This passes whether or not super().stop() is actually called
```

**Key principle**: A test named "test_xxx_calls_super_stop" that doesn't actually mock or assert `super().stop()` is a false-positive test. Always use `patch.object(ParentClass, 'method')` and assert the mock was called.

## Pattern 18: side_effect + return_value Conflict

When a mock needs both tracking (side_effect) and a return value, use a side_effect function that returns the desired value. NEVER set both `return_value` and `side_effect` on the same mock — `side_effect` takes priority and `return_value` is silently ignored:

```python
# CORRECT: side_effect function that both tracks and returns
call_order = []
def track_and_return(name, return_val):
    def fn(*args, **kwargs):
        call_order.append(name)
        return return_val
    return fn

mock_get_params.side_effect = track_and_return('get_params', ((mock_request,), {}))

# AVOID: Setting both on the same mock
mock_get_params.return_value = ((mock_request,), {})
mock_get_params.side_effect = track_fn  # return_value is silently ignored!
```

## Pattern 19: Exception Object Identity in Mock Assertions

When verifying mock call arguments that contain exception objects created by `side_effect`, use `isinstance()` and `str()` checks instead of identity (`is`) comparison. Exception objects captured in `except` clauses are the same object, but when comparing mock call args, Python checks object identity which can fail:

```python
# CORRECT: isinstance check for exception type
for call_args in mock_method.call_args_list:
    assert isinstance(call_args[0][2], ValueError)
    assert str(call_args[0][2]) == "expected message"

# AVOID: Identity comparison fails for new exception instances
mock_method.assert_called_once_with(arg1, arg2, expected_exc)
# AssertionError: assert ValueError("fail") is ValueError("fail") — different objects
```

## Pattern 20: Class Property Override for Testing

When overriding class-level properties for testing, prefer subclass-based approach over class-level mutation:

```python
# CORRECT: Subclass approach — no leakage, no restoration needed
class CustomEventHandler(EventHandler):
    broadcast_identifier = property(lambda self: custom_id)

handler = CustomEventHandler(...)
# No finally block needed, no restoration

# CORRECT: Class-level mutation with safe restoration
original_prop = type(handler).broadcast_identifier  # Save BEFORE override
try:
    type(handler).broadcast_identifier = property(lambda self: custom_id)
    # ... test code ...
finally:
    type(handler).broadcast_identifier = original_prop  # Restore from saved reference

# AVOID: Using .fget in finally — captures already-overridden value
try:
    type(handler).broadcast_identifier = property(lambda self: custom_id)
    # ... test code ...
finally:
    type(handler).broadcast_identifier = property(EventHandler.broadcast_identifier.fget)
    # BUG: fget may already be the lambda, not the original
```

## Pattern 21: Intermediate State Change Verification

For any line that modifies intermediate state (e.g., `del dict[key]`, `dict.pop(key)`, `self._dict[key] = value`), create a dedicated test that explicitly verifies the state change. Do NOT rely on output equality to implicitly cover state changes:

```python
# CORRECT: Explicit state change verification
def test_self_removed_from_callargs():
    result = get_redacted_args(method, None, 'A', b='B')
    assert 'self' not in result  # Explicitly verify key removal

def test_value_stored_in_dict():
    container.spawn_worker(...)
    assert container._worker_threads[worker_ctx] is gt  # Verify value, not just key

# CORRECT: Constructor argument verification
mock_pool_cls = MagicMock()
with patch.object(module, 'ThreadPool', mock_pool_cls):
    container = RealContainerClass(service_cls, config)
mock_pool_cls.assert_called_once_with(size=max_workers)  # Verify type + args

# AVOID: Relying on output equality
def test_get_redacted_args():
    result = get_redacted_args(method, None, 'A', b='B')
    assert result == expected  # 'self' may be absent in expected too, so this doesn't verify removal

# AVOID: Key-only check
def test_worker_thread_stored():
    container.spawn_worker(...)
    assert worker_ctx in container._worker_threads  # Passes with None or wrong value
```

## Common Anti-Patterns

1. Over-mocking without verification — always assert mock call arguments
2. Shallow JSON testing — inspect payload structure, not just Content-Type
3. Configuration for mocking requirement — use unittest.mock when "mocking" is required
4. Generic Exception testing — test specific exception types separately
5. Only testing enabled config state — test both enabled AND disabled
6. Independent assert_called_once for order verification — use shared tracker or mock_calls
7. Assuming downstream call verification covers upstream calls — verify each method call independently
8. Only checking call happened without verifying arguments — use assert_called_once_with()
9. Ignoring logging calls in method call enumeration — logging calls are method calls too (when they differentiate branches)
10. Modifying project config files to work around tool issues — use command-line overrides instead
11. Partial error message matches — verify COMPLETE message content, not just substrings
12. Patching Response class — breaks isinstance checks; use real Response objects instead
13. Ordering test omitting intermediate calls — the ordering test MUST include ALL calls in the pipeline, including super() calls
14. Merging that weakens assertions — if merging drops assert_called_once_with(), create a dedicated test
15. Checking state only after function returns — for race-condition-prone code, verify state at call time using side_effect callbacks
16. Only testing correlation ID in original exception — verify it survives catch-and-wrap in the propagated exception
17. Only testing recursive base case — test at multiple nesting depths to catch recursive traversal bugs
18. Using @patch decorator with pytest fixtures — causes fixture ordering errors; use context manager instead
19. patch('module.Class') for class attributes — use patch.object(OwnerClass, 'attr') instead
20. Relying on exception-free execution as evidence for super() calls — always mock and assert explicitly
21. Setting both return_value and side_effect on same mock — side_effect wins silently
22. Using identity comparison for exception objects in mock assertions — use isinstance() instead
23. Class property override without safe restoration — save original before overriding, or use subclass
24. Dict key-only checks — always assert both key existence AND value equality
25. is not None for constructor verification — assert type AND constructor arguments
26. Only one type for TypeError/ValueError tests — test with 2-3 distinct types to validate repr() formatting
27. Including logging calls in ordering tests — they are observational, not causally ordered
28. Setting side_effect on real method objects — replace with MagicMock() first
