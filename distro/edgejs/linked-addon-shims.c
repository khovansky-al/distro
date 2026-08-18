/* What a Rust N-API addon leaves for the linker on this platform.
 *
 * A napi-rs addon compiled for wasm32-unknown-linux-musl names symbols that
 * nothing here defines. None of them are rolldown's doing: they come from the
 * standard library and from napi-rs's own wasm support, so every future linked
 * addon needs exactly these. Compiled and linked from edgejs's preConfigure
 * whenever an addon is linked in.
 *
 * The Rust-side stubs are weak. libunwind.a and libc++abi.a each define an
 * overlapping set of _Unwind_ symbols already, so the link depends on which
 * archive members get pulled; a weak definition loses to any real one rather
 * than colliding with it. */

#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <sys/types.h>

/* napi_status is a C enum, which this ABI passes as a 32-bit integer. Declaring
 * the two handle types locally keeps this file independent of the N-API headers
 * and their include paths. */
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
#define NAPI_OK 0

/* napi-rs compiles this call under `cfg(target_family = "wasm")`, where that
 * means emnapi: the addon is a separate WebAssembly module, so a typed array's
 * bytes live in a different linear memory from the JavaScript ArrayBuffer and
 * have to be copied across whenever either side writes.
 *
 * Here the addon is linked into the interpreter, and edge's
 * napi_create_external_arraybuffer hands QuickJS the caller's pointer rather
 * than a copy. The two views are the same bytes, so there is nothing to
 * synchronise. */
int emnapi_sync_memory(napi_env env,
                       bool js_to_wasm,
                       napi_value arraybuffer_or_view,
                       size_t byte_offset,
                       size_t length) {
	(void)env;
	(void)js_to_wasm;
	(void)arraybuffer_or_view;
	(void)byte_offset;
	(void)length;
	return NAPI_OK;
}

/* musl's port compiles fork() out entirely under `#ifndef __wasm__`; there is
 * no process to duplicate. Rust's standard library names it from std::process
 * whether or not the program ever spawns anything, so the symbol has to exist
 * even though calling it cannot work. */
__attribute__((weak)) pid_t fork(void) {
	errno = ENOSYS;
	return -1;
}

/* std's panic reporting names these three even with backtraces disabled. The
 * Rust toolchain already stubs them for rustc-driven links, which look for them
 * in its own sysroot; a link driven by clang sees only the C sysroot's real
 * libunwind, and that one omits them on wasm. _Unwind_GetIP is deliberately
 * absent here: unlike these three, it does have a real definition to find. */
typedef int _Unwind_Reason_Code;

__attribute__((weak)) _Unwind_Reason_Code
_Unwind_Backtrace(_Unwind_Reason_Code (*fn)(void *, void *), void *arg) {
	(void)fn;
	(void)arg;
	return 5; /* _URC_END_OF_STACK */
}

__attribute__((weak)) unsigned long _Unwind_GetCFA(void *ctx) {
	(void)ctx;
	return 0;
}

__attribute__((weak)) void *_Unwind_FindEnclosingFunction(void *pc) {
	(void)pc;
	return 0;
}
