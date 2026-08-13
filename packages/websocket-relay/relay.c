// SPDX-License-Identifier: MIT

#define _POSIX_C_SOURCE 200809L

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define SUBPROTOCOL "lowland-tcp-v1"
#define WEBSOCKET_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
#define HTTP_LIMIT 16384
#define MESSAGE_LIMIT (1024 * 1024)
#define TCP_CHUNK 16384
#define SERVICE_LENGTH 32
#define CAPABILITY_LENGTH 16
#define MAX_PENDING_CONNECTIONS 64
#define PENDING_LIFETIME_SECONDS 45

enum opcode {
	OP_CONNECT = 0x01,
	OP_RESOLVE = 0x02,
	OP_DATA = 0x03,
	OP_FIN = 0x04,
	OP_RESET = 0x05,
	OP_BIND = 0x06,
	OP_ACCEPT = 0x07,
	OP_REJECT = 0x08,
	OP_CONNECTED = 0x81,
	OP_RESOLVED = 0x82,
	OP_BOUND = 0x83,
	OP_INCOMING = 0x84,
	OP_ACCEPTED = 0x85,
	OP_ERROR = 0xff,
};

static const char *required_origin;

struct publication;

struct publish_policy {
	char *address;
	unsigned int relay_port;
	unsigned int guest_port;
	struct publication *active;
	struct publish_policy *next;
};

struct pending_connection {
	unsigned char capability[CAPABILITY_LENGTH];
	int socket;
	int64_t expires_at;
	struct pending_connection *next;
};

struct active_flow {
	int socket;
	int websocket;
	struct active_flow *next;
};

struct publication {
	struct publish_policy *policy;
	int listener;
	int websocket;
	bool closed;
	unsigned int references;
	unsigned int pending_count;
	struct pending_connection *pending;
	struct active_flow *flows;
};

static pthread_mutex_t publications_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct publish_policy *publish_policies;

static int listen_socket(const char *host, const char *service);
static int bound_service(int fd, char service[SERVICE_LENGTH]);

struct sha1 {
	uint32_t state[5];
	uint64_t bytes;
	unsigned char block[64];
	size_t used;
};

static uint32_t rotate_left(uint32_t value, unsigned int bits)
{
	return (value << bits) | (value >> (32 - bits));
}

static void sha1_transform(struct sha1 *sha, const unsigned char block[64])
{
	uint32_t words[80], a, b, c, d, e;
	unsigned int index;

	for (index = 0; index < 16; index++) {
		words[index] = (uint32_t)block[index * 4] << 24 |
			       (uint32_t)block[index * 4 + 1] << 16 |
			       (uint32_t)block[index * 4 + 2] << 8 |
			       block[index * 4 + 3];
	}
	for (; index < 80; index++)
		words[index] = rotate_left(words[index - 3] ^ words[index - 8] ^
					   words[index - 14] ^ words[index - 16], 1);
	a = sha->state[0];
	b = sha->state[1];
	c = sha->state[2];
	d = sha->state[3];
	e = sha->state[4];
	for (index = 0; index < 80; index++) {
		uint32_t function, constant, temporary;

		if (index < 20) {
			function = (b & c) | (~b & d);
			constant = 0x5a827999;
		} else if (index < 40) {
			function = b ^ c ^ d;
			constant = 0x6ed9eba1;
		} else if (index < 60) {
			function = (b & c) | (b & d) | (c & d);
			constant = 0x8f1bbcdc;
		} else {
			function = b ^ c ^ d;
			constant = 0xca62c1d6;
		}
		temporary = rotate_left(a, 5) + function + e + constant + words[index];
		e = d;
		d = c;
		c = rotate_left(b, 30);
		b = a;
		a = temporary;
	}
	sha->state[0] += a;
	sha->state[1] += b;
	sha->state[2] += c;
	sha->state[3] += d;
	sha->state[4] += e;
}

static void sha1_init(struct sha1 *sha)
{
	*sha = (struct sha1){
		.state = { 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476,
			   0xc3d2e1f0 },
	};
}

static void sha1_update(struct sha1 *sha, const void *data, size_t length)
{
	const unsigned char *bytes = data;

	sha->bytes += length;
	while (length) {
		size_t amount = sizeof(sha->block) - sha->used;

		if (amount > length)
			amount = length;
		memcpy(sha->block + sha->used, bytes, amount);
		sha->used += amount;
		bytes += amount;
		length -= amount;
		if (sha->used == sizeof(sha->block)) {
			sha1_transform(sha, sha->block);
			sha->used = 0;
		}
	}
}

static void sha1_final(struct sha1 *sha, unsigned char digest[20])
{
	uint64_t bits = sha->bytes * 8;
	unsigned int index;

	sha->block[sha->used++] = 0x80;
	if (sha->used > 56) {
		memset(sha->block + sha->used, 0, 64 - sha->used);
		sha1_transform(sha, sha->block);
		sha->used = 0;
	}
	memset(sha->block + sha->used, 0, 56 - sha->used);
	for (index = 0; index < 8; index++)
		sha->block[63 - index] = bits >> (index * 8);
	sha1_transform(sha, sha->block);
	for (index = 0; index < 5; index++) {
		digest[index * 4] = sha->state[index] >> 24;
		digest[index * 4 + 1] = sha->state[index] >> 16;
		digest[index * 4 + 2] = sha->state[index] >> 8;
		digest[index * 4 + 3] = sha->state[index];
	}
}

static void base64(const unsigned char *input, size_t length, char *output)
{
	static const char alphabet[] =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	size_t source = 0, target = 0;

	while (source < length) {
		uint32_t value = (uint32_t)input[source++] << 16;
		bool second = source < length, third;

		if (second)
			value |= (uint32_t)input[source++] << 8;
		third = source < length;
		if (third)
			value |= input[source++];
		output[target++] = alphabet[value >> 18];
		output[target++] = alphabet[(value >> 12) & 63];
		output[target++] = second ? alphabet[(value >> 6) & 63] : '=';
		output[target++] = third ? alphabet[value & 63] : '=';
	}
	output[target] = '\0';
}

static int send_all(int fd, const void *data, size_t length)
{
	const unsigned char *bytes = data;

	while (length) {
#ifdef MSG_NOSIGNAL
		ssize_t sent = send(fd, bytes, length, MSG_NOSIGNAL);
#else
		ssize_t sent = send(fd, bytes, length, 0);
#endif
		if (sent < 0 && errno == EINTR)
			continue;
		if (sent <= 0)
			return -1;
		bytes += sent;
		length -= (size_t)sent;
	}
	return 0;
}

static int read_exact(int fd, void *data, size_t length)
{
	unsigned char *bytes = data;

	while (length) {
		ssize_t received = recv(fd, bytes, length, 0);

		if (received < 0 && errno == EINTR)
			continue;
		if (received <= 0)
			return -1;
		bytes += received;
		length -= (size_t)received;
	}
	return 0;
}

static bool equal_ascii(const char *left, size_t length, const char *right)
{
	return strlen(right) == length && strncasecmp(left, right, length) == 0;
}

static int header_value(const char *request, const char *name, char *value,
			size_t capacity)
{
	const char *line = strstr(request, "\r\n");

	if (!line)
		return -1;
	line += 2;
	while (*line && strncmp(line, "\r\n", 2) != 0) {
		const char *end = strstr(line, "\r\n");
		const char *colon;
		size_t length;

		if (!end)
			return -1;
		colon = memchr(line, ':', (size_t)(end - line));
		if (!colon)
			return -1;
		if (!equal_ascii(line, (size_t)(colon - line), name)) {
			line = end + 2;
			continue;
		}
		colon++;
		while (colon < end && (*colon == ' ' || *colon == '\t'))
			colon++;
		while (end > colon && (end[-1] == ' ' || end[-1] == '\t'))
			end--;
		length = (size_t)(end - colon);
		if (length + 1 > capacity)
			return -1;
		memcpy(value, colon, length);
		value[length] = '\0';
		return 0;
	}
	return -1;
}

static bool has_token(const char *list, const char *wanted)
{
	while (*list) {
		const char *end;
		size_t length;

		while (*list == ' ' || *list == '\t' || *list == ',')
			list++;
		end = strchr(list, ',');
		if (!end)
			end = list + strlen(list);
		while (end > list && (end[-1] == ' ' || end[-1] == '\t'))
			end--;
		length = (size_t)(end - list);
		if (equal_ascii(list, length, wanted))
			return true;
		list = *end ? end + 1 : end;
	}
	return false;
}

static int websocket_handshake(int fd)
{
	char request[HTTP_LIMIT + 1], key[256], upgrade[64], connection[256];
	char version[16], protocols[256], origin[1024], combined[512], accept[32];
	unsigned char digest[20];
	struct sha1 sha;
	size_t used = 0;
	int length;

	while (used < HTTP_LIMIT) {
		if (read_exact(fd, request + used, 1) < 0)
			return -1;
		used++;
		if (used >= 4 && memcmp(request + used - 4, "\r\n\r\n", 4) == 0)
			break;
	}
	if (used == HTTP_LIMIT)
		return -1;
	request[used] = '\0';
	if (strncmp(request, "GET ", 4) != 0 ||
	    header_value(request, "Upgrade", upgrade, sizeof(upgrade)) < 0 ||
	    strcasecmp(upgrade, "websocket") != 0 ||
	    header_value(request, "Connection", connection, sizeof(connection)) < 0 ||
	    !has_token(connection, "upgrade") ||
	    header_value(request, "Sec-WebSocket-Version", version, sizeof(version)) < 0 ||
	    strcmp(version, "13") != 0 ||
	    header_value(request, "Sec-WebSocket-Key", key, sizeof(key)) < 0 ||
	    header_value(request, "Sec-WebSocket-Protocol", protocols, sizeof(protocols)) < 0 ||
	    !has_token(protocols, SUBPROTOCOL))
		return -1;
	if (required_origin &&
	    (header_value(request, "Origin", origin, sizeof(origin)) < 0 ||
	     strcmp(origin, required_origin) != 0))
		return -1;
	if (snprintf(combined, sizeof(combined), "%s%s", key, WEBSOCKET_GUID) >=
	    (int)sizeof(combined))
		return -1;
	sha1_init(&sha);
	sha1_update(&sha, combined, strlen(combined));
	sha1_final(&sha, digest);
	base64(digest, sizeof(digest), accept);
	length = snprintf(request, sizeof(request),
			  "HTTP/1.1 101 Switching Protocols\r\n"
			  "Upgrade: websocket\r\n"
			  "Connection: Upgrade\r\n"
			  "Sec-WebSocket-Accept: %s\r\n"
			  "Sec-WebSocket-Protocol: %s\r\n\r\n",
			  accept, SUBPROTOCOL);
	return length > 0 && (size_t)length < sizeof(request) ?
		       send_all(fd, request, (size_t)length) : -1;
}

static int websocket_send(int fd, unsigned int opcode, const void *payload,
			  size_t length)
{
	unsigned char header[10];
	size_t header_length;

	header[0] = 0x80 | opcode;
	if (length < 126) {
		header[1] = (unsigned char)length;
		header_length = 2;
	} else if (length <= 0xffff) {
		header[1] = 126;
		header[2] = length >> 8;
		header[3] = length;
		header_length = 4;
	} else {
		unsigned int index;
		uint64_t encoded_length = length;

		header[1] = 127;
		for (index = 0; index < 8; index++)
			header[9 - index] = encoded_length >> (index * 8);
		header_length = 10;
	}
	return send_all(fd, header, header_length) < 0 ||
		       (length && send_all(fd, payload, length) < 0) ? -1 : 0;
}

static int append_message(unsigned char **message, size_t *length,
			  const unsigned char *part, size_t part_length)
{
	unsigned char *grown;

	if (!part_length)
		return 0;
	if (part_length > MESSAGE_LIMIT - *length)
		return -1;
	grown = realloc(*message, *length + part_length);
	if (!grown)
		return -1;
	*message = grown;
	memcpy(*message + *length, part, part_length);
	*length += part_length;
	return 0;
}

static int websocket_read(int fd, unsigned char **result, size_t *result_length)
{
	unsigned char *message = NULL;
	size_t message_length = 0;
	bool fragmented = false;

	for (;;) {
		unsigned char header[2], mask[4], *payload = NULL;
		uint64_t length;
		unsigned int opcode, index;
		bool final, control;

		if (read_exact(fd, header, sizeof(header)) < 0)
			goto failure;
		final = (header[0] & 0x80) != 0;
		opcode = header[0] & 0x0f;
		control = (opcode & 0x08) != 0;
		if ((header[0] & 0x70) != 0 || (header[1] & 0x80) == 0)
			goto failure;
		length = header[1] & 0x7f;
		if (length == 126) {
			unsigned char extended[2];

			if (read_exact(fd, extended, sizeof(extended)) < 0)
				goto failure;
			length = (uint64_t)extended[0] << 8 | extended[1];
		} else if (length == 127) {
			unsigned char extended[8];

			if (read_exact(fd, extended, sizeof(extended)) < 0 || extended[0] & 0x80)
				goto failure;
			length = 0;
			for (index = 0; index < 8; index++)
				length = length << 8 | extended[index];
		}
		if (length > MESSAGE_LIMIT || (control && (!final || length > 125)) ||
		    read_exact(fd, mask, sizeof(mask)) < 0)
			goto failure;
		payload = malloc(length ? (size_t)length : 1);
		if (!payload || (length && read_exact(fd, payload, (size_t)length) < 0)) {
			free(payload);
			goto failure;
		}
		for (index = 0; index < length; index++)
			payload[index] ^= mask[index & 3];
		if (opcode == 0x8) {
			free(payload);
			free(message);
			return 0;
		}
		if (opcode == 0x9) {
			int status = websocket_send(fd, 0xa, payload, (size_t)length);
			free(payload);
			if (status < 0)
				goto failure;
			continue;
		}
		if (opcode == 0xa) {
			free(payload);
			continue;
		}
		if (opcode == 0x2 && !fragmented) {
			fragmented = !final;
		} else if (opcode != 0 || !fragmented) {
			free(payload);
			goto failure;
		}
		if (append_message(&message, &message_length, payload, (size_t)length) < 0) {
			free(payload);
			goto failure;
		}
		free(payload);
		if (!final)
			continue;
		*result = message;
		*result_length = message_length;
		return 1;
	}

failure:
	free(message);
	return -1;
}

static int protocol_message(int fd, unsigned int opcode, const void *payload,
			    size_t length)
{
	unsigned char *message = malloc(length + 1);
	int status;

	if (!message)
		return -1;
	message[0] = opcode;
	if (length)
		memcpy(message + 1, payload, length);
	status = websocket_send(fd, 0x2, message, length + 1);
	free(message);
	return status;
}

static int protocol_error(int fd, const char *message)
{
	return protocol_message(fd, OP_ERROR, message, strlen(message));
}

static char *message_host(const unsigned char *message, size_t offset,
			  size_t length)
{
	char *host;

	if (length <= offset || memchr(message + offset, '\0', length - offset))
		return NULL;
	host = malloc(length - offset + 1);
	if (!host)
		return NULL;
	memcpy(host, message + offset, length - offset);
	host[length - offset] = '\0';
	return host;
}

static int resolve_request(int fd, const unsigned char *message, size_t length)
{
	struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_STREAM };
	struct addrinfo *addresses = NULL, *current;
	unsigned char response[1 + 32 * 4] = { OP_RESOLVED };
	size_t used = 1;
	char *host = message_host(message, 1, length);
	int error;

	if (!host)
		return protocol_error(fd, "invalid DNS request");
	error = getaddrinfo(host, NULL, &hints, &addresses);
	free(host);
	if (error)
		return protocol_error(fd, gai_strerror(error));
	for (current = addresses; current && used + 4 <= sizeof(response);
	     current = current->ai_next) {
		const struct sockaddr_in *address = (const struct sockaddr_in *)current->ai_addr;
		bool duplicate = false;
		size_t offset;

		for (offset = 1; offset < used; offset += 4) {
			if (memcmp(response + offset, &address->sin_addr, 4) == 0) {
				duplicate = true;
				break;
			}
		}
		if (!duplicate) {
			memcpy(response + used, &address->sin_addr, 4);
			used += 4;
		}
	}
	freeaddrinfo(addresses);
	return used == 1 ? protocol_error(fd, "hostname has no IPv4 addresses") :
			 websocket_send(fd, 0x2, response, used);
}

static int connect_socket(const char *host, unsigned int port)
{
	struct addrinfo hints = { .ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM };
	struct addrinfo *addresses = NULL, *current;
	char service[6];
	int fd = -1;

	snprintf(service, sizeof(service), "%u", port);
	if (getaddrinfo(host, service, &hints, &addresses))
		return -1;
	for (current = addresses; current; current = current->ai_next) {
		fd = socket(current->ai_family, current->ai_socktype, current->ai_protocol);
		if (fd < 0)
			continue;
#ifdef SO_NOSIGPIPE
		{
			int enabled = 1;
			setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
		}
#endif
		if (connect(fd, current->ai_addr, current->ai_addrlen) == 0)
			break;
		close(fd);
		fd = -1;
	}
	freeaddrinfo(addresses);
	return fd;
}

static int relay_socket(int websocket, int upstream, unsigned int ready_opcode)
{
	unsigned char buffer[TCP_CHUNK];
	bool websocket_finished = false, upstream_finished = false;

	if (protocol_message(websocket, ready_opcode, NULL, 0) < 0)
		goto failure;
	while (!websocket_finished || !upstream_finished) {
		fd_set readable;
		int maximum = websocket > upstream ? websocket : upstream;

		FD_ZERO(&readable);
		/* Keep watching transport closure or RESET after a TCP half-close. */
		FD_SET(websocket, &readable);
		if (!upstream_finished)
			FD_SET(upstream, &readable);
		if (select(maximum + 1, &readable, NULL, NULL, NULL) < 0) {
			if (errno == EINTR)
				continue;
			goto failure;
		}
		if (FD_ISSET(websocket, &readable)) {
			unsigned char *message = NULL;
			size_t message_length = 0;
			int status = websocket_read(websocket, &message, &message_length);

			if (status <= 0) {
				free(message);
				goto failure;
			}
			if (!websocket_finished && message_length && message[0] == OP_DATA) {
				status = send_all(upstream, message + 1, message_length - 1);
			} else if (!websocket_finished && message_length == 1 &&
				   message[0] == OP_FIN) {
				status = shutdown(upstream, SHUT_WR);
				websocket_finished = true;
			} else if (message_length == 1 && message[0] == OP_RESET) {
				free(message);
				goto failure;
			} else {
				status = -1;
			}
			free(message);
			if (status < 0)
				goto failure;
		}
		if (!upstream_finished && FD_ISSET(upstream, &readable)) {
			ssize_t received = recv(upstream, buffer, sizeof(buffer), 0);

			if (received < 0 && errno == EINTR)
				continue;
			if (received < 0) {
				protocol_message(websocket, OP_RESET, NULL, 0);
				goto failure;
			}
			if (received == 0) {
				if (protocol_message(websocket, OP_FIN, NULL, 0) < 0)
					goto failure;
				upstream_finished = true;
			} else if (protocol_message(websocket, OP_DATA, buffer,
						    (size_t)received) < 0) {
				goto failure;
			}
		}
	}
	return 0;

failure:
	return -1;
}

static int relay_tcp(int websocket, const unsigned char *request, size_t length)
{
	unsigned int port;
	char *host;
	int upstream;

	if (length < 4 || (port = (unsigned int)request[1] << 8 | request[2]) == 0 ||
	    !(host = message_host(request, 3, length)))
		return protocol_error(websocket, "invalid CONNECT request");
	upstream = connect_socket(host, port);
	free(host);
	if (upstream < 0)
		return protocol_error(websocket, "upstream TCP connection failed");
	{
		int status = relay_socket(websocket, upstream, OP_CONNECTED);

		close(upstream);
		return status;
	}
}

static int random_capability(unsigned char capability[CAPABILITY_LENGTH])
{
	int random = open("/dev/urandom", O_RDONLY);
	size_t used = 0;

	if (random < 0)
		return -1;
	while (used < CAPABILITY_LENGTH) {
		ssize_t amount = read(random, capability + used,
				      CAPABILITY_LENGTH - used);

		if (amount < 0 && errno == EINTR)
			continue;
		if (amount <= 0) {
			close(random);
			return -1;
		}
		used += (size_t)amount;
	}
	close(random);
	return 0;
}

static int64_t monotonic_milliseconds(void)
{
	struct timespec now;

	if (clock_gettime(CLOCK_MONOTONIC, &now) == 0)
		return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
	return (int64_t)time(NULL) * 1000;
}

static bool capability_exists_locked(const unsigned char capability[CAPABILITY_LENGTH])
{
	struct publish_policy *policy;

	for (policy = publish_policies; policy; policy = policy->next) {
		struct pending_connection *pending;

		if (!policy->active)
			continue;
		for (pending = policy->active->pending; pending; pending = pending->next) {
			if (memcmp(pending->capability, capability, CAPABILITY_LENGTH) == 0)
				return true;
		}
	}
	return false;
}

static void release_publication_locked(struct publication *publication)
{
	publication->references--;
	if (publication->references == 0)
		free(publication);
}

static void close_publication(struct publication *publication)
{
	struct pending_connection *pending;
	struct active_flow *flow;

	pthread_mutex_lock(&publications_mutex);
	if (publication->closed) {
		pthread_mutex_unlock(&publications_mutex);
		return;
	}
	publication->closed = true;
	if (publication->listener >= 0) {
		close(publication->listener);
		publication->listener = -1;
	}
	if (publication->policy->active == publication)
		publication->policy->active = NULL;
	pending = publication->pending;
	publication->pending = NULL;
	publication->pending_count = 0;
	while (pending) {
		struct pending_connection *next = pending->next;

		close(pending->socket);
		free(pending);
		pending = next;
	}
	for (flow = publication->flows; flow; flow = flow->next) {
		shutdown(flow->socket, SHUT_RDWR);
		shutdown(flow->websocket, SHUT_RDWR);
	}
	release_publication_locked(publication);
	pthread_mutex_unlock(&publications_mutex);
}

static void remove_active_flow(struct publication *publication,
			       struct active_flow *flow)
{
	struct active_flow **link;

	pthread_mutex_lock(&publications_mutex);
	for (link = &publication->flows; *link && *link != flow; link = &(*link)->next)
		;
	if (*link == flow) {
		*link = flow->next;
		release_publication_locked(publication);
	}
	pthread_mutex_unlock(&publications_mutex);
}

static struct publication *claim_pending(
	const unsigned char capability[CAPABILITY_LENGTH], struct active_flow *flow)
{
	struct publish_policy *policy;
	int64_t now = monotonic_milliseconds();

	pthread_mutex_lock(&publications_mutex);
	for (policy = publish_policies; policy; policy = policy->next) {
		struct publication *publication = policy->active;
		struct pending_connection **link;

		if (!publication || publication->closed)
			continue;
		for (link = &publication->pending; *link; link = &(*link)->next) {
			struct pending_connection *pending = *link;

			if (memcmp(pending->capability, capability,
				   CAPABILITY_LENGTH) != 0)
				continue;
			*link = pending->next;
			publication->pending_count--;
			if (pending->expires_at <= now) {
				close(pending->socket);
				free(pending);
				pthread_mutex_unlock(&publications_mutex);
				return NULL;
			}
			flow->socket = pending->socket;
			flow->next = publication->flows;
			publication->flows = flow;
			publication->references++;
			free(pending);
			pthread_mutex_unlock(&publications_mutex);
			return publication;
		}
	}
	pthread_mutex_unlock(&publications_mutex);
	return NULL;
}

static bool reject_pending(struct publication *publication,
			   const unsigned char capability[CAPABILITY_LENGTH])
{
	struct pending_connection **link;

	pthread_mutex_lock(&publications_mutex);
	for (link = &publication->pending; *link; link = &(*link)->next) {
		struct pending_connection *pending = *link;

		if (memcmp(pending->capability, capability, CAPABILITY_LENGTH) != 0)
			continue;
		*link = pending->next;
		publication->pending_count--;
		close(pending->socket);
		free(pending);
		pthread_mutex_unlock(&publications_mutex);
		return true;
	}
	pthread_mutex_unlock(&publications_mutex);
	return false;
}

static void expire_pending(struct publication *publication)
{
	struct pending_connection **link;
	int64_t now = monotonic_milliseconds();

	pthread_mutex_lock(&publications_mutex);
	for (link = &publication->pending; *link;) {
		struct pending_connection *pending = *link;

		if (pending->expires_at > now) {
			link = &pending->next;
			continue;
		}
		*link = pending->next;
		publication->pending_count--;
		close(pending->socket);
		free(pending);
	}
	pthread_mutex_unlock(&publications_mutex);
}

static int queue_incoming(struct publication *publication)
{
	struct pending_connection *pending;
	unsigned char message[1 + CAPABILITY_LENGTH];
	int incoming = accept(publication->listener, NULL, NULL);

	if (incoming < 0)
		return errno == EINTR ? 0 : -1;
#ifdef SO_NOSIGPIPE
	{
		int enabled = 1;
		setsockopt(incoming, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
	}
#endif
	pending = calloc(1, sizeof(*pending));
	if (!pending) {
		close(incoming);
		return 0;
	}
	pending->socket = incoming;
	pending->expires_at = monotonic_milliseconds() +
			      PENDING_LIFETIME_SECONDS * 1000;
	if (random_capability(pending->capability) < 0) {
		close(incoming);
		free(pending);
		return 0;
	}
	pthread_mutex_lock(&publications_mutex);
	if (publication->closed ||
	    publication->pending_count >= MAX_PENDING_CONNECTIONS ||
	    capability_exists_locked(pending->capability)) {
		pthread_mutex_unlock(&publications_mutex);
		close(incoming);
		free(pending);
		return 0;
	}
	pending->next = publication->pending;
	publication->pending = pending;
	publication->pending_count++;
	message[0] = OP_INCOMING;
	memcpy(message + 1, pending->capability, CAPABILITY_LENGTH);
	pthread_mutex_unlock(&publications_mutex);
	return websocket_send(publication->websocket, 0x2, message, sizeof(message));
}

static int relay_accepted(int websocket, const unsigned char *request, size_t length)
{
	struct active_flow flow = { .websocket = websocket };
	struct publication *publication;
	int status;

	if (length != 1 + CAPABILITY_LENGTH)
		return protocol_error(websocket, "invalid ACCEPT request");
	publication = claim_pending(request + 1, &flow);
	if (!publication)
		return protocol_error(websocket, "pending connection is unavailable");
	status = relay_socket(websocket, flow.socket, OP_ACCEPTED);
	remove_active_flow(publication, &flow);
	close(flow.socket);
	return status;
}

static int relay_bind(int websocket, const unsigned char *request, size_t length)
{
	struct publication *publication;
	struct publish_policy *policy;
	unsigned int relay_port, guest_port, effective_port;
	unsigned char response[3] = { OP_BOUND };
	char service[SERVICE_LENGTH];
	int status = 0;

	if (length != 5)
		return protocol_error(websocket, "invalid BIND request");
	relay_port = (unsigned int)request[1] << 8 | request[2];
	guest_port = (unsigned int)request[3] << 8 | request[4];
	if (guest_port == 0)
		return protocol_error(websocket, "invalid BIND request");
	publication = calloc(1, sizeof(*publication));
	if (!publication)
		return protocol_error(websocket, "relay is out of memory");
	publication->listener = -1;
	publication->websocket = websocket;
	publication->references = 1;
	pthread_mutex_lock(&publications_mutex);
	for (policy = publish_policies; policy; policy = policy->next) {
		if (policy->relay_port == relay_port && policy->guest_port == guest_port)
			break;
	}
	if (!policy || policy->active) {
		pthread_mutex_unlock(&publications_mutex);
		free(publication);
		return protocol_error(websocket,
			policy ? "publication is already active" :
				 "requested publication is not approved");
	}
	publication->policy = policy;
	policy->active = publication;
	pthread_mutex_unlock(&publications_mutex);

	snprintf(service, sizeof(service), "%u", relay_port);
	publication->listener = listen_socket(policy->address, service);
	if (publication->listener < 0 ||
	    bound_service(publication->listener, service) != 0) {
		close_publication(publication);
		return protocol_error(websocket, "approved TCP listener could not be bound");
	}
	effective_port = (unsigned int)strtoul(service, NULL, 10);
	if (effective_port == 0 || effective_port > 65535) {
		close_publication(publication);
		return protocol_error(websocket, "relay returned an invalid listener port");
	}
	response[1] = effective_port >> 8;
	response[2] = effective_port;
	if (websocket_send(websocket, 0x2, response, sizeof(response)) < 0) {
		close_publication(publication);
		return -1;
	}

	for (;;) {
		fd_set readable;
		struct timeval timeout = { .tv_sec = 1 };
		int maximum = websocket > publication->listener ?
			      websocket : publication->listener;
		int selected;

		expire_pending(publication);
		FD_ZERO(&readable);
		FD_SET(websocket, &readable);
		FD_SET(publication->listener, &readable);
		selected = select(maximum + 1, &readable, NULL, NULL, &timeout);
		if (selected < 0) {
			if (errno == EINTR)
				continue;
			status = -1;
			break;
		}
		if (selected == 0)
			continue;
		if (FD_ISSET(publication->listener, &readable) &&
		    queue_incoming(publication) < 0) {
			status = -1;
			break;
		}
		if (FD_ISSET(websocket, &readable)) {
			unsigned char *message = NULL;
			size_t message_length = 0;
			int read_status = websocket_read(websocket, &message,
							 &message_length);

			if (read_status <= 0) {
				free(message);
				status = read_status;
				break;
			}
			if (message_length != 1 + CAPABILITY_LENGTH ||
			    message[0] != OP_REJECT) {
				protocol_error(websocket, "invalid REJECT request");
				free(message);
				status = -1;
				break;
			}
			/* Expiry can race a delayed guest refusal; REJECT is idempotent. */
			reject_pending(publication, message + 1);
			free(message);
		}
	}
	close_publication(publication);
	return status;
}

static void *serve_client(void *argument)
{
	int fd = (int)(intptr_t)argument;
	unsigned char *message = NULL;
	size_t length = 0;

#ifdef SO_NOSIGPIPE
	{
		int enabled = 1;
		setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
	}
#endif
	if (websocket_handshake(fd) < 0 || websocket_read(fd, &message, &length) <= 0 ||
	    length == 0)
		goto done;
	if (message[0] == OP_RESOLVE)
		resolve_request(fd, message, length);
	else if (message[0] == OP_CONNECT)
		relay_tcp(fd, message, length);
	else if (message[0] == OP_BIND)
		relay_bind(fd, message, length);
	else if (message[0] == OP_ACCEPT)
		relay_accepted(fd, message, length);
	else
		protocol_error(fd, "unsupported initial opcode");

done:
	free(message);
	websocket_send(fd, 0x8, NULL, 0);
	close(fd);
	return NULL;
}

static int listen_socket(const char *host, const char *service)
{
	struct addrinfo hints = {
		.ai_family = AF_UNSPEC,
		.ai_socktype = SOCK_STREAM,
		.ai_flags = AI_PASSIVE,
	};
	struct addrinfo *addresses = NULL, *current;
	int fd = -1, enabled = 1;

	if (getaddrinfo(host, service, &hints, &addresses))
		return -1;
	for (current = addresses; current; current = current->ai_next) {
		fd = socket(current->ai_family, current->ai_socktype, current->ai_protocol);
		if (fd < 0)
			continue;
		setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled));
		if (bind(fd, current->ai_addr, current->ai_addrlen) == 0 && listen(fd, 64) == 0)
			break;
		close(fd);
		fd = -1;
	}
	freeaddrinfo(addresses);
	return fd;
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

static int parse_port_range(const char *start, size_t length, bool allow_zero,
			    unsigned int *result)
{
	unsigned long value = 0;
	size_t index;

	if (length == 0)
		return -1;
	for (index = 0; index < length; index++) {
		if (start[index] < '0' || start[index] > '9')
			return -1;
		value = value * 10 + (unsigned int)(start[index] - '0');
		if (value > 65535)
			return -1;
	}
	if (!allow_zero && value == 0)
		return -1;
	*result = (unsigned int)value;
	return 0;
}

static int add_publish_policy(const char *mapping)
{
	const char *address_start = "127.0.0.1", *relay_start, *guest_start;
	const char *first, *second;
	size_t address_length = strlen(address_start), relay_length;
	struct publish_policy *policy, *current;

	if (mapping[0] == '[') {
		const char *closing = strchr(mapping + 1, ']');

		if (!closing || closing == mapping + 1 || closing[1] != ':')
			return -1;
		address_start = mapping + 1;
		address_length = (size_t)(closing - address_start);
		relay_start = closing + 2;
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
			relay_start = first + 1;
		} else {
			relay_start = mapping;
		}
	}
	first = strchr(relay_start, ':');
	if (!first || strchr(first + 1, ':'))
		return -1;
	relay_length = (size_t)(first - relay_start);
	guest_start = first + 1;
	policy = calloc(1, sizeof(*policy));
	if (!policy)
		return -1;
	policy->address = copy_range(address_start, address_length);
	if (!policy->address ||
	    parse_port_range(relay_start, relay_length, true, &policy->relay_port) < 0 ||
	    parse_port_range(guest_start, strlen(guest_start), false,
			     &policy->guest_port) < 0) {
		free(policy->address);
		free(policy);
		return -1;
	}
	for (current = publish_policies; current; current = current->next) {
		/* BIND selects by port pair; requiring uniqueness keeps address policy exact. */
		if (current->relay_port == policy->relay_port &&
		    current->guest_port == policy->guest_port) {
			free(policy->address);
			free(policy);
			return -1;
		}
	}
	policy->next = publish_policies;
	publish_policies = policy;
	return 0;
}

static void usage(const char *program)
{
	fprintf(stderr,
		"usage: %s [--listen ADDRESS] [--port PORT] [--origin URL] "
		"[--publish [ADDRESS:]RELAY_PORT:GUEST_PORT]...\n",
		program);
}

static int bound_service(int fd, char service[SERVICE_LENGTH])
{
	struct sockaddr_storage address;
	socklen_t length = sizeof(address);

	return getsockname(fd, (struct sockaddr *)&address, &length) < 0 ? -1 :
		       getnameinfo((struct sockaddr *)&address, length, NULL, 0, service,
				   SERVICE_LENGTH, NI_NUMERICSERV);
}

int main(int argc, char **argv)
{
	const char *host = "127.0.0.1", *port = "8080";
	char service[SERVICE_LENGTH];
	int listener, index;

	for (index = 1; index < argc; index++) {
		if (index + 1 == argc) {
			usage(argv[0]);
			return 2;
		}
		if (strcmp(argv[index], "--listen") == 0)
			host = argv[++index];
		else if (strcmp(argv[index], "--port") == 0)
			port = argv[++index];
		else if (strcmp(argv[index], "--origin") == 0)
			required_origin = argv[++index];
		else if (strcmp(argv[index], "--publish") == 0) {
			if (add_publish_policy(argv[++index]) < 0) {
				fprintf(stderr, "invalid --publish mapping: %s\n", argv[index]);
				return 2;
			}
		}
		else {
			usage(argv[0]);
			return 2;
		}
	}
#ifdef SIGPIPE
	signal(SIGPIPE, SIG_IGN);
#endif
	listener = listen_socket(host, port);
	if (listener < 0) {
		perror("listen");
		return 1;
	}
	if (bound_service(listener, service) != 0) {
		perror("getsockname");
		close(listener);
		return 1;
	}
	printf(strchr(host, ':') ? "Listening on ws://[%s]:%s/\n" :
				  "Listening on ws://%s:%s/\n",
	       host, service);
	fflush(stdout);
	for (;;) {
		pthread_t thread;
		int client = accept(listener, NULL, NULL);

		if (client < 0) {
			if (errno == EINTR)
				continue;
			perror("accept");
			break;
		}
		if (pthread_create(&thread, NULL, serve_client,
				   (void *)(intptr_t)client) != 0) {
			close(client);
			continue;
		}
		pthread_detach(thread);
	}
	close(listener);
	return 1;
}
