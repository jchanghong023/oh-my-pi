# Mock Patching Rules

Detailed mock patching and test generation rules. Consult during Step 3 when writing test code.

## Assertion Quality (Non-trivial assertions — every branch test must include)

- Assert computed values, verify call arguments, check state transitions
- Not sufficient: only checking a function was called, only checking status code, only counting calls, only checking `is not None`
- For dict storage: assert both key existence AND value equality
- For constructor calls: verify arguments via mock or isinstance + attribute checks
- Never use compound `or` assertions where one side is a mock call check — use separate assertions instead
- Never use trivially-satisfied range assertions (`>= 0`, `!= None`) when the expected value is known precisely — assert the exact expected value (with `pytest.approx` for floats)

## Mock Patching Rules

1. **Exception objects in mock assertions**: use `isinstance()` and `str()` checks, not identity (`is`) comparison
2. **Class-level property override**: save original before mutation, restore in finally. Prefer subclass-based override
3. **Framework classes in isinstance checks**: Do not patch framework classes (e.g., Response, Request). Use real objects and verify via attributes instead
4. **Attribute initialization**: Before writing tests that access object attributes, verify the attribute is initialized. If an attribute is only set conditionally, do not assume it exists in tests that skip the setter method
5. **Exception attribute verification**: Before asserting custom attributes on exception objects (e.g., `exc.timeout`), verify the exception class defines that attribute. Simple `Exception` subclasses store constructor args in `.args` tuple, not as named attributes. Use `exc.args[0]` if no named attribute exists
6. **Bound method identity**: Do not use `is` for bound method arguments from `mock.call_args` — bound method identity always fails. Use `__name__` comparison or `assert_called_once_with` on the mock
7. **super() call argument verification**: When asserting super() call arguments via `patch.object`, only verify explicit arguments — `self` is already bound by `super()`. Use `autospec=True` on `patch.object` for parent class methods to prevent argument mismatch
8. **Recursive function caveat**: For recursive functions, prefer behavioral assertions over mock-based verification of internal calls. Patching module-level functions also intercepts recursive invocations. Use `call_count` with expected counts instead of `assert_not_called()`
9. **Primary object under test**: Use `ClassName.__new__(ClassName)` + manual attribute assignment instead of `MagicMock(spec=ClassName)` for the object being tested. MagicMock(spec=...) should only be used for dependencies, not the primary test target
10. **Blocking primitives**: Never use real Event, Queue, or blocking objects in unit tests. Always mock Event.wait() and similar blocking calls to prevent test hangs. Prefer real Event + selective method patching over replacing the entire object with MagicMock
11. **Dict-like attributes on mock objects**: Always initialize dict-like attributes as real empty dicts rather than relying on MagicMock auto-attribute behavior
12. **`__import__` patching**: When patching `__import__`, use `patch("builtins.__import__", ...)` — never `patch("module.__import__", ...)`
13. **Warning/deprecation message assertions**: verify ALL significant substrings including deprecated item name, version string, and recommended alternative. Use exact count == N, not >= 1
14. **Decorator functions**: plan separate tests for with-args and without-args paths. Verify functools.partial return values by checking result.func AND result.keywords/result.args - isinstance-only is insufficient
15. **Closure/callback capture**: when function registers a callback (e.g., `gt.link(cb)`), capture the callback from `mock.call_args[0][0]` and invoke it to test the closure body
16. **weakref.proxy**: do NOT use MagicMock(spec=...) for objects passed to weakref.proxy() - proxy intercepts attribute access and MagicMock auto-attributes conflict. Use real objects or __new__ + manual attributes
17. **Contextmanager-factory**: for functions returning context managers, verify hasattr(result, __enter__) and hasattr(result, __exit__) explicitly, plus test the finally-block execution
18. **Compound `or` with side-effect operations**: Do not use compound `or` with side-effect operations (e.g., `dict.pop(key, None) or default`) — the first branch may raise an exception before the second is evaluated
19. **Mock-style methods on real built-in objects**: When using real dict/list instances, verify state changes (key in/not in) rather than asserting on dict methods like `.pop()`. Only assert on mock methods
20. **Real Event + selective patching**: For objects with interdependent methods (ready/send/wait), prefer real Event with individual method patching over replacing the entire object with MagicMock
21. **Framework registry patching**: Only patch framework registries when testing non-default content types. For default types, use the real registry

## Gotchas (unique insights not covered by Step 2/3 rules)

- **Partial-wrapped callback identity**: When a function wraps callbacks with `functools.partial`, the resulting partial object has different identity from the original. Use `isinstance(cb, functools.partial)` and inspect `cb.func`/`cb.args`/`cb.keywords` for verification, not identity comparison. Source: trace
- **BaseException vs Exception branching**: In frameworks with cooperative concurrency, BaseException subclasses (e.g., GreenletExit) may be caught separately from general Exception — test both branches independently. BaseException suppression means the exception is silently consumed, not re-raised. Source: trace
- **Dict registration value checks**: When functions register objects in a dict (e.g., `self._consumers[provider] = consumer`), assert both key existence AND value identity — `key in dict` alone passes with None or wrong values. Source: trace
- **Mock return_value for tuple-unpacking targets**: When the target function unpacks a mock return value (e.g., `result, exc_info = callback(...)`), always set `return_value` to a matching tuple. Bare `MagicMock()` causes unpacking errors. Source: analyzer
- **Full-file rewrites for minor fixes**: After the initial test file is written, prefer targeted edits for fixes. Only rewrite the full file if structural changes require replacing more than 50% of content. Source: analyzer
- **Over-merging test assertions**: When merging method call verification into branch tests, ensure each behavioral contract remains testable. Over-merging makes it harder to identify specific verifications. Source: analyzer
- **Coverage gate bypass**: If parse_coverage.py reports `pass: false` or `total_executable_lines == 0`, continue iterating — do not finalize below 90%. Source: analyzer
