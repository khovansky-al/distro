{
  lib,
  pkgs,
  platform,
  rust-toolchain,
  src ? pkgs.fetchzip {
    url = "https://github.com/rolldown/rolldown/archive/refs/tags/v1.2.4.tar.gz";
    hash = "sha256-5c6Rq56Mac2FbeUjpgMhYGoqeVB9bk1+rGE6svBRRo8=";
  },
}:

# Rolldown's N-API binding, built for the guest as a static archive.
#
# vite 8 bundles with rolldown, whose JavaScript is a thin wrapper over a Rust
# addon. A native addon normally ships as a dynamically loaded .node file, but
# this platform is static-only and wasm has no dlopen, so the archive is linked
# into the Edge.js interpreter instead and registered through the interpreter's
# linked-addon table. See distro/edgejs/package.nix.
#
# The dependency patches below all come from one root cause: this target is
# `target_os = "linux"` with `target_arch = "wasm32"`. Crates that special-case
# wasm assume it means WASI or a browser and disable their Linux
# implementations, while crates that special-case Linux assume one of the
# architectures Linux normally runs on. This platform is genuinely both.

let
  # crates.io sources, patched before cargo sees them. Cargo's `paths`
  # override requires the name and version to match the lock file exactly.
  patchedCrate =
    {
      name,
      version,
      hash,
      patch,
    }:
    pkgs.stdenvNoCC.mkDerivation {
      pname = "${name}-wasm32-linux";
      inherit version;
      # fetchzip rather than fetchurl: a .crate is a tarball, and the standard
      # unpack phase does not recognise the extension.
      src = pkgs.fetchzip {
        url = "https://static.crates.io/crates/${name}/${name}-${version}.crate";
        extension = "tar.gz";
        inherit hash;
      };
      patches = [ patch ];
      dontConfigure = true;
      dontBuild = true;
      dontFixup = true;
      installPhase = ''
        runHook preInstall
        cp -r . $out
        runHook postInstall
      '';
    };

  linux-raw-sys = patchedCrate {
    name = "linux-raw-sys";
    version = "0.12.1";
    hash = "sha256-syk6TlGevol6xQAS8HtCnIjDGBcLKcZ762areCAhvGM=";
    patch = ./patches/linux-raw-sys.patch;
  };

  rustix = patchedCrate {
    name = "rustix";
    version = "1.1.4";
    hash = "sha256-KOZKGzxdH4rsR64x+NFWb+yLPRSt5vdA3eQ38SI9Jmk=";
    patch = ./patches/rustix.patch;
  };

  mio = patchedCrate {
    name = "mio";
    version = "1.2.2";
    hash = "sha256-QlNFP4WuEhAB/PTDdea3yPvx+rZQr3I2Sl1WT/d8hbo=";
    patch = ./patches/mio.patch;
  };
  package = rust-toolchain.buildRustPackage {
    pname = "rolldown-binding";
    version = "1.2.4";
    inherit src;

    patches = [ ./patches/rolldown.patch ];

    cargoLock.lockFile = ./Cargo.lock;
    cargoPathOverrides = [
      linux-raw-sys
      rustix
      mio
    ];

    # Tokio refuses its filesystem, network and multi-threaded runtime features
    # on `target_family = "wasm"`, because that normally means WASI or a browser.
    # This cfg is tokio's own escape hatch, and this guest really does have
    # threads, epoll and sockets.
    RUSTFLAGS = "--cfg tokio_unstable";

    # One workspace member: the rest of rolldown's workspace is its command line
    # and development tooling, none of which is wanted in the guest.
    cargoBuildFlags = [
      "-p"
      "rolldown_binding"
    ];

    installPhase = ''
      runHook preInstall
      install -Dm644 target/${platform.targetTriple}/release/librolldown_binding.a \
        $out/lib/librolldown_binding.a
      runHook postInstall
    '';

    meta = {
      description = "Rolldown's N-API binding as a static archive for the wasm guest";
      license = lib.licenses.mit;
    };
  };
in
package
// {
  # How the interpreter links this addon in. The library path has to be built
  # from the finished package rather than from `placeholder "out"`, which would
  # resolve against whichever derivation interpolates the string.
  linkedAddon = {
    # The file name rolldown's loader will `require`, pointed at by
    # NAPI_RS_NATIVE_LIBRARY_PATH in the guest.
    name = "rolldown-binding.node";
    library = "${package}/lib/librolldown_binding.a";
  };
}
