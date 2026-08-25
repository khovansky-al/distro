{
  pkgs,
  busybox,
  edgejs,
  vm-test,
  src ? pkgs.fetchurl {
    url = "https://registry.npmjs.org/pnpm/-/pnpm-10.34.5.tgz";
    hash = "sha256-zLXEecqxsAYhMlv+fUyaioAx56Ul1ySeJ17L7IGwjbI=";
  },
}:

# pnpm is pure JavaScript, so it is staged with the build platform's
# stdenvNoCC. Edge.js supplies the guest interpreter; the published pnpm
# payload supplies the CLI and its bundled dependencies.
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "pnpm";
  version = "10.34.5";
  inherit src;

  dontConfigure = true;
  dontBuild = true;
  # The published payload contains guest shebangs. Fixup would rewrite them
  # to Nix store paths, which do not exist in the APK filesystem and would
  # also be rejected by APK's store-reference check.
  dontFixup = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/node_modules/pnpm $out/bin
    cp -R . $out/lib/node_modules/pnpm/

    # Keep these as real BusyBox scripts. The wasm kernel cannot exec through
    # a symlink to an executable, and the guest interpreter is /bin/node.
    cat >$out/bin/pnpm <<'EOF'
    #!/bin/busybox sh
    exec /bin/node /lib/node_modules/pnpm/bin/pnpm.cjs "$@"
    EOF

    cat >$out/bin/pnpx <<'EOF'
    #!/bin/busybox sh
    exec /bin/node /lib/node_modules/pnpm/bin/pnpx.cjs "$@"
    EOF

    chmod 0755 $out/bin/pnpm $out/bin/pnpx

    runHook postInstall
  '';

  passthru = {
    apk = {
      version = "10.34.5-r0";
      depends = [ "edgejs" ];
    };

    checks.version = vm-test.installedTest {
      name = "pnpm-version";
      init = ./version-test.sh;
      contents = [
        busybox
        edgejs
        finalAttrs.finalPackage
      ];
    };
  };
})
