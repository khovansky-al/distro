// SPDX-License-Identifier: MIT

#ifndef LOWLAND_WEBSOCKET_RELAY_H
#define LOWLAND_WEBSOCKET_RELAY_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct lowland_relay;

struct lowland_relay_publication {
	const char *listen_address;
	uint16_t host_port;
	uint16_t guest_port;
};

struct lowland_relay_config {
	const char *listen_address;
	uint16_t listen_port;
	const char *required_origin;
	const struct lowland_relay_publication *publications;
	size_t publication_count;
};

/*
 * Creation binds the WebSocket listener immediately, so a caller can obtain
 * an OS-assigned port before starting the blocking run loop. Strings and
 * publication entries are copied and need only remain valid for this call.
 */
struct lowland_relay *lowland_relay_create(const struct lowland_relay_config *config,
					   char *error, size_t error_capacity);

uint16_t lowland_relay_bound_port(const struct lowland_relay *relay);

/* Runs the accept loop on the calling thread until lowland_relay_stop(). */
int lowland_relay_run(struct lowland_relay *relay);

/*
 * Thread-safe and synchronous. It stops listeners and active flows and waits
 * until the run loop and every client worker have drained.
 */
void lowland_relay_stop(struct lowland_relay *relay);

/* Stops a running relay if necessary, then releases all copied configuration. */
void lowland_relay_destroy(struct lowland_relay *relay);

#ifdef __cplusplus
}
#endif

#endif
