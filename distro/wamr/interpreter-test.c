/* Does the interpreter actually interpret, in the guest?
 *
 * This links libwasmer.a exactly as Edge.js does and runs the smallest module
 * that proves something executed: one exported function adding two i32s. It
 * exists to keep the feedback loop short -- the interpreter is a dependency of
 * a 20-minute interpreter build, and a fault here is far cheaper to find at
 * this level than through JavaScript. */

#include <stdio.h>
#include <string.h>

#include <wasm.h>

/* Written out byte by byte so no toolchain is needed to produce it. */
static const unsigned char kAddModule[] = {
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, /* magic, version 1 */
	0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, /* (i32,i32)->i32 */
	0x03, 0x02, 0x01, 0x00,                               /* function 0 */
	0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, /* export "add" */
	0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
};

int main(void) {
	wasm_engine_t *engine = wasm_engine_new();
	if (engine == NULL) {
		printf("wamr: no engine\n");
		return 1;
	}

	wasm_store_t *store = wasm_store_new(engine);
	if (store == NULL) {
		printf("wamr: no store\n");
		return 1;
	}

	wasm_byte_vec_t binary;
	wasm_byte_vec_new_uninitialized(&binary, sizeof kAddModule);
	memcpy(binary.data, kAddModule, sizeof kAddModule);

	wasm_module_t *module = wasm_module_new(store, &binary);
	wasm_byte_vec_delete(&binary);
	if (module == NULL) {
		printf("wamr: module did not compile\n");
		return 1;
	}

	wasm_extern_vec_t imports = WASM_EMPTY_VEC;
	wasm_instance_t *instance = wasm_instance_new(store, module, &imports, NULL);
	if (instance == NULL) {
		printf("wamr: module did not instantiate\n");
		return 1;
	}

	wasm_extern_vec_t exports;
	wasm_instance_exports(instance, &exports);
	if (exports.size < 1) {
		printf("wamr: no exports\n");
		return 1;
	}

	wasm_func_t *add = wasm_extern_as_func(exports.data[0]);
	if (add == NULL) {
		printf("wamr: export is not a function\n");
		return 1;
	}

	wasm_val_t args[2] = { WASM_I32_VAL(2), WASM_I32_VAL(3) };
	wasm_val_t results[1] = { WASM_INIT_VAL };
	wasm_val_vec_t args_vec = WASM_ARRAY_VEC(args);
	wasm_val_vec_t results_vec = WASM_ARRAY_VEC(results);

	if (wasm_func_call(add, &args_vec, &results_vec) != NULL) {
		printf("wamr: call trapped\n");
		return 1;
	}
	if (results[0].of.i32 != 5) {
		printf("wamr: add(2,3) returned %d\n", results[0].of.i32);
		return 1;
	}

	printf("wamr ok add(2,3)=%d\n", results[0].of.i32);
	return 0;
}
