# Lowland TCP WebSocket protocol v1

The client opens one WebSocket per DNS lookup, outbound TCP flow, publication
control channel, or accepted inbound TCP flow and requests the subprotocol
`lowland-tcp-v1`. Every application message is binary. Multibyte integers use
network byte order.

The first byte is an opcode:

| Opcode | Direction | Payload |
| --- | --- | --- |
| `0x01` CONNECT | client → relay | port (`u16`), host (UTF-8) |
| `0x02` RESOLVE | client → relay | hostname (UTF-8) |
| `0x03` DATA | either | opaque TCP bytes |
| `0x04` FIN | either | empty; half-closes that direction |
| `0x05` RESET | either | empty; aborts the flow |
| `0x06` BIND | client → relay | requested relay port (`u16`), guest port (`u16`) |
| `0x07` ACCEPT | client → relay | pending-connection capability (16 bytes) |
| `0x08` REJECT | publication client → relay | pending-connection capability (16 bytes) |
| `0x81` CONNECTED | relay → client | empty |
| `0x82` RESOLVED | relay → client | one or more packed IPv4 addresses |
| `0x83` BOUND | relay → client | effective relay port (`u16`) |
| `0x84` INCOMING | relay → publication client | pending-connection capability (16 bytes) |
| `0x85` ACCEPTED | relay → client | empty |
| `0xff` ERROR | relay → client | human-readable UTF-8 diagnostic |

The relay resolves only IPv4 because the current WASM kernel guest network is
IPv4-only. CONNECT accepts a hostname or numeric address.

The guest Ethernet gateway address `192.0.2.1` has one special CONNECT
meaning: the relay opens the socket on its own IPv4 loopback address
(`127.0.0.1`). This lets a guest reach the site, APK repository, and other
services packaged alongside a loopback-only relay without exposing those
services on a LAN interface. RESOLVE is unchanged, and no other destination is
rewritten.

## Published TCP listeners

A publication starts with BIND as the first message on a persistent control
WebSocket. The relay accepts it only when the port pair exactly matches a
configured `--publish` policy and that policy has no active publication. Relay
port zero selects a policy whose configured relay port is zero and asks the OS
for an ephemeral port. BOUND reports the effective nonzero port.

Each accepted native TCP socket is retained for at most 45 seconds while the
relay sends INCOMING with an unguessable capability on the control channel.
There may be at most 64 pending sockets per publication. The client first
connects to the guest listener. If that connection fails, it sends REJECT on
the control channel. Otherwise it opens a new WebSocket, sends ACCEPT as its
first message, and waits for ACCEPTED before carrying data.

After ACCEPTED, the flow uses the same DATA, FIN, RESET, and WebSocket-close
semantics as an outbound connection. Capabilities are single-use and scoped to
the live listener that created them. Closing the publication control WebSocket
closes the listener and every pending socket, and resets all accepted flows.
WebSocket transport closure without a protocol FIN is treated as a reset.

Opcodes `0x09` through `0x0f` and `0x86` through `0x8f` remain reserved.
