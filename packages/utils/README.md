# @oh-my-pi/pi-utils

Shared utilities for [omp](https://github.com/can1357/oh-my-pi) packages. Zero ceremony, Bun-first.

## Notable modules

| Module                                                                                                             | Purpose                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `logger`                                                                                                           | Centralized logger writing to `~/.omp/logs/` (`bun test`: temp dir), rotating, never stdout  |
| `prompt`                                                                                                           | Handlebars-based prompt templating and formatting helpers                                    |
| `dirs`                                                                                                             | Path helpers for omp config directories (`~/.omp`, XDG-aware on Linux)                       |
| `stream`                                                                                                           | `readStream` / `readLines` helpers over `ReadableStream`                                     |
| `ptree` / `procmgr`                                                                                                | Process trees, `ChildProcess` wrapper, process lifecycle management                          |
| `postmortem`                                                                                                       | Cleanup callbacks on exit, signals, and fatal exceptions                                     |
| `which`                                                                                                            | `$which()` binary lookup with caching                                                        |
| `fetch-retry`                                                                                                      | `fetch` with retry/backoff policies                                                          |
| `fs-error`                                                                                                         | Errno guards (`isEnoent` and friends)                                                        |
| `env` / `worker-host`                                                                                              | Environment plumbing and side-effect-free worker-host entry contract (`workerHostEntry`)     |
| `abortable` / `async`                                                                                              | AbortSignal-aware stream/promise helpers                                                     |
| `math-delimiters`                                                                                                  | LaTeX span/block delimiter grammar (offsets only) shared by the TUI and collab-web renderers |
| `peek-file`                                                                                                        | Read the first N bytes of a file with pooled buffers                                         |
| `frontmatter`, `glob`, `mime`, `temp`, `format`, `color`, `snowflake`, `tab-spacing`, `path-tree`, `sanitize-text` | Smaller single-purpose helpers                                                               |

Import from the root barrel or per-module subpaths (`@oh-my-pi/pi-utils/<module>`).

## Logging

Runtime diagnostics use the existing `logger` (`@oh-my-pi/pi-utils/logger`), not console output or session transcripts. The [fork logging contract](../../docs-zh-CN/requirements/fork.md#运行诊断日志) is authoritative for diagnostic coverage.

Logs are JSON records with millisecond timestamps and PID in `getLogsDir()/omp.<local-date>.<pid>.log`. The directory follows the current data root, profile and applicable Linux XDG state directory; `OMP_CONFIG_ROOT` relocates it. Existing daily/size rotation remains in effect (10 MiB per file, `maxFiles: 5`, five-day stale-process retention). `OMP_LOG_LEVEL` accepts `error`, `warn`, `info`, `debug` (default: all levels).

An unavailable primary destination falls back to `%LOCALAPPDATA%/omp/Logs` on Windows or `$XDG_STATE_HOME/omp/logs` (default `~/.local/state/omp/logs`) on Linux. When that would reuse the failed primary, `~/.omp/fallback-logs` is tried instead. The fallback event and CLI startup record identify the actual log path; failure of both destinations produces one bounded stderr warning without changing the business result.

Key operations log their start, final outcome, stage, elapsed time and bounded result summary. Use `withLogContext()` to carry an `operation_id` and existing request/session/job/goal/tool-call identifiers through asynchronous work. INFO covers lifecycle/results, WARN recoverable anomalies, ERROR failed operations, and DEBUG optional detail; cancellation is not an error.

Use `diagnosticError()` for safe error classification/stack frames and `diagnosticUrl()` for endpoint scheme, host, port and a stable `path_hash`; URL credentials, raw paths, query parameters and fragments are never included. Never log credentials, user content, request/response bodies, source text or unbounded process output. Logging failures must not change business results.

## Install

```sh
bun add @oh-my-pi/pi-utils
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.3.14.

## References

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [CHANGELOG](./CHANGELOG.md)
