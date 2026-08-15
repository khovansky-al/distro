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

  patches = [
    ./static-system-openssl.patch
    ./linux-wasm-port.patch
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

  cmakeFlags = [
    "-DEDGE_NAPI_PROVIDER=quickjs"
    "-DEDGE_BUILD_CLI=ON"
    "-DEDGE_BUILD_NAPI_TESTS=OFF"
    "-DEDGE_QUICKJS_WEBASSEMBLY=OFF"
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
    runHook postInstall
  '';

  passthru = {
    # Alpine versions cannot contain the Nix-style "-unstable-YYYY-MM-DD"
    # suffix; this metadata is already a full APK version including release.
    apk.version = "0.1.0_git20260815-r0";
    checks.node-version = vm-test.installedTest {
      name = "edgejs-node-version";
      init = ./node-version-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  };
})
