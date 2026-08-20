# The kernel is a build-platform artifact: a wasm blob and headers. The
# JavaScript host library lives in the repository's @lowland/kernel workspace
# package. This derivation uses explicit tools because kbuild drives its own
# cross setup rather than the wasm stdenv.
{
  pkgs,
  lib,
  debug,
  llvm-toolchain-unwrapped,
  src ? pkgs.fetchFromGitHub {
    owner = "tombl";
    repo = "linux";
    rev = "f06dad0dcdfbc8b48309093c9abb68ba47502b7f";
    hash = "sha256-s22VmEIvNQxBM0ttVzdHkCN/MW/Wfd8SXR3hjGITxhQ=";
  },
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "linux";
  version = "0.0.0";
  inherit src;

  outputs = [
    "out"
    "headers"
  ];

  # The outputs are wasm and headers: nixpkgs' fixup would strip nothing.
  dontFixup = true;

  nativeBuildInputs = [
    llvm-toolchain-unwrapped
    pkgs.bc
    pkgs.bison
    pkgs.findutils
    pkgs.flex
    pkgs.gnumake
    pkgs.perl
    pkgs.rsync
    pkgs.wabt
  ];

  # The WebAssembly package links vmlinux.o directly and never runs modpost.
  # Building that Linux-specific host utility is therefore unnecessary, and
  # it is not portable to Darwin (it requires glibc's ELF/byteswap interfaces).
  postPatch = lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
        substituteInPlace scripts/mod/Makefile \
          --replace-fail 'hostprogs-always-y' \
          'hostprogs-disabled-on-darwin'
        substituteInPlace usr/gen_init_cpio.c \
          --replace-fail '#include <limits.h>' '#include <limits.h>
    #ifdef __APPLE__
    #define copy_file_range(...) (-1)
    #define O_LARGEFILE 0
    #endif'
  '';

  buildPhase = ''
    runHook preBuild

    make() {
      command make -j$NIX_BUILD_CORES \
        HOSTCC=${pkgs.llvmPackages_22.clang}/bin/clang \
        "$@"
    }

    # GitHub's archive contains Documentation/Kbuild and Documentation/kbuild.
    # They collide on the default case-insensitive Darwin Nix volume, making
    # the kernel's recursive clean fail before the actual build starts. The
    # source is freshly unpacked, so a clean is only needed on case-sensitive
    # build hosts.
    ${lib.optionalString (!pkgs.stdenv.hostPlatform.isDarwin) "make mrproper"}
    mkdir -p $out

    make defconfig ${lib.optionalString debug "debug.config"}
    # The archive's /usr/bin/env shebang is unavailable in the sandbox.
    ${pkgs.bash}/bin/bash ./scripts/config -e CONFIG_INOTIFY_USER
    make olddefconfig
    grep -q '^CONFIG_INOTIFY_USER=y$' .config

    make vmlinux.wasm

    cp vmlinux.wasm $out/

    make headers_install INSTALL_HDR_PATH=$headers

    runHook postBuild
  '';

  installPhase = "runHook preInstall; runHook postInstall";
}
