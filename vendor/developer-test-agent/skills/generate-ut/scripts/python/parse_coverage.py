#!/usr/bin/env python3
"""Parse coverage.json for function-specific coverage validation.

Usage:
    python parse_coverage.py <coverage.json> <function_name> <start_line> <end_line> [source_file_path]

Returns JSON with coverage percentage, executed/missing lines, and pass/fail status.
Pass threshold: 90%. Run from the project directory used to generate coverage.json.
Provide source_file_path when the report covers more than one file.
"""
import json, os, sys

def main():
    if len(sys.argv) < 5:
        print("Usage: python parse_coverage.py <coverage.json> <function_name> <start_line> <end_line> [source_file_path]")
        sys.exit(1)

    cov_path, func_name = sys.argv[1], sys.argv[2]
    start, end = int(sys.argv[3]), int(sys.argv[4])
    src_filter = sys.argv[5] if len(sys.argv) >= 6 else None

    try:
        with open(cov_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(json.dumps({"success": False, "error": str(e), "function": func_name, "pass": False}))
        sys.exit(1)

    # Relative coverage keys refer to the project, not the JSON report's directory.
    def file_identity(file_path):
        return os.path.normcase(os.path.realpath(file_path.replace("\\", os.sep)))

    source_identity = file_identity(src_filter) if src_filter else None
    matches = [
        fd for fp, fd in data.get("files", {}).items()
        if source_identity is None or file_identity(fp) == source_identity
    ]
    if len(matches) != 1:
        reason = "No matching file in coverage report" if not matches else "Ambiguous file in coverage report"
        print(json.dumps({"success": False, "error": reason, "function": func_name, "pass": False}))
        sys.exit(1)
    file_data = matches[0]

    exec_in_func = sorted(l for l in file_data.get("executed_lines", []) if start <= l <= end)
    miss_in_func = sorted(l for l in file_data.get("missing_lines", []) if start <= l <= end)
    total = len(exec_in_func) + len(miss_in_func)
    pct = (len(exec_in_func) / total * 100) if total > 0 else 0.0
    passed = pct >= 90.0

    result = {
        "success": total > 0, "function": func_name, "start_line": start, "end_line": end,
        "source_file_filter": src_filter or "none", "executed_lines": exec_in_func,
        "missing_lines": miss_in_func, "total_executable_lines": total,
        "covered_lines": len(exec_in_func), "coverage_percentage": round(pct, 2),
        "pass": passed, "threshold": 90.0
    }
    if not total:
        result["error"] = "No executable lines for function in coverage report"
    print(json.dumps(result, indent=2))
    if not passed:
        sys.exit(1)

if __name__ == "__main__":
    main()
