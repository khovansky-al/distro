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

static const unsigned char kMemoryModule[] = {
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, /* magic, version 1 */
	0x05, 0x04, 0x01, 0x01, 0x01, 0x03,             /* memory 1..3 pages */
	0x07, 0x0a, 0x01, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
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

	/* A host-created global is not backed by an instantiated module. The C API
	 * must still preserve its initial value and subsequent writes. This is the
	 * path WebAssembly.Global in Edge.js takes. */
	wasm_valtype_t *content = wasm_valtype_new(WASM_I32);
	wasm_globaltype_t *global_type = wasm_globaltype_new(content, WASM_VAR);
	wasm_val_t initial = WASM_I32_VAL(7);
	wasm_global_t *global = wasm_global_new(store, global_type, &initial);
	wasm_globaltype_delete(global_type);
	if (global == NULL) {
		printf("wamr: global did not create\n");
		return 1;
	}

	wasm_val_t value = WASM_INIT_VAL;
	wasm_global_get(global, &value);
	if (value.kind != WASM_I32 || value.of.i32 != 7) {
		printf("wamr: initial global value was %d\n", value.of.i32);
		return 1;
	}
	wasm_val_t changed = WASM_I32_VAL(11);
	wasm_global_set(global, &changed);
	wasm_global_get(global, &value);
	if (value.kind != WASM_I32 || value.of.i32 != 11) {
		printf("wamr: updated global value was %d\n", value.of.i32);
		return 1;
	}
	wasm_global_delete(global);

	/* Emscripten grows its heap from JavaScript. The C API used to reject
	 * host-side growth even though the interpreter has the operation. */
	wasm_byte_vec_new_uninitialized(&binary, sizeof kMemoryModule);
	memcpy(binary.data, kMemoryModule, sizeof kMemoryModule);
	wasm_module_t *memory_module = wasm_module_new(store, &binary);
	wasm_byte_vec_delete(&binary);
	if (memory_module == NULL) {
		printf("wamr: memory module did not compile\n");
		return 1;
	}
	wasm_instance_t *memory_instance =
		wasm_instance_new(store, memory_module, &imports, NULL);
	if (memory_instance == NULL) {
		printf("wamr: memory module did not instantiate\n");
		return 1;
	}
	wasm_extern_vec_t memory_exports;
	wasm_instance_exports(memory_instance, &memory_exports);
	wasm_memory_t *memory = memory_exports.size == 1
		? wasm_extern_as_memory(memory_exports.data[0]) : NULL;
	if (memory == NULL) {
		printf("wamr: memory export is missing (exports=%u)\n",
		       (unsigned)memory_exports.size);
		return 1;
	}
	wasm_memory_pages_t before_pages = wasm_memory_size(memory);
	size_t before_bytes = wasm_memory_data_size(memory);
	wasm_memorytype_t *memory_type = wasm_memory_type(memory);
	const wasm_limits_t *memory_limits = wasm_memorytype_limits(memory_type);
	unsigned maximum = memory_limits == NULL ? 0 : (unsigned)memory_limits->max;
	wasm_memorytype_delete(memory_type);
	if (before_pages != 1 || before_bytes != 65536) {
		printf("wamr: memory export has wrong initial size "
		       "(pages=%u bytes=%u max=%u)\n",
		       (unsigned)before_pages, (unsigned)before_bytes, maximum);
		return 1;
	}
	wasm_memory_data(memory)[0] = 0x5a;
	bool grew = wasm_memory_grow(memory, 1);
	wasm_memory_pages_t after_pages = wasm_memory_size(memory);
	size_t after_bytes = wasm_memory_data_size(memory);
	unsigned first = after_bytes == 0 ? 0 : wasm_memory_data(memory)[0];
	unsigned last = after_bytes < 2 * 65536
		? 0xff : wasm_memory_data(memory)[2 * 65536 - 1];
	if (!grew || after_pages != 2 || after_bytes != 2 * 65536
	    || first != 0x5a || last != 0) {
		printf("wamr: host memory growth failed "
		       "(grew=%d pages=%u bytes=%u max=%u first=%u last=%u)\n",
		       grew, (unsigned)after_pages, (unsigned)after_bytes, maximum,
		       first, last);
		return 1;
	}

	printf("wamr ok add(2,3)=%d global=%d memory=%u\n", results[0].of.i32,
	       value.of.i32, wasm_memory_size(memory));
	return 0;
}
