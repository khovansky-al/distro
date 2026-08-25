{
  pkgs,
  busybox,
  vm-test,
}:

let
  package =
    pkgs.runCommand "ca-certificates-${pkgs.cacert.version}"
      {
        passthru = {
          apk = {
            name = "ca-certificates";
            version = "${pkgs.cacert.version}-r0";
            description = "Mozilla CA certificate bundle";
            license = "MPL-2.0";
          };
          checks.bundle = vm-test.installedTest {
            name = "ca-certificates-bundle";
            init = ./bundle-test.sh;
            contents = [
              busybox
              package
            ];
          };
        };
      }
      ''
        mkdir -p $out/etc/ssl/certs
        cp ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt \
          $out/etc/ssl/certs/ca-certificates.crt
        ln -s certs/ca-certificates.crt $out/etc/ssl/cert.pem
      '';
in
package
