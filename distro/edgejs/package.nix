{
  pkgs,
  stdenv,
  platform,
  sysroot,
  src ? pkgs.fetchzip {
    url = "https://github.com/wasmerio/edgejs/archive/1ca99ab4ff3d74bf5940177eb007457612d398e3.tar.gz";
    hash = "sha256-bES6oqRMUpKgI0fulVs9qwmC6sZBtkR4yp1VYRzOjQg=";
  },
  napiSrc ? pkgs.fetchzip {
    url = "https://github.com/wasmerio/napi/archive/c5b66fb9f5b1b997d5bdd463dc1a80bb174d4730.tar.gz";
    hash = "sha256-VaaABY5HVnPYUuzjrDNxnnr3pBtBkCRjfTfGkh22vFw=";
  },
  quickjsSrc ? pkgs.fetchzip {
    url = "https://github.com/wasmerio/quickjs/archive/9d5513a65693e4fc16f48975df59f6fa62f6a9b0.tar.gz";
    hash = "sha256-jpbWddHNVFrLQ6CWBtorchGG2SI9x0PHTP7txxzNyP4=";
  },
  openssl,
  vm-test,
  busybox,
  lib,
  llvm-toolchain,
  rolldown,
  wamr,
  # N-API addons to compile into the interpreter. This platform is static-only
  # and wasm has no dlopen, so a native addon cannot be a loadable .node file;
  # it is linked in and registered under the file name `require` asks for.
  # Each entry is { name, library }, as produced by an addon's
  # passthru.linkedAddon.
  linkedAddons ? [ rolldown.linkedAddon ],
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "edgejs";
  version = "0.1.0-unstable-2026-08-15";
  inherit src;

  nativeBuildInputs = [
    pkgs.cmake
    pkgs.ninja
    pkgs.python3
  ];
  buildInputs = [ openssl ];

  # The custom wasm-linux Clang driver currently neither discovers the
  # sysroot's libc++ headers nor selects libc++ for C++ links. Use the cc
  # wrapper's C++-only channels until those defaults move into the toolchain.
  NIX_CXXSTDLIB_COMPILE = "-nostdinc++ -isystem ${sysroot}/include/c++/v1 -isystem ${sysroot}/include/${platform.multiarchTriple}/c++/v1 -nostdlib++";
  NIX_CXXSTDLIB_LINK = "-lc++ -lc++abi";

  # The last two patches touch the pinned N-API and QuickJS checkouts that
  # postUnpack stages, not Edge.js's own tree, so they cannot live in the port
  # patch generated from the Edge.js repository. patchPhase runs after
  # unpackPhase, so the files they edit are present by then.
  #
  # The last two are not port concerns either, which is why they are separate.
  # napi-fatal-error implements a function the N-API header declares and the V8
  # provider has but the QuickJS one never did. threadsafe-function replaces a
  # napi_call_threadsafe_function that accepted every call, returned napi_ok and
  # discarded it: any addon that settles a promise from another thread — which
  # is every asynchronous napi-rs API — hung forever with no error anywhere.
  patches = [
    ./static-system-openssl.patch
    ./linux-wasm-port.patch
    ./napi-fatal-error.patch
    ./threadsafe-function.patch
    ./quickjs-thread-signature.patch
  ];

  postUnpack = ''
    # GitHub source archives do not contain gitlink contents. Reconstruct the
    # exact source tree from Edge.js's pinned N-API and QuickJS revisions.
    mkdir -p "$sourceRoot/napi/quickjs/deps"
    cp -R ${napiSrc}/. "$sourceRoot/napi/"
    chmod -R u+w "$sourceRoot/napi"
    cp -R ${quickjsSrc}/. "$sourceRoot/napi/quickjs/deps/quickjs/"
    chmod -R u+w "$sourceRoot/napi/quickjs/deps/quickjs"
  '';

  # Every napi-rs addon exports the same entry point, so one linked addon is
  # the supported case; a second would need its symbol renamed first.
  preConfigure = lib.optionalString (linkedAddons != [ ]) (
    assert lib.assertMsg (
      lib.length linkedAddons == 1
    ) "edgejs supports one linked addon: each exports napi_register_module_v1";
    ''
      # napi-rs does not register a wasm addon's items from static
      # constructors the way it does everywhere else. Compiled for wasm, each
      # #[napi] item becomes a plain `#[no_mangle] extern "C"` function named
      # __napi_register__*, and the generated emnapi loader calls every one of
      # those exports after instantiating the module. A linked addon has no
      # loader, so nothing calls them: napi_register_module_v1 then finds an
      # empty registration list and the addon exports nothing at all.
      #
      # Recover the same list the loader would use, from the archive itself.
      registrations=$(
        ${llvm-toolchain}/bin/llvm-nm --defined-only ${
          lib.concatMapStringsSep " " (addon: addon.library) linkedAddons
        } |
          awk '$2 == "T" && $3 ~ /^__napi_register__/ { print $3 }' | sort -u
      )
      echo "linked addon registrations: $(printf '%s\n' "$registrations" | grep -c .)"

      {
        cat <<'ADDONS'
      typedef struct napi_env__ *napi_env;
      typedef struct napi_value__ *napi_value;
      typedef napi_value (*napi_addon_register_func)(napi_env, napi_value);

      extern void edge_register_linked_addon(const char *, napi_addon_register_func);
      extern napi_value napi_register_module_v1(napi_env, napi_value);
      ADDONS
        printf 'extern void %s(void);\n' $registrations

        # Registering at load time rather than from a constructor keeps the
        # order the addon was built for: this is the point at which the emnapi
        # loader would have called these, with the runtime already up. The
        # guard is because an interpreter may register the same addon into more
        # than one environment, while these lists are global and must be built
        # once.
        cat <<'ADDONS'

      static napi_value edge_linked_addon_register(napi_env env, napi_value exports) {
        static int registered = 0;
        if (!registered) {
          registered = 1;
      ADDONS
        printf '      %s();\n' $registrations
        cat <<ADDONS
        }
        return napi_register_module_v1(env, exports);
      }

      __attribute__((constructor)) static void edge_register_linked_addons(void) {
        edge_register_linked_addon("${(lib.head linkedAddons).name}", edge_linked_addon_register);
      }
      ADDONS
      } >linked-addons.c
      $CC -c linked-addons.c -o linked-addons.o
      $CC -c ${./linked-addon-shims.c} -o linked-addon-shims.o

      # --whole-archive, because napi-rs registers every #[napi] item from a
      # static constructor. Nothing references those constructors by symbol, so
      # ordinary archive resolution pulls only the entry point and leaves the
      # addon's actual code behind: the module then registers no exports at all.
      #
      # STANDARD_LIBRARIES rather than EXE_LINKER_FLAGS: these must come after
      # the executable's own objects for archive symbol resolution to work.
      cmakeFlagsArray+=(
        "-DCMAKE_CXX_STANDARD_LIBRARIES=$PWD/linked-addons.o -Wl,--whole-archive ${
          lib.concatMapStringsSep " " (addon: addon.library) linkedAddons
        } -Wl,--no-whole-archive $PWD/linked-addon-shims.o"
      )
    ''
  );

  cmakeFlags = [
    "-DEDGE_NAPI_PROVIDER=quickjs"
    "-DEDGE_BUILD_CLI=ON"
    "-DEDGE_BUILD_NAPI_TESTS=OFF"
    # A `WebAssembly` global, which vite needs twice over: to import at all, and
    # to finish, because its build-import-analysis plugin parses every emitted
    # chunk with a WebAssembly-backed lexer.
    #
    # The option is named after Wasmer and the dist root imitates one, but
    # Edge.js only ever uses the standard wasm_c_api, so the implementation
    # behind it is wasm-micro-runtime. It has to be an interpreter: Wasmer
    # compiles to machine code at run time, which a wasm guest cannot do.
    "-DEDGE_QUICKJS_WEBASSEMBLY=ON"
    "-DEDGE_QUICKJS_WASMER_DIST_ROOT=${wamr}"
    "-DEDGE_STATIC_OPENSSL=ON"
    "-DOPENSSL_ROOT_DIR=${openssl}"
    "-DOPENSSL_USE_STATIC_LIBS=TRUE"
    "-DBUILD_TESTING=OFF"
  ];

  enableParallelBuilding = true;
  ninjaFlags = [ "edge" ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp edge $out/bin/edge
    # Keep a real second executable: the wasm kernel cannot exec through an
    # executable symlink, and Node-compatible tooling expects this basename.
    cp edge $out/bin/node

    # `require` resolves a path before it ever reaches process.dlopen, so a
    # linked addon still needs a file to point at. Its contents are never read:
    # the code is already inside this executable, and the loader matches on the
    # file name. Point NAPI_RS_NATIVE_LIBRARY_PATH at one of these.
    ${lib.concatMapStringsSep "\n" (addon: ''
      install -Dm644 /dev/null $out/lib/edge-addons/${addon.name}
    '') linkedAddons}
    runHook postInstall
  '';

  passthru = {
    # Alpine versions cannot contain the Nix-style "-unstable-YYYY-MM-DD"
    # suffix; this metadata is already a full APK version including release.
    #
    # The release suffix must move whenever the build changes without the source
    # revision moving, or apk sees the installed version and declines the
    # upgrade. -r2 is the NAPI_RS_NATIVE_LIBRARY_PATH default plus the WAMR
    # teardown fix.
    apk.version = "0.1.0_git20260815-r2";
    checks = {
      node-version = vm-test.installedTest {
        name = "edgejs-node-version";
        init = ./node-version-test.sh;
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
      # Evaluating a string of JavaScript needs no threads, so the version check
      # alone cannot tell a usable interpreter from one that traps the moment a
      # program does asynchronous work. This covers that.
      async-io = vm-test.installedTest {
        name = "edgejs-async-io";
        init = ./async-io-test.sh;
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
      # A present-but-inert `WebAssembly` global would be worse than none, since
      # callers feature-detect on it, so this runs a real module.
      webassembly = vm-test.installedTest {
        name = "edgejs-webassembly";
        init = ./webassembly-test.sh;
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
      # WebAssembly wrappers outlive the environment-owned WAMR state during
      # teardown. This catches frees reaching WAMR after its allocator dies.
      webassembly-teardown = vm-test.installedTest {
        name = "edgejs-webassembly-teardown";
        init = ./webassembly-teardown-test.sh;
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    }
    # Whether a linked addon's exports reach JavaScript, separately from whether
    # the addon then does its job. Only present when there is an addon to load.
    // lib.optionalAttrs (linkedAddons != [ ]) {
      linked-addon = vm-test.installedTest {
        name = "edgejs-linked-addon";
        init = ./linked-addon-test.sh;
        contents = [
          busybox
          finalAttrs.finalPackage
        ];
      };
    };
  };
})
