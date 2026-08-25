{
  pkgs,
  busybox,
  edgejs,
  vm-test,
  src ? pkgs.fetchurl {
    url = "https://registry.npmjs.org/@yarnpkg/cli-dist/-/cli-dist-4.17.1.tgz";
    hash = "sha256-+O+wPlQ/5NxV6ha0adhqFAHaVGq5g5TAa/PX9Mpt3UE=";
  },
}:

# Yarn's cli-dist release is a single bundled JavaScript program. Stage the
# published bytes with the build platform and invoke them through the guest's
# statically linked Edge.js interpreter.
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "yarn";
  version = "4.17.1";
  inherit src;

  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/node_modules/@yarnpkg/cli-dist $out/bin
    cp -R . $out/lib/node_modules/@yarnpkg/cli-dist/

    # Real BusyBox scripts are required because the wasm kernel cannot exec an
    # executable through a symlink.
    for command in yarn yarnpkg; do
      cat >$out/bin/$command <<'EOF'
    #!/bin/busybox sh
    exec /bin/node /lib/node_modules/@yarnpkg/cli-dist/bin/yarn.js "$@"
    EOF
      chmod 0755 $out/bin/$command
    done

    runHook postInstall
  '';

  passthru = {
    apk = {
      version = "4.17.1-r0";
      depends = [ "edgejs" ];
    };
    checks.version = vm-test.installedTest {
      name = "yarn-version";
      init = ./version-test.sh;
      contents = [
        busybox
        edgejs
        finalAttrs.finalPackage
      ];
    };
  };
})
