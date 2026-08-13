// SPDX-License-Identifier: MIT

#include "relay.h"

#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void usage(const char *program)
{
	fprintf(stderr,
		"usage: %s [--listen ADDRESS] [--port PORT] [--origin URL] "
		"[--publish [ADDRESS:]RELAY_PORT:GUEST_PORT]...\n",
		program);
}

static int parse_port(const char *text, bool allow_zero, uint16_t *result)
{
	char *end;
	unsigned long value;

	errno = 0;
	value = strtoul(text, &end, 10);
	if (errno || !text[0] || *end || value > 65535 || (!allow_zero && value == 0))
		return -1;
	*result = (uint16_t)value;
	return 0;
}

static char *copy_range(const char *start, size_t length)
{
	char *copy = malloc(length + 1);

	if (!copy)
		return NULL;
	memcpy(copy, start, length);
	copy[length] = '\0';
	return copy;
}

static int parse_publication(const char *mapping,
			     struct lowland_relay_publication *publication)
{
	const char *address_start = "127.0.0.1", *host_start, *guest_start;
	const char *first, *second;
	size_t address_length = strlen(address_start), host_length;
	char *address, *host_text, *guest_text;
	int status = -1;

	if (mapping[0] == '[') {
		const char *closing = strchr(mapping + 1, ']');

		if (!closing || closing == mapping + 1 || closing[1] != ':')
			return -1;
		address_start = mapping + 1;
		address_length = (size_t)(closing - address_start);
		host_start = closing + 2;
	} else {
		first = strchr(mapping, ':');
		if (!first)
			return -1;
		second = strchr(first + 1, ':');
		if (second) {
			if (first == mapping || strchr(second + 1, ':'))
				return -1;
			address_start = mapping;
			address_length = (size_t)(first - mapping);
			host_start = first + 1;
		} else {
			host_start = mapping;
		}
	}
	first = strchr(host_start, ':');
	if (!first || strchr(first + 1, ':'))
		return -1;
	host_length = (size_t)(first - host_start);
	guest_start = first + 1;
	address = copy_range(address_start, address_length);
	host_text = copy_range(host_start, host_length);
	guest_text = copy_range(guest_start, strlen(guest_start));
	if (address && host_text && guest_text &&
	    parse_port(host_text, true, &publication->host_port) == 0 &&
	    parse_port(guest_text, false, &publication->guest_port) == 0) {
		publication->listen_address = address;
		address = NULL;
		status = 0;
	}
	free(address);
	free(host_text);
	free(guest_text);
	return status;
}

int main(int argc, char **argv)
{
	struct lowland_relay_config config = {
		.listen_address = "127.0.0.1",
		.listen_port = 8080,
	};
	struct lowland_relay_publication *publications = NULL;
	struct lowland_relay *relay;
	char error[256];
	size_t publication_count = 0;
	int index, status;

	for (index = 1; index < argc; index++) {
		if (index + 1 == argc) {
			usage(argv[0]);
			status = 2;
			goto done;
		}
		if (strcmp(argv[index], "--listen") == 0) {
			config.listen_address = argv[++index];
		} else if (strcmp(argv[index], "--port") == 0) {
			if (parse_port(argv[++index], true, &config.listen_port) < 0) {
				usage(argv[0]);
				status = 2;
				goto done;
			}
		} else if (strcmp(argv[index], "--origin") == 0) {
			config.required_origin = argv[++index];
		} else if (strcmp(argv[index], "--publish") == 0) {
			struct lowland_relay_publication *grown;

			grown = realloc(publications,
					(publication_count + 1) * sizeof(*publications));
			if (!grown) {
				fprintf(stderr, "out of memory\n");
				status = 1;
				goto done;
			}
			publications = grown;
			memset(&publications[publication_count], 0,
			       sizeof(publications[publication_count]));
			if (parse_publication(argv[++index],
					      &publications[publication_count]) < 0) {
				fprintf(stderr, "invalid --publish mapping: %s\n", argv[index]);
				status = 2;
				goto done;
			}
			publication_count++;
		} else {
			usage(argv[0]);
			status = 2;
			goto done;
		}
	}
	config.publications = publications;
	config.publication_count = publication_count;
#ifdef SIGPIPE
	signal(SIGPIPE, SIG_IGN);
#endif
	relay = lowland_relay_create(&config, error, sizeof(error));
	if (!relay) {
		fprintf(stderr, "%s\n", error);
		status = 1;
		goto done;
	}
	printf(strchr(config.listen_address, ':') ? "Listening on ws://[%s]:%u/\n" :
						   "Listening on ws://%s:%u/\n",
	       config.listen_address, lowland_relay_bound_port(relay));
	fflush(stdout);
	status = lowland_relay_run(relay) == 0 ? 0 : 1;
	lowland_relay_destroy(relay);

done:
	for (index = 0; index < (int)publication_count; index++)
		free((void *)publications[index].listen_address);
	free(publications);
	return status;
}
