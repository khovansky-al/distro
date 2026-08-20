{
  lib,
  pkgs,
  stdenv,
  vm-test,
  busybox,
  src ? pkgs.wamr.src,
}:

# wasm-micro-runtime as a wasm_c_api provider for the guest.
#
# This is what makes Edge.js's `WebAssembly` global buildable here. That global
# is already fully implemented in edgejs/src/webassembly/edge_wasm.cc, in terms
# of the standard wasm_c_api and nothing Wasmer-specific; all it ever lacked was
# an implementation of that API compiled for wasm32-unknown-linux-musl.
#
# It cannot be Wasmer. Wasmer's backends compile WebAssembly to machine code at
# run time, and a WebAssembly guest cannot generate or execute machine code, so
# no amount of porting would help. WAMR is a plain-C interpreter, which can.

stdenv.mkDerivation (finalAttrs: {
  pname = "wamr-wasm-c-api";
  version = pkgs.wamr.version;
  inherit src;

  nativeBuildInputs = [
    pkgs.cmake
    pkgs.ninja
  ];

  # The POSIX layer assumes two things this platform does not have.
  #
  # mmap: absent entirely, since musl's port compiles it out under
  # `#ifndef __wasm__`. Everything os_mmap is asked for is ordinary anonymous
  # memory, so malloc answers it.
  #
  # A stack with an address: os_thread_get_stack_boundary asks
  # pthread_getattr_np where the thread's stack is, which segfaults here. A
  # WebAssembly stack is not in linear memory and has no address to compare
  # against, and every caller already handles not knowing.
  # WAMR 2.4.4 also fails to read or write a standalone wasm_global_new global:
  # it only consults globals belonging to a module instance. Edge.js creates
  # those host globals for WebAssembly.Global, so retain their value in init.
  patches = [
    ./platform-gaps.patch
    ./standalone-globals.patch
  ];

  # The project file lives here rather than in WAMR's tree: WAMR expects each
  # consumer to select its own feature set and link the sources itself, which
  # is what this does.
  postPatch = ''
    cp ${./CMakeLists.txt} CMakeLists.txt
  '';

  # WAMR locates its own sources relative to this, and the value is only known
  # once the source has been unpacked.
  preConfigure = ''
    cmakeFlagsArray+=("-DWAMR_ROOT_DIR=$PWD")
  '';

  postInstall = ''
    # Edge.js's dist-root probe requires this file to exist. Its contents are
    # never used: edge_wasm.cc includes <wasm.h> only and calls no wasmer_*
    # function, which is why an interpreter can stand in at all.
    cat > $out/include/wasmer.h <<'HEADER'
    /* Intentionally empty. Edge.js probes for this file because it expects a
       Wasmer distribution, but uses only the standard wasm_c_api in wasm.h. */
    #ifndef EDGE_WASMER_SHIM_H
    #define EDGE_WASMER_SHIM_H
    #endif
    HEADER
  '';

  passthru.checks.interpreter =
    let
      program = stdenv.mkDerivation {
        name = "wamr-interpreter-test";
        dontUnpack = true;
        buildPhase = ''
          $CC -O2 ${./interpreter-test.c} -I${finalAttrs.finalPackage}/include \
            ${finalAttrs.finalPackage}/lib/libwasmer.a -o wamr-interpreter-test
        '';
        installPhase = "install -Dm755 wamr-interpreter-test $out/bin/wamr-interpreter-test";
      };
    in
    vm-test.installedTest {
      name = "wamr-interpreter";
      init = ./interpreter-test.sh;
      contents = [ busybox ];
      # A real copy rather than a package: the kernel cannot exec through a
      # symlink, and this needs no installed metadata.
      files."/wamr-interpreter-test" = {
        source = "${program}/bin/wamr-interpreter-test";
        mode = "0755";
      };
    };

  meta = {
    description = "wasm-micro-runtime's wasm_c_api as a static library for the wasm guest";
    license = lib.licenses.asl20;
  };
})
