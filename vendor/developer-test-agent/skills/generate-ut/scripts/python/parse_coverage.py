#!/usr/bin/env python3
"""Check one source file's module, function-range, or changed-line coverage."""

import argparse
import json
import os
import sys


def file_identity(file_path):
    # Relative coverage keys refer to the project, not the JSON report's directory.
    return os.path.normcase(os.path.realpath(file_path.replace("\\", os.sep)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("coverage_json")
    parser.add_argument("--source", required=True)
    parser.add_argument("--threshold", type=float, default=90)
    scopes = parser.add_mutually_exclusive_group()
    scopes.add_argument("--function", nargs=3, metavar=("NAME", "START", "END"))
    scopes.add_argument("--changed-lines", type=json.loads, default=argparse.SUPPRESS, metavar="JSON_ARRAY")
    args = parser.parse_args()

    if not 0 <= args.threshold <= 100:
        parser.error("--threshold must be between 0 and 100")

    result = {"source_file": args.source, "threshold": args.threshold, "scope": "module"}
    if args.function:
        name, start, end = args.function
        try:
            start, end = int(start), int(end)
        except ValueError:
            parser.error("--function requires integer start and end lines")
        if not 1 <= start <= end:
            parser.error("--function requires 1 <= START <= END")
        result.update(scope="function", function=name, start_line=start, end_line=end)
    elif hasattr(args, "changed_lines"):
        if not isinstance(args.changed_lines, list) or any(
            type(line) is not int or line < 1 for line in args.changed_lines
        ):
            parser.error("--changed-lines requires a JSON array of positive integers")
        changed_lines = set(args.changed_lines)
        result["scope"] = "incremental"

    try:
        with open(args.coverage_json, "r", encoding="utf-8") as report:
            data = json.load(report)
    except (OSError, ValueError) as error:
        result.update(success=False, error=str(error))
        result["pass"] = False
        print(json.dumps(result))
        return 1

    source_identity = file_identity(args.source)
    matches = [
        record for file_path, record in data.get("files", {}).items()
        if file_identity(file_path) == source_identity
    ]
    if len(matches) != 1:
        reason = "Ambiguous file in coverage report" if matches else "No matching file in coverage report"
        result.update(success=False, error=reason)
        result["pass"] = False
        print(json.dumps(result))
        return 1

    executed = set(matches[0]["executed_lines"])
    missing = set(matches[0]["missing_lines"])
    if args.function:
        executed = {line for line in executed if start <= line <= end}
        missing = {line for line in missing if start <= line <= end}
    elif result["scope"] == "incremental":
        executed.intersection_update(changed_lines)
        missing.intersection_update(changed_lines)

    covered = len(executed)
    total = covered + len(missing)
    passed = bool(total and covered * 100 >= args.threshold * total)
    result.update(
        success=total > 0,
        executed_lines=sorted(executed),
        missing_lines=sorted(missing),
        total_executable_lines=total,
        covered_lines=covered,
        coverage_percentage=round(covered * 100 / total, 2) if total else None,
    )
    result["pass"] = passed
    if not total:
        result["error"] = "No executable lines in the requested coverage scope"
    print(json.dumps(result, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
