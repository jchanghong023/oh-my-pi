#!/usr/bin/env python3
"""
Test quality validation script for generate-ut-for-go skill.
Validates mock patterns, observable verification, and test structure.

Usage: python scripts/check-test-quality.py <test_file_path>

Exit codes:
  0: All checks passed
  1: Critical issues found (mock injection missing, boolean flags)
  2: Warning issues found (missing comments, var _ checks incomplete)
  Note: If both errors and warnings exist, returns 1 (errors take priority).
"""

import sys
import re
import os

def check_test_quality(test_file_path):
    """Validate test file quality."""
    
    if not os.path.exists(test_file_path):
        print(f"ERROR: Test file not found: {test_file_path}")
        return 1
    
    with open(test_file_path, 'r', encoding='utf-8') as f:
        content = f.read()
        lines = content.split('\n')
    
    errors = []
    warnings = []
    
    # Check 1: Mock injection presence in tests with dependencies
    # Find all test functions
    test_functions = re.findall(r'func Test(\w+)\(\w+ \*testing\.T\)', content)
    
    # Find mock struct definitions
    mock_structs = re.findall(r'type mock(\w+) struct', content, re.IGNORECASE)
    
    # Find mock injection patterns (L2/2 field assignment)
    injection_patterns = re.findall(r'(\w+)\.\w+ = mock\w+', content)
    
    # L4 fake-server injection patterns (NOT field assignment — recognize as valid injection,
    # e.g. wires srv.Addr() into the client constructor)
    tier0_patterns = re.findall(
        r'net\.Listen\(|httptest\.NewServer\(|httptest\.NewTLSServer\(|'
        r'newFake\w*Server\(|newTest\w*(?:Client|Server)\w*\(|'
        r'\.Addr\(\)|holder\.state\.Store\(|\.state\.Store\(|'
        r'\.Commands\(\)|\.CallCount\(\)|\.WatchCallCount\(\)',
        content
    )
    
    # Check if tests with mocks have injection
    if mock_structs and len(injection_patterns) < len(mock_structs) and not tier0_patterns:
        errors.append(f"CRITICAL: Mock structs defined ({len(mock_structs)}) but injection patterns found ({len(injection_patterns)}) and no L4 fake-server patterns. Possible mock-definition-only gap.")
    elif mock_structs and len(injection_patterns) < len(mock_structs) and tier0_patterns:
        warnings.append(f"WARNING: Mock structs ({len(mock_structs)}) exceed field-injection patterns ({len(injection_patterns)}), but L4 fake-server patterns detected ({len(tier0_patterns)}). Verify the L4 server is wired into the client BEFORE each target call.")
    
    # Check 2: Boolean flags instead of int callCount
    boolean_fields = re.findall(r'(called|used|done|executed|processed)\s+bool', content, re.IGNORECASE)
    if boolean_fields:
        errors.append(f"CRITICAL: Boolean flags found instead of int callCount fields: {boolean_fields}. Use int counters for observable verification.")
    
    # Check 3: var _ Interface checks for mock structs
    var_checks = re.findall(r'var _ \w+ = &mock\w+\{', content, re.IGNORECASE)
    
    if mock_structs and len(var_checks) < len(mock_structs):
        warnings.append(f"WARNING: Mock structs ({len(mock_structs)}) exceed var _ checks ({len(var_checks)}). Add var _ Interface = &mockStruct{{}} for EVERY mock.")
    
    # Check 4: time.Sleep usage (prohibited, EXCEPT Priority 3 legal fallback)
    # Priority 3 allows runtime.Gosched()+time.Sleep(100ms) for uncontrollable private-method goroutines.
    time_sleep = re.findall(r'time\.Sleep\(|time\.After\(', content)
    has_goroutine_launch = bool(re.findall(r'go func\(|go \w+\(', content))
    has_gosched = bool(re.search(r'runtime\.Gosched\(\)', content))
    if time_sleep:
        if has_gosched or has_goroutine_launch:
            warnings.append(f"WARNING: time.Sleep/time.After found ({len(time_sleep)} occurrences) with goroutine/Gosched context. If this is Priority 3 (uncontrollable private-method goroutine), document WHY WaitGroup/context are impossible. Otherwise use sync.WaitGroup.")
        else:
            errors.append(f"CRITICAL: time.Sleep/time.After found ({len(time_sleep)} occurrences) with no goroutine context. Use sync.WaitGroup for goroutine synchronization.")
    
    # Check 5: sync.WaitGroup usage for concurrent tests
    waitgroup_usage = re.findall(r'wg\.Add\(|wg\.Wait\(|sync\.WaitGroup', content)
    
    # Check if there are concurrent test patterns (goroutine launches)
    goroutine_launches = re.findall(r'go func\(', content)
    
    if goroutine_launches and not waitgroup_usage:
        errors.append(f"CRITICAL: Goroutines launched ({len(goroutine_launches)}) but no sync.WaitGroup found. Use WaitGroup for deterministic synchronization.")
    
    # Check 6: Test intent comments above test functions
    test_intent_comments = 0
    for i, line in enumerate(lines):
        if re.match(r'func Test\w+\(\w+ \*testing\.T\)', line):
            # Check if previous line is a comment
            if i > 0 and lines[i-1].strip().startswith('//'):
                test_intent_comments += 1
    
    if test_functions and test_intent_comments < len(test_functions):
        warnings.append(f"WARNING: Test functions ({len(test_functions)}) exceed test intent comments ({test_intent_comments}). Add comment above EVERY test: // TestFunctionName: verifies [behavior] when [condition] (covers line X-Y, branch Z)")
    
    # Check 7: strings.Contains / errors.Is for error verification
    error_checks = re.findall(r'err\s*!=\s*nil', content)
    strings_contains = re.findall(r'strings\.Contains\(err\.Error\(\)', content)
    # errors.Is/errors.As/assert.ErrorIs/assert.ErrorContents are ALSO valid error-content verification
    valid_error_checks = strings_contains + re.findall(
        r'errors\.Is\(|errors\.As\(|assert\.ErrorContains\(|assert\.ErrorIs\(|require\.ErrorIs\(|require\.ErrorContains\(',
        content
    )
    
    if error_checks and len(valid_error_checks) < len(error_checks):
        warnings.append(f"WARNING: err!=nil checks ({len(error_checks)}) exceed error-content checks ({len(valid_error_checks)}: strings.Contains/errors.Is/assert.ErrorIs). Use strings.Contains(err.Error(), 'expected') or errors.Is for observable error verification.")
    
    # Check 8: capturedReq/capturedRes/capturedCtx for field verification
    captured_fields = re.findall(r'captured(Req|Res|Ctx|Args|Reply|Data)', content, re.IGNORECASE)
    
    # Check if mocks have captured fields for parameter verification
    if mock_structs and not captured_fields:
        warnings.append("WARNING: No capturedReq/capturedRes/capturedCtx fields found. Add captured fields for observable parameter verification.")
    
    # Check 9: Placeholder tests (TODO without implementation)
    todo_placeholders = re.findall(r'// TODO:|t\.Skip\("not implemented"\)', content)
    
    if todo_placeholders:
        errors.append(f"CRITICAL: Placeholder tests found ({len(todo_placeholders)}). Every test must contain actual target call.")
    
    # Check 10: Function uses mutex - concurrent test required
    mutex_usage = re.findall(r'\.mu\.Lock\(|\.mu\.RLock\(|sync\.Mutex|sync\.RWMutex', content)
    
    # Check if there's a concurrent test
    concurrent_test = re.search(r'Test\w+Concurrent|Test\w+Race|Test\w+Mutex', content, re.IGNORECASE)
    
    # This check is heuristic - we check target file for mutex, not test file
    # But if test file has WaitGroup patterns, likely concurrent test exists
    # NOTE: fake protocol servers (L4) legitimately use sync.Mutex for thread-safe
    # CallCount/Commands — that mutex belongs to the TEST HELPER, not the target function.
    # Skip this warning when L4 fake-server patterns are present.
    if mutex_usage and not concurrent_test and not waitgroup_usage and not tier0_patterns:
        warnings.append("WARNING: Target function may use mutex. Concurrent safety test with sync.WaitGroup should be generated.")
    
    # Check 11: Real infrastructure connections in unit tests (CRITICAL)
    # Detect factory functions that create real connections to external infrastructure
    infra_connection_patterns = re.findall(
        r'New\w*Client\(|New\w*Server\(|sql\.Open\(|net\.Dial\(|http\.Client\{',
        content
    )
    
    # Determine if this is an integration test file (has build tag)
    is_integration_file = re.search(r'//go:build integration|// +build integration', content)
    
    if infra_connection_patterns and not is_integration_file:
        errors.append(
            f"CRITICAL: Real external service connections found in unit test file ({len(infra_connection_patterns)} occurrences): "
            f"NewXxxClient/sql.Open/net.Dial/http.Client. "
            f"Unit tests MUST use L4 fake server (net.Listen) / L1-L3 mocks instead of real connections. "
            f"Local fake server (net.Listen 127.0.0.1:0) is ALLOWED — only real external services are forbidden. "
            f"If real infrastructure is required, move tests to *_integration_test.go with //go:build integration tag."
        )
    
    # Check 12: t.Skip guarding infrastructure dependencies (CRITICAL)
    # Detect t.Skip patterns that guard infrastructure availability
    skip_infra_patterns = re.findall(
        r't\.Skipf?\([^)]*(?:not available|infrastructure not available|server not available|database not available|service not available)',
        content, re.IGNORECASE
    )
    
    # Also detect: create connection + ping + skip on error pattern
    ping_skip_pattern = re.findall(
        r'\.Ping\(ctx\)\.Err\(\);\s*err[^;]*t\.Skip',
        content
    )
    
    if (skip_infra_patterns or ping_skip_pattern) and not is_integration_file:
        errors.append(
            f"CRITICAL: t.Skip guarding infrastructure dependencies in unit test "
            f"(skip_infra={len(skip_infra_patterns)}, ping_skip={len(ping_skip_pattern)}). "
            f"This indicates the test requires real infrastructure and is NOT a unit test. "
            f"Either rewrite using gomonkey patches, or move to *_integration_test.go with //go:build integration tag. "
            f"See SKILL.md Gotchas."
        )
    
    # Check 13: Target function retreat pattern (CRITICAL)
    # Detect if the majority of tests exercise helper/pure functions instead of the target function
    # The script needs to know the target function name — extract from test file name or comments
    # Strategy: find test intent comments and check which function they reference
    
    # Extract target function name from test intent comments or test function names
    # Pattern: "TestFunctionName: verifies [behavior]" or func TestFunctionName_Xxx
    # The common prefix across all test names often indicates the target function
    test_name_prefixes = re.findall(r'func Test(\w+?)(?:_|$)', content)
    
    # Group by common prefix (the target function name)
    prefix_counts = {}
    for prefix in test_name_prefixes:
        # Find the longest common prefix that appears in multiple test names
        for length in range(len(prefix), 2, -1):
            candidate = prefix[:length]
            if candidate not in prefix_counts:
                prefix_counts[candidate] = 0
            prefix_counts[candidate] += 1
    
    # Find the most common prefix (likely the target function)
    if prefix_counts:
        target_prefix = max(prefix_counts, key=prefix_counts.get)
        target_call_count = prefix_counts.get(target_prefix, 0)
        total_tests = len(test_functions)
        
        # Check if tests that reference the target function actually call it
        # Look for direct calls to the target function in test bodies
        # Pattern: sf.targetMethod( or TargetMethod( or targetFunc(
        escaped_prefix = re.escape(target_prefix)
        escaped_lower = re.escape(target_prefix.lower())
        target_call_patterns = re.findall(
            rf'\b{escaped_lower}\b\s*\(|\b{escaped_prefix}\b\s*\(|\.\b{escaped_lower}\b\s*\(|\.\b{escaped_prefix}\b\s*\(',
            content, re.IGNORECASE
        )
        # Split camelCase prefix to also match the actual method name
        # (e.g. "MyHandlerFunc" -> "Handler", since tests call c.Handler(...) not c.MyHandlerFunc(...))
        camel_parts = re.findall(r'[A-Z][a-z]+|[A-Z]+(?=[A-Z]|$)|\d+', target_prefix)
        method_candidates = {target_prefix} | (set(camel_parts) if camel_parts else set())
        method_candidates = {c for c in method_candidates if len(c) >= 3}
        for cand in method_candidates:
            if cand != target_prefix:
                escaped_cand = re.escape(cand)
                target_call_patterns += re.findall(rf'\.{escaped_cand}\s*\(|\b{escaped_cand}\s*\(', content, re.IGNORECASE)
        
        # Also check for pure helper function calls that dominate
        # Common pattern: parseTarget( calls outnumber targetMethod( calls
        pure_func_calls = re.findall(r'parse\w+\s*\(|validate\w+\s*\(|format\w+\s*\(|calculate\w+\s*\(|compute\w+\s*\(', content)
        
        has_any_method_call = bool(re.findall(r'\.\w+\s*\(', content))
        if total_tests > 0 and len(target_call_patterns) < total_tests * 0.5:
            if tier0_patterns or has_any_method_call:
                warnings.append(
                    f"WARNING: Target function call heuristic detected '{target_prefix}' called in {len(target_call_patterns)} places "
                    f"across {total_tests} tests, but L4 fake-server patterns ({len(tier0_patterns)}) or method calls exist — "
                    f"heuristic likely mis-guessed the target name. "
                    f"Manually verify at least 50% of tests call the real target function."
                )
            else:
                errors.append(
                    f"CRITICAL: Target function retreat pattern detected. "
                    f"Target function '{target_prefix}' is called in only {len(target_call_patterns)} places, "
                    f"but there are {total_tests} test functions and NO L4 patterns / method calls found. "
                    f"At least 50% of tests MUST call the target function. "
                    f"Pure helper function calls ({len(pure_func_calls)} found) should be SUPPLEMENTARY, not PRIMARY. "
                )
    
    # Check 14: gomonkey supplementation reason comment [ERROR level - returns exit code 1]
    # CRITICAL for coverage-driven framework selection
    # Every test function using gomonkey.ApplyMethod/ApplyFunc must have a
    # "// Supplementation reason:" comment explaining why baseline framework was insufficient
    
    # Pre-compute test function line ranges for analysis
    test_func_ranges = []
    for i, line in enumerate(lines):
        if re.match(r'func Test\w+\(\w+ \*testing\.T\)', line):
            start = i
            end = start + 1
            while end < len(lines) and not (end > start and re.match(r'^func ', lines[end])):
                end += 1
            test_func_ranges.append((start, end, line))
    
    gomonkey_import = bool(re.search(r'"github.com/agiledragon/gomonkey"', content))
    
    if gomonkey_import:
        gomonkey_tests_without_reason = []
        for start, end, func_line in test_func_ranges:
            func_body = '\n'.join(lines[start:end])
            if re.search(r'gomonkey\.ApplyMethod\(|gomonkey\.ApplyFunc\(', func_body):
                # Check for supplementation reason comment in the function body or 3 lines above
                comment_area = '\n'.join(lines[max(0, start - 3):end])
                if not re.search(r'Supplementation reason:', comment_area, re.IGNORECASE):
                    func_name_match = re.search(r'func (Test\w+)', func_line)
                    func_name = func_name_match.group(1) if func_name_match else "unknown"
                    gomonkey_tests_without_reason.append(func_name)
        
        if gomonkey_tests_without_reason:
            errors.append(
                f"CRITICAL: gomonkey used in {len(gomonkey_tests_without_reason)} test function(s) "
                f"without 'Supplementation reason:' comment: {gomonkey_tests_without_reason}. "
                f"Every gomonkey usage MUST document why baseline framework was insufficient. "
                f"Format: // Supplementation reason: baseline framework [X] cannot [Y]; gomonkey needed."
            )
    
    # Check 15: Framework pollution — mixed mock frameworks without justification (CRITICAL)
    # If file imports both gomonkey and testify/mock (or gomock), all gomonkey
    # usage must have supplementation reason, and no test function may mix two mechanisms
    
    other_mock_imports = re.findall(
        r'"github.com/stretchr/testify/mock"|"go.uber.org/mock"|"github.com/golang/mock"',
        content
    )
    
    if gomonkey_import and other_mock_imports:
        supp_comments = re.findall(r'Supplementation reason:', content, re.IGNORECASE)
        if not supp_comments:
            errors.append(
                f"CRITICAL: Framework pollution detected. File imports both gomonkey and "
                f"other mock framework(s) {other_mock_imports} but has ZERO 'Supplementation reason:' comments. "
                f"gomonkey MUST be introduced ONLY for branches where baseline framework cannot reach >=90% coverage. "
                f"See SKILL.md Gotchas."
            )
        
        # Check: same test function mixing gomonkey + other mock mechanism
        for start, end, func_line in test_func_ranges:
            func_body = '\n'.join(lines[start:end])
            has_gomonkey = re.search(r'gomonkey\.ApplyMethod\(|gomonkey\.ApplyFunc\(', func_body)
            has_other_mock = re.search(r'\.EXPECT\(|gomock\.NewController\(|mock\.Mock', func_body)
            if has_gomonkey and has_other_mock:
                func_name_match = re.search(r'func (Test\w+)', func_line)
                func_name = func_name_match.group(1) if func_name_match else "unknown"
                errors.append(
                    f"CRITICAL: Test function '{func_name}' mixes gomonkey with another mock framework. "
                    f"Same test function must NOT mix two mock mechanisms. "
                    f"If gomonkey is needed for one anchor, use gomonkey for all mocks in that function."
                )
    
    # Check 16: gomonkey stubbing a network method's error [WARNING level - returns exit code 2]
    # POTENTIAL false coverage - requires manual confirmation
    # Per the two-condition test: false coverage for the TARGET function occurs IFF
    # (a) the routing predicate (errorTypeCheck/shouldRetry/...) is in the TARGET function body, AND
    # (b) the error comes from a gomonkey stub errors.New bypassing the protocol parser.
    # If the routing predicate lives in a DOWNSTREAM private method, this is NOT false coverage
    # for the target function (Step 3 boundary rule) — so this is a WARNING requiring manual
    # confirmation, not a hard error.
    # LIMITATION: The regex [^}]*? does not handle nested braces in gomonkey closures.
    # Complex nested code blocks may cause false negatives. This is acceptable as a heuristic
    # check — manual review is already required for flagged cases.
    if gomonkey_import:
        NETWORK_METHODS = r'Connect|Dial|Query|Exec|Do|Request|Call|Execute|Process|Send|Fetch'
        # gomonkey patch on a network method that returns errors.New
        gomonkey_network_stub = re.findall(
            rf'gomonkey\.Apply(?:Method|Func)[^}}]*?(?:{NETWORK_METHODS})[^}}]*?errors\.New\(',
            content
        )
        # gomonkey patch whose body mentions redirect/retry keywords (common protocol error indicators)
        gomonkey_stub_redirect = re.findall(
            rf'gomonkey\.Apply(?:Method|Func)[^}}]*?(?:redirect|retry|retryable|unavailable|busy)',
            content, re.IGNORECASE
        )
        if gomonkey_network_stub or gomonkey_stub_redirect:
            warnings.append(
                f"WARNING: gomonkey appears to stub a network method's error "
                f"(network_stub={len(gomonkey_network_stub)}, redirect_stub={len(gomonkey_stub_redirect)}). "
                f"Apply the TWO-CONDITION test: false coverage for the TARGET function occurs ONLY IF "
                f"(a) the routing predicate (errorTypeCheck/shouldRetry/...) is in the TARGET function body itself, AND "
                f"(b) the error comes from this gomonkey stub. If the routing predicate lives in a DOWNSTREAM private "
                f"method, this is NOT false coverage for the target (Step 3 boundary rule) — lighter tiers are valid. "
                f"If condition (a) holds, replace with a L4 fake server returning the raw protocol error frame. "
                f"See references/mock-tier-guide.md (L4 Completeness Check)."
            )
        # Duplicate check removed — merged into single block above

    # Check 17: network-client test using gomonkey — coverage-driven reminder (NOT a tier mandate)
    # Per coverage-driven tier selection, network-client functions do NOT automatically
    # require L4. L4 is escalated ONLY for target-body routing-predicate gaps.
    # This check is informational only — no warning unless Check 16 already
    # flagged a potential false-coverage stub.
    is_network_client_test = bool(re.search(r'Client|Server|sql\.Open|net\.Dial|http\.', content))
    has_tier0 = bool(tier0_patterns)
    if is_network_client_test and not has_tier0 and not is_integration_file and gomonkey_import:
        # Informational only — coverage-driven selection means L4 is optional unless
        # Check 16 flagged a target-body routing-predicate stub. Suppress to avoid false alarms
        # on legitimate L1/L2 strategies (e.g., processBatch via failingDependency).
        pass

    # Check 18: Validation probe tests MUST be deleted from deliverable file
    # Probe tests are temporary validation scaffolds — they MUST be
    # deleted after validation. Only header comments should remain as audit trail.
    probe_patterns = re.findall(
        r'func\s+(TestGomonkeyProbe|TestProbeTierValidation|TestProbeDependency'
        r'|TestProbe\w*|TestGomonkey\w*|Test\w*DryRun\w*)\s*\(',
        content
    )
    if probe_patterns:
        errors.append(
            f"Validation probe tests found in deliverable file: {', '.join(probe_patterns)}. "
            f"These are temporary validation scaffolds (Step 1.1/1.2/1.3) — they MUST be DELETED "
            f"after validation. Keep only header comments (e.g. '// gomonkey: L5 available') as audit trail."
        )

    # Print results
    print("=" * 80)
    print("TEST QUALITY VALIDATION RESULTS")
    print("=" * 80)
    
    if errors:
        print("\nCRITICAL ERRORS (must fix):")
        for error in errors:
            print(f"  ❌ {error}")
    
    if warnings:
        print("\nWARNINGS (should fix):")
        for warning in warnings:
            print(f"  ⚠️  {warning}")
    
    if not errors and not warnings:
        print("\n✅ OK - Test file passes all quality checks")
        print(f"  - Test functions: {len(test_functions)}")
        print(f"  - Mock structs: {len(mock_structs)}")
        print(f"  - Mock injections: {len(injection_patterns)}")
        print(f"  - var _ checks: {len(var_checks)}")
        print(f"  - WaitGroup usage: {len(waitgroup_usage)}")
        print(f"  - Test intent comments: {test_intent_comments}")
        print(f"  - strings.Contains checks: {len(strings_contains)}")
        return 0
    
    print("\n" + "=" * 80)
    print("FIX INSTRUCTIONS:")
    print("=" * 80)
    
    if "Boolean flags" in str(errors):
        print("- Replace boolean flags with int callCount fields:")
        print("  type mockPlugin struct { callCount int }")
        print("  func (m *mockPlugin) Method() { m.callCount++ }")
        print("  assert.Equal(t, 1, mock.callCount)")
    
    if "time.Sleep" in str(errors):
        print("- Replace time.Sleep with sync.WaitGroup:")
        print("  var wg sync.WaitGroup")
        print("  wg.Add(1)")
        print("  go func() { defer wg.Done(); target.Function() }()")
        print("  wg.Wait()")
    
    if "mock-definition-only" in str(errors):
        print("- Add mock injection BEFORE target call:")
        print("  target.Dependency = mockDep")
        print("  target.Function(ctx, req)")
    
    if "Placeholder tests" in str(errors):
        print("- Replace TODO placeholders with actual test implementation:")
        print("  Every test must contain target call with mock injection and assertions")
    
    if "var _ checks" in str(warnings):
        print("- Add var _ Interface check after each mock struct:")
        print("  var _ InterfaceName = &mockStruct{}")
    
    if "test intent comments" in str(warnings):
        print("- Add comment above each test function:")
        print("  // TestFunctionName: verifies [behavior] when [condition] (covers line X-Y, branch Z)")
    
    if "infrastructure connections" in str(errors) or "external service" in str(errors):
        print("- Replace real external service connections with L4 fake server or mocks:")
        print("  WRONG: client := NewXxxClient(&Options{Addr: '127.0.0.1:XXXXX'})")
        print("  CORRECT (L4): srv := newFakeTestServer(t) + wire client to srv.Addr()")
        print("  CORRECT (L1-L3): target := &TargetType{} + struct field injection / pre-constructed state")
        print("  NOTE: Local fake server (net.Listen 127.0.0.1:0) is ALLOWED — only real external services are forbidden")
        print("  OR move to *_integration_test.go with //go:build integration tag")
    
    if "t.Skip guarding" in str(errors):
        print("- Remove t.Skip infrastructure guards and rewrite as proper unit tests:")
        print("  WRONG: if err := client.Ping(ctx).Err(); err != nil { t.Skip('service not available') }")
        print("  CORRECT: Use gomonkey patches to control infrastructure behavior without real connections")
        print("  See SKILL.md Gotchas for detailed recovery steps")
    
    if "retreat pattern" in str(errors):
        print("- Target function must be the PRIMARY test subject (at least 50% of tests call it):")
        print("  WRONG: Only testing parseXxx because targetXxx is 'too complex to mock'")
        print("  CORRECT: Apply gomonkey Instability Fallback Strategy to test the target:")
        print("    1. Struct field injection (sf.onCall = mockFunc)")
        print("    2. Lightweight fake struct (&TargetType{Base: &BaseType{}})")
        print("    3. Test boundary narrowing (patch helperMethod to return error)")
        print("  Pure helper function tests are SUPPLEMENTARY, not PRIMARY")
        print("  See SKILL.md Gotchas for detailed recovery steps")
    
    if "Validation probe tests" in str(errors):
        print("- DELETE all validation probe tests from the deliverable file:")
        print("  TestGomonkeyProbe, TestProbeTierValidation, TestProbeDependency, Test*DryRun*")
        print("  These are temporary scaffolds (Step 1.1/1.2/1.3) — NOT deliverable tests")
        print("  Keep only header comments as audit trail, e.g.:")
        print("  // gomonkey: L5 available (TestGomonkeyProbe passed)")
        print("  // Probe: Fx->Lx validated (TestProbeTierValidation passed)")
    
    if errors:
        return 1
    elif warnings:
        return 2
    else:
        return 0

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/check-test-quality.py <test_file_path>")
        sys.exit(1)
    
    test_file_path = sys.argv[1]
    exit_code = check_test_quality(test_file_path)
    sys.exit(exit_code)
