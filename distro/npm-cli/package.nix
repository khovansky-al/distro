{
  pkgs,
  busybox,
  edgejs,
  vm-test,
  src ? pkgs.fetchurl {
    url = "https://registry.npmjs.org/npm/-/npm-11.16.0.tgz";
    hash = "sha256-MPwVaXx3EAKHhmXCn0nd3emqhmf6VxmFSy9S080ZIws=";
  },
}:

# npm is pure JavaScript, so it is built by the build platform's stdenv rather
# than the wasm one: there is nothing to compile, only a registry tarball to
# stage into the guest's FHS tree. The Edge.js package supplies the runtime.
#
# The directory is named npm-cli because distro/npm already means "the npm
# packages this repository publishes"; the guest package itself is named npm.
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "npm";
  version = "11.16.0";
  inherit src;

  dontConfigure = true;
  dontBuild = true;

  # The standard fixup phase would rewrite `#!/usr/bin/env bash` and
  # `#!/usr/bin/env node` shebangs throughout the tarball to absolute Nix store
  # paths. Those paths do not exist in the guest, and the APK conversion
  # rejects store references outright, so the payload must ship exactly as
  # published.
  dontFixup = true;

  # Node resolves a global package directory as
  # `dirname(dirname(process.execPath))/lib/node_modules`. Edge.js installs its
  # interpreter as /bin/node, which makes that directory /lib/node_modules and
  # npm's own global prefix `/`. Installing anywhere else would leave `npm
  # install -g` writing to a directory npm cannot then resolve from.
  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/node_modules/npm $out/bin
    cp -R . $out/lib/node_modules/npm/

    # Real scripts, not symlinks into the package directory: the wasm kernel
    # cannot exec through a symlink to an executable. The interpreter is named
    # explicitly as /bin/busybox rather than /bin/sh for the same reason --
    # /bin/sh is one of BusyBox's applet symlinks.
    cat >$out/bin/npm <<'EOF'
    #!/bin/busybox sh
    exec /bin/node /lib/node_modules/npm/bin/npm-cli.js "$@"
    EOF

    cat >$out/bin/npx <<'EOF'
    #!/bin/busybox sh
    exec /bin/node /lib/node_modules/npm/bin/npx-cli.js "$@"
    EOF

    chmod 0755 $out/bin/npm $out/bin/npx

    runHook postInstall
  '';

  passthru = {
    apk = {
      # Alpine versions cannot carry a Nix-style suffix; this is already a
      # complete APK version including its release number.
      version = "11.16.0-r0";
      # npm is useless without an interpreter, and Edge.js is the one that
      # provides /bin/node.
      depends = [ "edgejs" ];
    };
    checks.version = vm-test.installedTest {
      name = "npm-version";
      init = ./version-test.sh;
      contents = [
        busybox
        edgejs
        finalAttrs.finalPackage
      ];
    };
  };
})
