# Bundled Opus defaults to /MD even when cmake-rs passes /MT for Rust's
# crt-static target feature. Keep its runtime choice aligned with Rust.
set(OPUS_STATIC_RUNTIME OFF CACHE BOOL "Match Rust's CRT linkage" FORCE)
if("$ENV{CARGO_CFG_TARGET_FEATURE}" MATCHES "(^|,)crt-static(,|$)")
  set(OPUS_STATIC_RUNTIME ON CACHE BOOL "Match Rust's CRT linkage" FORCE)
endif()
