# Attribute-Access and Lifecycle Testing Patterns

Testing strategies for complex Python patterns that require non-obvious mock strategies or assertion patterns. Consult this file during Step 2 when the target function exhibits any of these patterns.

## 1. Attribute-Access Edge Cases

**When**: The target function accesses attributes through descriptors (`__get__`, `__set__`, `__delete__`), dynamic property lookups, or deprecation-path attribute access.

### Descriptor Property Testing

1. **Per-instance configuration validation**: Create multiple instances with different configuration states. Access the descriptor property on each and assert the return value matches the expected configuration-dependent result.
2. **Class-level access**: Access the descriptor from the class (not an instance) and verify it returns the descriptor itself.
3. **State transition**: Modify the instance configuration between accesses and verify the descriptor return value changes accordingly.
4. **If the descriptor caches results**: Verify that modifying the underlying config does NOT change the cached value until the cache is invalidated.

### Deprecation Path Testing

1. **Verify warning is emitted with `pytest.warns()`**: Use `pytest.warns(DeprecationWarning, match='pattern')` to assert both the warning type and message content.
2. **Verify warning message content with `warnings.catch_warnings(record=True)`**: Inspect caught warnings for category, message text, and line number. Use `warnings.simplefilter('always')` to ensure DeprecationWarning is not suppressed by default filters.
3. **Verify backwards-compatible attribute fallback**: After the deprecation path, assert that both old and new attributes work correctly. Test that the new-API path does NOT emit warnings.
4. **Test both deprecated and new paths**: Ensure the function behaves identically whether the old or new API is used, differing only in the warning emission.

### Common Mistakes

- Only testing one configuration state, missing the conditional return path
- Using MagicMock for the descriptor instead of testing the real `__get__` behavior
- Forgetting to test class-level access (ClassName.prop vs instance.prop)
- Using `pytest.warns()` without verifying the actual behavior
- Using `warnings.filterwarnings('ignore')` which suppresses the warning before it can be tested
- Forgetting `warnings.simplefilter('always')` in catch_warnings context

## 2. Resource-Lifecycle Testing

**When**: The target function implements `__enter__`/`__exit__` that uses semaphore synchronization, callback-based conditional release, or `six.reraise` exception propagation.

### Context Manager Testing

1. **Mock semaphore/Event to avoid blocking**: Never use real `threading.Semaphore`, `threading.Event`, or framework-specific semaphore objects in unit tests. Always mock the acquire/release methods. For Semaphore, prefer `patch.object(Semaphore, 'acquire')` selectively rather than replacing the entire class.
2. **Verify `__enter__` returns self or the expected object**: Assert the return value of `__enter__`.
3. **Test exception propagation with `six.reraise`**: When `__exit__` re-raises exceptions, use `pytest.raises` to verify the original exception propagates. Patch `six.reraise` and verify its arguments if direct re-raise is hard to test.
4. **Test callback-based conditional release**: When `__exit__` conditionally invokes callbacks, test both the success path (callback IS called) and the exception path (callback is NOT called).
5. **Test semaphore release always happens (even on exception)**: This is the resource-safety guarantee. Verify release/`assert_called_once_with` regardless of whether an exception occurred.
6. **For `six.reraise` specifically**: If the function uses `six.reraise(type, value, tb)`, patch `six.reraise` and verify its arguments with `assert_called_once_with`.

### Common Mistakes

- Using real semaphore objects that block test execution — always mock acquire/release
- Not testing the exception path in `__exit__` — only testing the happy path
- Assuming `__exit__` returns True (suppresses exception) when it actually returns False (propagates) or vice versa
- Not verifying that cleanup (semaphore release, callback) happens even when exceptions occur
- Replacing the entire Semaphore class with MagicMock instead of selectively patching individual methods

## 3. While-Loop with Exception-Driven Termination

**When**: The target function uses a `while True` loop that terminates via caught exceptions.

### Testing Strategy

1. **Always use `side_effect` lists** to ensure the loop terminates. A single exception as `side_effect` causes infinite loops.
2. **Verify loop iteration count**: Use `call_count` on mocked methods to verify the expected number of iterations.
3. **Test the termination condition**: Verify the specific exception type that breaks the loop is handled correctly.
4. **Add `--timeout=10` to pytest invocations** as a safety net against infinite loops in tests.

## 4. Generator Function Testing

**When**: The target function is a generator (uses `yield`).

### Testing Strategy

1. **Test one-at-a-time yielding**: Use `next()` to verify individual yield values, not just `list()`.
2. **Also test with `list()`** for complete consumption, but do not rely on it exclusively.
3. **Verify `StopIteration`** after all values are yielded.
4. **If the generator catches exceptions internally**: Use `side_effect` to inject exceptions at specific yield points.
5. **Generator lifecycle**: Remember that the generator body does not execute until `next()` is called. Any assertions about side effects during setup must happen after the first `next()` call.
