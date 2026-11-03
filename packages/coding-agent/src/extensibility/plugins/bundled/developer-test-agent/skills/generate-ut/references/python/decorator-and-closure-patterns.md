# Decorator and Closure Patterns for Unit Testing

## Section 1: Decorator-with-Optional-Args

Functions that can be used both as @decorator and @decorator(args) require separate test paths.

### Pattern Recognition
- Function checks callable(first_arg) or isinstance(first_arg, types.FunctionType) to detect bare vs parameterized usage
- Returns functools.partial when called without arguments
- Returns a wrapper function when called with arguments

### Testing Strategy

1. Without-args path: Call decorator directly with a function argument. Verify the returned value is a wrapper (callable), not a partial.
2. With-args path: Call decorator with keyword arguments only. Verify the returned value is functools.partial with correct result.func and result.keywords.
3. Args/kwargs passthrough: For wrapper functions, verify that *args and **kwargs are forwarded to the wrapped function.

### Common Mistakes
- Only testing one path (bare decorator OR parameterized, not both)
- Using isinstance(result, functools.partial) as the only assertion - verify result.func and result.keywords explicitly
- Assuming decorator always returns a wrapper - partial returns need separate verification
- Not testing that the wrapper preserves the original function signature

## Section 2: Closure/Callback Capture

Functions that register callbacks (e.g., gt.link(callback)) create closures that must be captured and tested.

### Pattern Recognition
- Function calls .link(), .connect(), .register(), or similar with a local function or closure
- Uses functools.partial to wrap a method before registering
- Uses weakref.proxy to avoid circular references

### Testing Strategy

1. Callback capture: After calling the target function, extract the registered callback from mock call_args:
   callback = mock_link.call_args[0][0]
   callback()  # Now invoke callback to test closure body

2. functools.partial verification: When the target wraps a method in partial:
   callback = mock_link.call_args[0][0]
   assert isinstance(callback, functools.partial)
   assert callback.func.__name__ == method_name
   assert callback.keywords == expected_kwargs

3. weakref.proxy handling:
   - Do NOT use MagicMock(spec=ClassName) for objects passed to weakref.proxy() - the proxy intercepts __getattr__ and MagicMock auto-attributes conflict
   - Use ClassName.__new__(ClassName) + manual attribute assignment instead
   - When testing proxy-based callbacks, use real objects and verify through the proxy interface

4. Bound method identity: Never use is for bound method arguments from mock.call_args - identity always fails. Use __name__ comparison or assert_called_once_with.

### Common Mistakes
- Mocking the result queue without triggering registered callbacks - the closure body remains untested
- Using assert_called_once() on .link() without verifying the callback argument
- Using is comparison for bound methods captured from call_args
- Using MagicMock(spec=...) for objects that will be wrapped in weakref.proxy()

## Section 3: Contextmanager-Factory

Functions that return context managers (using @contextmanager or manual __enter__/__exit__), especially factories that accumulate args.

### Pattern Recognition
- Function returns an object with __enter__ and __exit__ methods
- Uses @contextlib.contextmanager decorator with yield
- Accumulates arguments across multiple calls before entering the context
- Has guaranteed finally block execution (e.g., logging, cleanup)

### Testing Strategy

1. Context manager protocol verification: Explicitly verify hasattr(result, __enter__) and hasattr(result, __exit__) - do not rely only on with statement usage
2. Args accumulation: For factories that collect args before entering context:
   - Test with no extra args (only duration)
   - Test with one extra arg
   - Test with multiple extra args (verify interpolation)
3. Finally-block execution: Test that cleanup/logging happens even when an exception is raised inside the context
4. Entry/exit behavior: Verify __enter__ returns the expected value and __exit__ handles exceptions correctly

### Common Mistakes
- Only testing the with statement path without verifying __enter__/__exit__ explicitly
- Not testing the finally-block when an exception occurs inside the context
- Assuming context manager always succeeds - test exception propagation
- Not verifying args accumulation order or interpolation format