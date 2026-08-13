# Lowland WebSocket TCP relay

This is the native counterpart to `webSocketNetwork()` in
`@tombl/linux-guest`. It accepts WebSockets and forwards each connection to an
ordinary TCP socket. DNS requests use `getaddrinfo(3)` and return IPv4 answers
to the browser-side guest network.

Build and run it on Linux or macOS:

```sh
make
./lowland-websocket-relay --listen 127.0.0.1 --port 8080
```

Inbound TCP is disabled unless an exact publication policy is configured. The
option is repeatable and uses Docker-style syntax:

```sh
./lowland-websocket-relay \
  --listen 127.0.0.1 --port 8080 \
  --publish 127.0.0.1:12345:80 \
  --publish '[::1]:12346:443'
```

The address defaults to `127.0.0.1`, so `--publish 12345:80` is equivalent to
the first mapping above. Relay port `0` asks the OS to choose a development or
test port. A configured mapping permits one active browser publication, binds
only while that publication's control WebSocket is alive, and can be rebound
after it closes. The browser cannot choose a different address, relay port, or
guest port than the configured mapping.

Then load the browser VM with the relay URL:

```text
https://linux.tombl.dev/?relay=wss://relay.example.net/
```

An HTTPS page requires `wss:`. The relay intentionally implements plain
WebSocket only; put Caddy, nginx, HAProxy, or another TLS reverse proxy in front
of its loopback listener. The proxy is also the right place for authentication,
rate limits, and origin policy. For defense in depth, `--origin URL` makes the
relay reject WebSocket upgrades with any other `Origin` header.

Do not expose the relay directly to an untrusted network. It grants clients
the ability to resolve names and open arbitrary outbound TCP connections,
which is equivalent to an unauthenticated forward proxy.

Published raw TCP ports do not pass through the HTTP/WebSocket reverse proxy,
so its authentication and origin checks do not protect them. Keep publication
addresses on loopback or another trusted interface unless the guest service
has its own authentication, authorization, encryption, and rate limits. A
guest server must listen on its Ethernet address or `0.0.0.0`; a server bound
only to guest `127.0.0.1` cannot be reached by the virtual network gateway.

For a temporary tailnet demo, keep the relay publication on loopback and use a
separate Tailscale Serve TCP forward from the chosen tailnet port to that
loopback port. This exposes only the approved mapping and does not require a
persistent Tailscale configuration change; remove the throwaway Serve route
when the demo ends.

The implementation has no third-party dependencies. It uses C11 plus the
POSIX/BSD socket and pthread APIs available on Linux and Apple platforms. The
Apple `SO_NOSIGPIPE` path is included, so the networking core can be compiled
into a future iOS application target; an iOS host application will still need
to own lifecycle, background-execution, and TLS policy.

The protocol is documented in [PROTOCOL.md](./PROTOCOL.md).
