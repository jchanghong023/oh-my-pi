#!/bin/sh
exec "$OMP_GATE_BUN_BINARY" "$OMP_GATE_COMPILER_SCRIPT" --doctest-compile "$@"
