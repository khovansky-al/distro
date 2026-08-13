{ pkgs }:

pkgs.stdenv.mkDerivation {
  pname = "lowland-websocket-relay";
  version = "0.1.0";
  src = ../../packages/websocket-relay;

  strictDeps = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/include/lowland $out/lib $out/share/doc/lowland-websocket-relay
    cp lowland-websocket-relay $out/bin/
    cp relay.h $out/include/lowland/relay.h
    cp liblowland-websocket-relay.a $out/lib/
    cp README.md PROTOCOL.md $out/share/doc/lowland-websocket-relay/

    runHook postInstall
  '';
}
