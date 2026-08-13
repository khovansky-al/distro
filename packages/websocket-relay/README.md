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

The implementation has no third-party dependencies. It uses C11 plus the
POSIX/BSD socket and pthread APIs available on Linux and Apple platforms. The
Apple `SO_NOSIGPIPE` path is included, so the networking core can be compiled
into a future iOS application target; an iOS host application will still need
to own lifecycle, background-execution, and TLS policy.

The protocol is documented in [PROTOCOL.md](./PROTOCOL.md). BIND/LISTEN opcodes
are reserved there for a future inbound-listener extension.
