# A wasm_c_api provider for the guest, built from wasm-micro-runtime.
#
# Edge.js's `WebAssembly` global is written against the standard wasm_c_api and
# needs nothing Wasmer-specific, so any implementation of that API will do. It
# has to be an interpreter: a WebAssembly guest cannot generate and execute
# machine code, which rules out every compiling engine including Wasmer.
#
# The output deliberately imitates a Wasmer distribution -- include/wasm.h,
# include/wasmer.h, lib/libwasmer.a -- because that is the layout Edge.js's
# EDGE_QUICKJS_WASMER_DIST_ROOT looks for. See distro/edgejs/package.nix.
cmake_minimum_required(VERSION 3.14)
project(wamr_wasm_c_api C)

set(WAMR_BUILD_PLATFORM "linux")

# This target is 32-bit with no floating point registers in its calling
# convention, which is the same reason the Rust crates in distro/rolldown reuse
# riscv32. For an interpreter the choice only settles pointer width and a few
# ABI assumptions.
set(WAMR_BUILD_TARGET "RISCV32_ILP32")

# Portable C instead of per-architecture assembly, of which there is none for
# wasm32. This is checked before any target-specific branch.
set(WAMR_BUILD_INVOKE_NATIVE_GENERAL 1)

# The classic interpreter reaches for computed goto whenever the compiler
# defines __GNUC__, which clang does. WebAssembly has no indirect branch, so
# LLVM cannot lower `goto *label` and the interpreter loop traps the moment it
# dispatches an instruction -- a `RuntimeError: unreachable` out of the guest.
# A plain switch is the portable dispatch and is what this target needs.
add_definitions(-DWASM_ENABLE_LABELS_AS_VALUES=0)

set(WAMR_BUILD_INTERP 1)
set(WAMR_BUILD_FAST_INTERP 0)
set(WAMR_BUILD_AOT 0)
set(WAMR_BUILD_JIT 0)
set(WAMR_BUILD_LAZY_JIT 0)

# The C API is the whole point of this build.
set(WAMR_BUILD_LIB_WASM_C_API 1)

# A wasm_c_api host may grow an exported memory even when the module contains
# no memory.grow opcode. Preserve the module's declared maximum so that host
# growth remains possible; the default loader otherwise collapses it to the
# initial size as an interpreter-only optimization.
add_definitions(-DWASM_ENABLE_HOST_MEMORY_GROW=1)

# No WASI and no builtin libc: the modules this runs are self-contained. The
# one it exists for, es-module-lexer's, imports nothing at all.
set(WAMR_BUILD_LIBC_BUILTIN 0)
set(WAMR_BUILD_LIBC_WASI 0)
set(WAMR_BUILD_LIB_PTHREAD 0)
set(WAMR_BUILD_MULTI_MODULE 0)

# Bounds checks in software. The hardware kind installs a signal handler and
# maps guard pages, and this platform has no mmap.
set(WAMR_DISABLE_HW_BOUND_CHECK 1)
set(WAMR_DISABLE_STACK_HW_BOUND_CHECK 1)

set(WAMR_BUILD_BULK_MEMORY 1)
set(WAMR_BUILD_REF_TYPES 1)
set(WAMR_BUILD_SIMD 0)

include(${WAMR_ROOT_DIR}/build-scripts/runtime_lib.cmake)

add_library(wasmer STATIC ${WAMR_RUNTIME_LIB_SOURCE})
set_target_properties(wasmer PROPERTIES OUTPUT_NAME wasmer)

install(TARGETS wasmer ARCHIVE DESTINATION lib)
install(FILES ${WAMR_ROOT_DIR}/core/iwasm/include/wasm_c_api.h
        DESTINATION include RENAME wasm.h)
