#!/usr/bin/env python3
"""Parse coverage.json for function-specific coverage validation.

Usage:
    python parse_coverage.py <coverage.json> <function_name> <start_line> <end_line> [source_file_path]

Returns JSON with coverage percentage, executed/missing lines, and pass/fail status.
Pass threshold: 90%. Always provide source_file_path to prevent cross-file contamination.
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

    executed, missing = [], []
    for fp, fd in data.get("files", {}).items():
        # Path-segment matching: compare tail segments to avoid cross-file contamination
        if src_filter:
            fp_norm = os.path.normcase(os.path.normpath(fp).replace("\\", "/"))
            sf_norm = os.path.normcase(os.path.normpath(src_filter).replace("\\", "/"))
            fp_parts = [p for p in fp_norm.split("/") if p]
            sf_parts = [p for p in sf_norm.split("/") if p]
            if len(sf_parts) > len(fp_parts):
                continue
            if fp_parts[-len(sf_parts):] != sf_parts:
                continue
        executed.extend(fd.get("executed_lines", []))
        missing.extend(fd.get("missing_lines", []))

    exec_in_func = sorted(l for l in executed if start <= l <= end)
    miss_in_func = sorted(l for l in missing if start <= l <= end)
    total = len(exec_in_func) + len(miss_in_func)
    pct = (len(exec_in_func) / total * 100) if total > 0 else 100.0
    passed = pct >= 90.0

    result = {
        "success": True, "function": func_name, "start_line": start, "end_line": end,
        "source_file_filter": src_filter or "none", "executed_lines": exec_in_func,
        "missing_lines": miss_in_func, "total_executable_lines": total,
        "covered_lines": len(exec_in_func), "coverage_percentage": round(pct, 2),
        "pass": passed, "threshold": 90.0
    }
    print(json.dumps(result, indent=2))
    if not passed:
        sys.exit(1)

if __name__ == "__main__":
    main()
