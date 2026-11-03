# Dependency-Aware Mocking Strategies

## Dependency Detection and Strategy Selection

| Dependency Category | Detection Signals | Primary Strategy | Mock Approach |
|---|---|---|---|
| External I/O | network calls, DB connections, file I/O, message queue imports | Patch at module level | `@patch` or `with patch(...)` on the specific I/O function |
| Framework-managed objects | framework imports (e.g., web frameworks, ORM libraries, microservice frameworks), app context objects | Patch framework objects at source module | Use real objects when possible; mock only the specific method needed |
| Injected dependencies | constructor params, method params (pool, queue, exchange, config, etc.) | Mock the injected object | `MagicMock()` with required attributes/return values |
| Standard library / utility | `inspect.getmembers`, `copy.deepcopy`, `os.path.exists`, `time.time` | Patch at source module | `with patch('module.util_func')` |
| Internal self-calls | `self.method()` within target function | Instance-level assignment | `obj.method = MagicMock()` |
| Parent class calls | `super().method()` | `patch.object` on MRO-resolved class | `patch.object(ActualClass, 'method')` |

## General Mocking Rules

1. Never patch framework proxy objects (e.g., thread-local proxies, request context objects) directly -- they require app context. Patch the underlying module-level function instead
2. Patch module-level functions with precise return values
3. Prefer MagicMock over AsyncMock for synchronous methods
4. Use `type(mock).attr = PropertyMock(return_value=val)` for property mocking on objects with custom descriptors
5. Patch lazily-imported functions at the source module, not the importing module
6. Patch ONLY minimal dependencies needed to trigger the target branch
7. Use `patch.dict(sys.modules, {'module': None})` for ImportError testing
8. For objects requiring app context or initialization: use `ClassName.__new__(ClassName)` + manual attribute assignment instead of calling `__init__`
9. Avoid real ORM/database objects outside their session context -- use simple mock classes to prevent DetachedInstanceError-like failures
10. Do not use AsyncMock for synchronous framework methods -- use MagicMock

## Fixture Selection

- Simple utility with no framework dependencies -> standalone mock-based tests
- Function uses framework context objects (app context, request context, etc.) -> minimal framework setup or patch the specific object
- Function needs only configuration -> patch config directly, avoid full framework initialization
- Existing conftest.py fixtures available -> prefer them; fall back to self-contained fixtures if setup errors occur
- Function with circular imports -> create a `conftest.py` in the `tests/` directory with proper module initialization (e.g., `sys.path.insert`, `django.setup()`, or manual import chain breaking)

## Class Attribute vs Instance Attribute Patching

### Class Attribute Patching

When the target function accesses a class via a class attribute (e.g., `self.publisher_cls`), `patch('module.ClassName')` replaces the module-level reference but NOT the already-resolved class attribute. Use `patch.object` instead:

```python
# CORRECT: Intercept class attribute lookup
with patch.object(Responder, 'publisher_cls', return_value=mock_publisher):
    responder.send_response(...)

# AVOID: Module-level patch doesn't intercept class attribute
with patch('module.Publisher') as MockPublisher:
    responder.send_response(...)  # Still uses real Publisher via self.publisher_cls
```

### Instance Attribute Assignment

Instance attributes set in `__init__` (e.g., `service_cls`, `config`, `service_name`) are not class-level properties. To track calls on them, assign a callable directly rather than using `patch.object` on the class:

```python
# CORRECT: Direct assignment on the instance
container.service_cls = track_function

# AVOID: patch.object on the class for instance attributes
# patch.object(type(container), 'service_cls', ...)  # AttributeError: not a class attribute
```

## Self-Call vs Other-Call Mock Strategy

When the target function calls `self.method()` internally:

```python
# CORRECT: Instance-level assignment -- intercepts only the recursive call
consumer.get_message = MagicMock(return_value=expected_result)
# Then invoke the real method directly:
TargetClass.get_message(consumer, correlation_id)

# AVOID: patch.object on the class -- intercepts the INITIAL call too
with patch.object(TargetClass, 'get_message', ...):
    consumer.get_message(correlation_id)  # Real method never executes!
```

**Rule**: Use `patch.object(ClassName, 'method')` ONLY for calls to OTHER classes or parent classes (super()). For self-calls within the target function, always use instance-level assignment.

## Shared Class Instance Mocking

When mocking attributes on objects whose class is shared across instances (e.g., collection proxies, extension sets), do NOT use PropertyMock on the class -- all instances share the same class. Instead, assign MagicMock directly on the instance:

```python
# CORRECT: Direct instance assignment -- each instance gets independent mock
container.extensions = MagicMock()
container.extensions.all = mock_items

# AVOID: PropertyMock patches at class level -- all instances share the same mock
patch.object(type(container.extensions), 'all', new_callable=PropertyMock)
```

For collection method calls (e.g., `container.extensions.all.stop()`), prefer adding mock items to the set and letting the proxy's natural `__getattr__` work, rather than patching `__getattr__` directly. Empty collections silently skip method calls.

## Replacing Instance Methods with Mocks

When mocking instance methods on handler/service objects, always replace with `MagicMock()` first before setting `side_effect` or `return_value`. Real Python method objects don't support mock attributes:

```python
# CORRECT: Replace with MagicMock first
handler.check_signature = MagicMock(side_effect=IncorrectSignature)

# AVOID: Setting side_effect on real method object -- AttributeError
handler.check_signature.side_effect = IncorrectSignature  # method has no side_effect
```

## Minimal Fixture Principle

When testing a method that doesn't use container/service bindings, skip the binding step. Use direct instantiation:

```python
# CORRECT: Skip binding when method doesn't need it
handler = HttpRequestHandler('GET', '/test')

# AVOID: Unnecessary binding that may cause RuntimeError
handler = container_entrypoint.handler_cls(container, 'method')
handler.bind()  # RuntimeError if container not properly configured
```

## Real Classes for Discovery Testing

For testing `inspect.getmembers`-based discovery (entrypoint detection, decorator scanning, etc.), prefer defining real classes with actual decorators over mocking `inspect.getmembers`. MagicMock objects fail isinstance checks used by inspect predicates (`isfunction`, `ismethod`):

```python
# CORRECT: Real class with decorators
class SimpleService:
    name = "simple"

    @rpc
    def method(self):
        pass

container = RealContainerClass(SimpleService, config)

# AVOID: Mocking inspect.getmembers -- MagicMock fails isfunction predicate
```

## Context Manager Simulation

For framework context managers (e.g., Timeout, retry blocks, resource locks), create a faithful simulation class:

```python
class FakeTimeout:
    """Simulates a Timeout context manager: suppresses timeout exception when exception=False."""
    class TimeoutInterrupt(BaseException):
        pass

    def __init__(self, seconds=None, exception=True):
        self.exception = exception

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if not self.exception and exc_type is not None and issubclass(exc_type, self.TimeoutInterrupt):
            return True  # Suppress the timeout exception
        return False
```

## Call-Order Verification

Independent `assert_called_once` checks on separate MagicMock objects cannot verify execution order. Use one of these approaches:

```python
# Approach 1: Shared call tracker
call_order = []
def track_call(name):
    def side_effect(*args, **kwargs):
        call_order.append(name)
    return side_effect

obj.method_a.side_effect = track_call('method_a')
obj.method_b.side_effect = track_call('method_b')
# After execution:
assert call_order == ['method_a', 'method_b']

# Approach 2: mock_calls sequence verification
all_calls = obj.method_calls  # Preserves order
```

## Hybrid Mock + Real Approach

For tests verifying execution order of lifecycle methods, prefer real object instantiation with lightweight classes over pure MagicMock. Real proxy/collection objects provide realistic call semantics that MagicMock cannot replicate.

```python
class FakeService:
    name = "fake"

container = RealContainerClass(FakeService, config)
# Real extension lists with trackable .stop() calls
```

## Blocking Primitive Mocking

For concurrency-based code paths (event loops, greenlets, threading, async frameworks):

1. **Prefer mock.patch on .wait()** to simulate specific return values or exceptions -- deterministic, no timing dependencies
2. **Avoid real timing primitives** (spawn_after, sleep, Timer) -- fragile and harder to debug
3. **Mock Event objects explicitly** when testing `ready()` / `wait()` interactions
4. **Always mock Event.wait() in unit tests** -- never use real blocking primitives in tests that exercise the wait() call path. Real blocking primitives cause test hangs and timeouts.

## super() MRO Patching

When patching `super().method()` calls, the correct patching target is the class that actually defines the method in the MRO, which may not be the direct parent class:

```python
# CORRECT: Verify MRO resolution before patching
mro_targets = [c for c in TargetClass.__mro__ if 'method' in c.__dict__]
ActualClass = mro_targets[0]  # The class that actually defines the method
with patch.object(ActualClass, 'method', autospec=True) as mock_method:
    ...

# AVOID: Assuming __bases__[0] is the correct target
# In multiple inheritance, super() may resolve to a class further up the MRO
with patch.object(TargetClass.__bases__[0], 'method', ...):  # May be wrong class
    ...
```

## Positional vs Keyword Argument Verification

When verifying mock call arguments, check whether the target function uses positional or keyword arguments. A quick source inspection prevents `KeyError` on `call_args` inspection:

```python
# If the function uses positional args: verify via call_args[0][index]
result = mock_method.call_args[0][2]  # Third positional argument

# If the function uses keyword args: verify via call_args[1]['key']
result = mock_method.call_args[1]['key']

# Check the source to determine which style is used before writing assertions
```

## Standalone Strategy

1. Patch external I/O: network calls, filesystem operations, database connections
2. Use direct `@patch` decorators for external dependencies
3. Create simple mock classes for complex objects (MockDatastore, MockUser patterns)
4. Mock time functions for deterministic testing: `@patch('module.time.time', return_value=fixed_value)`

## Cross-Cutting Patterns

### Logging Mock Pattern

When verifying logging calls that differentiate branches, use `with patch(...)` context manager -- NOT `@patch` decorator -- to avoid fixture ordering errors:

```python
# CORRECT: Context manager avoids fixture ordering issues
def test_error_branch_logs_warning():
    with patch('module._log') as mock_log:
        obj.do_something()
    mock_log.warning.assert_called_once_with("Expected message", exc_info=True)

# AVOID: @patch decorator places mock before fixture arguments
@patch('module._log')
def test_error_branch_logs_warning(mock_log, some_fixture):  # fixture not found error
    ...
```

### Timestamp Testing

1. Mock time functions with fixed values -- never use live `time.time()` or `datetime.now()`
2. Test boundary conditions: clearly less, clearly greater, exactly equal
3. Use `time.time()` for timestamps when comparing against framework internals (timezone-safe)

### Exception Testing

1. Create SEPARATE test for each named exception type -- not just generic Exception
2. Assert specific error message/type -- not just status code
3. Verify error propagation -- check that the correct exception reaches the caller
4. Verify COMPLETE error message content -- not just partial substring matches
5. When asserting exception message content, first check the exception class's `__str__`/`__repr__` to understand the actual format. Alternatively, assert against the exception's attributes rather than its string representation.
6. **Exception attribute verification**: Before asserting custom attributes on exception objects (e.g., `exc.timeout`), verify the exception class defines that attribute. Simple `Exception` subclasses store constructor args in `.args` tuple, not as named attributes. Use `exc.args[0]` if no named attribute exists.

### Mock Object Initialization

When creating mock objects for "no change" or "already set" scenarios:
1. Initialize attributes with matching values -- not default None
2. Example: If testing "no change when `primary_method` already equals 'sms'", create mock with `primary_method='sms'`

### Dict Key Removal in Tests

When testing `.get()` behavior on dict-like objects, distinguish between key-absent and key-present-with-None:

```python
# CORRECT: Safe key removal
message.properties.pop('correlation_id', None)

# AVOID: Raises KeyError if key doesn't exist
del message.properties['correlation_id']
```

### Project Config Safety

Do NOT modify project configuration files (`.coveragerc`, `setup.cfg`, `pyproject.toml`, etc.) during test generation. Instead:
1. Use `coverage run --rcfile=NUL -m pytest` as the primary coverage approach (generates `.coverage` in CWD — must be cleaned up after measurement)
2. Use `coverage json -o "$COV_DIR/coverage.json" --rcfile=NUL` to generate the JSON report to a temp directory (see `generation-rules.md` 覆盖率测量与清理 section for temp dir setup)
3. If neither works, create a temporary config in `tests/` subdirectory -- never modify tracked files
4. After measurement, clean up: delete temp directory and remove `.coverage` file from project directory (see `generation-rules.md` 环境清理 section)

### side_effect + return_value Pattern

When a mock needs both tracking (side_effect) and a return value, use a side_effect function that returns the desired value. NEVER set both `return_value` and `side_effect` on the same mock -- `side_effect` takes priority and `return_value` is silently ignored:

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

### Exception Object Identity in Mock Assertions

When verifying mock call arguments that contain exception objects created by `side_effect`, use `isinstance()` and `str()` checks instead of identity (`is`) comparison. Exception objects captured in `except` clauses are the same object, but when comparing mock call args, Python checks object identity which can fail:

```python
# CORRECT: isinstance check for exception type
for call_args in mock_method.call_args_list:
    assert isinstance(call_args[0][2], ValueError)

# AVOID: Identity comparison fails for new exception instances
mock_method.assert_called_once_with(arg1, arg2, expected_exc)  # Fails: different object
```

### While-Loop Generator Mock Safety

When testing generator functions with while loops that depend on internal state mutation (e.g., `threads.discard()`), mock `return_value` alone causes infinite loops because the mock always returns a value but never mutates the loop's termination condition. Use `side_effect` callbacks that mutate the generator's internal state, or use real objects for the loop control mechanism.

```python
# CORRECT: side_effect that terminates the loop
call_count = [0]
def mock_get_with_termination(*args, **kwargs):
    call_count[0] += 1
    if call_count[0] > 3:
        raise StopIteration()  # Terminate the while loop
    return ('message', None)

mock_queue.get.side_effect = mock_get_with_termination

# AVOID: return_value alone causes infinite loop
mock_queue.get.return_value = ('message', None)  # Loop never terminates
```

### Common Pitfalls

- Real network/message-queue/database connections in tests -- always mock
- Framework dependency -- mock framework-managed spawn/schedule primitives (e.g., `spawn`, `asyncio.create_task`, `ThreadPoolExecutor`, `greenlet.spawn`)
- Extension binding with weakref proxies -- use `MagicMock()` for container
- MagicMock auto-creation losing call-order semantics -- use real container or shared tracker
- Patching framework Response/Request classes breaks isinstance checks -- use real Response objects instead
- `patch('module.Class')` for class attributes -- use `patch.object(OwnerClass, 'attr')` instead
- `patch.object` on instance attributes -- assign directly on the instance instead
- Shared class instances -- use direct instance assignment, not PropertyMock on the class
- Real method objects don't support mock attributes -- replace with MagicMock() first
- Self-call with patch.object -- intercepts the initial call; use instance-level assignment instead
