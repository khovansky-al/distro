{
  apk,
  apk-tools,
  basic-init,
  busybox,
  ca-certificates,
  edgejs,
  image,
  npm,
  pkgs,
  repository,
  vm-test,
}:

let
  package = image.mkFilesystem {
    name = "runner-rootfs";
    root = apk.mkSystem {
      name = "runner";
      repositories = [ repository ];
      packages = [
        apk-tools
        basic-init
        busybox
        npm
        edgejs
      ];
      files."/init" = {
        source = ../../runner/rootfs-init.sh;
        mode = "0755";
      };
      # A real copy, not a link: the wasm kernel cannot exec (or even stat -x)
      # through a symlink to an executable.
      files."/bin/basic-init" = "${basic-init}/bin/init";
      # The virtual network answers DNS at the gateway. Without this the
      # resolver has nothing to ask and every hostname lookup in the guest
      # fails, which is the first thing a package manager needs.
      files."/etc/resolv.conf" = pkgs.writeText "runner-resolv.conf" ''
        nameserver 192.0.2.1
      '';
    };
  };
in
package
// {
  checks.mount = vm-test.installedTest {
    name = "runner-rootfs";
    init = ../../runner/rootfs-smoke-test.sh;
    contents = [
      apk-tools
      basic-init
      busybox
      ca-certificates
    ];
    files = {
      "/bin/basic-init" = "${basic-init}/bin/init";
    };
  };
}
