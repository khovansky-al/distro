# Lowland TCP WebSocket protocol v1

The client opens one WebSocket per DNS lookup or TCP flow and requests the
subprotocol `lowland-tcp-v1`. Every application message is binary. Multibyte
integers use network byte order.

The first byte is an opcode:

| Opcode | Direction | Payload |
| --- | --- | --- |
| `0x01` CONNECT | client → relay | port (`u16`), host (UTF-8) |
| `0x02` RESOLVE | client → relay | hostname (UTF-8) |
| `0x03` DATA | either | opaque TCP bytes |
| `0x04` FIN | either | empty; half-closes that direction |
| `0x05` RESET | either | empty; aborts the flow |
| `0x81` CONNECTED | relay → client | empty |
| `0x82` RESOLVED | relay → client | one or more packed IPv4 addresses |
| `0xff` ERROR | relay → client | human-readable UTF-8 diagnostic |

The relay resolves only IPv4 because the current WASM kernel guest network is
IPv4-only. CONNECT accepts a hostname or numeric address.

Opcodes `0x06` through `0x0f` and `0x83` through `0x8f` are reserved for a
future BIND/LISTEN/ACCEPT extension. Keeping connection setup distinct from
DATA and preserving TCP half-close semantics means that extension can expose
accepted sockets without changing existing flow messages.

WebSocket transport closure without a protocol FIN is treated as a reset.
