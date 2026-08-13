// SPDX-License-Identifier: MIT

#define _POSIX_C_SOURCE 200809L

#include "relay.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define ORIGIN "http://127.0.0.1:43123"

static _Noreturn void fail(const char *message)
{
	fprintf(stderr, "library test failed: %s\n", message);
	exit(1);
}

static void send_all(int socket, const void *data, size_t length)
{
	const unsigned char *bytes = data;

	while (length) {
		ssize_t sent = send(socket, bytes, length, 0);

		if (sent < 0 && errno == EINTR)
			continue;
		if (sent <= 0)
			fail("socket send failed");
		bytes += sent;
		length -= (size_t)sent;
	}
}

static void read_exact(int socket, void *data, size_t length)
{
	unsigned char *bytes = data;

	while (length) {
		ssize_t received = recv(socket, bytes, length, 0);

		if (received < 0 && errno == EINTR)
			continue;
		if (received <= 0)
			fail("socket closed unexpectedly");
		bytes += received;
		length -= (size_t)received;
	}
}

static int connect_loopback(uint16_t port)
{
	struct sockaddr_in address = {
		.sin_family = AF_INET,
		.sin_port = htons(port),
	};
	struct timeval timeout = { .tv_sec = 2 };
	int socket_fd = socket(AF_INET, SOCK_STREAM, 0);

	if (socket_fd < 0)
		fail("could not create client socket");
	if (inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) != 1)
		fail("could not parse loopback address");
	setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
	if (connect(socket_fd, (struct sockaddr *)&address, sizeof(address)) < 0)
		fail("could not connect to loopback listener");
	return socket_fd;
}

static int websocket(uint16_t port, const char *origin, int expected_status)
{
	char request[1024], response[2048];
	size_t used = 0;
	int socket_fd = connect_loopback(port);
	int length = snprintf(request, sizeof(request),
		"GET / HTTP/1.1\r\n"
		"Host: 127.0.0.1:%u\r\n"
		"Upgrade: websocket\r\n"
		"Connection: Upgrade\r\n"
		"Sec-WebSocket-Version: 13\r\n"
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
		"Sec-WebSocket-Protocol: lowland-tcp-v1\r\n"
		"Origin: %s\r\n\r\n",
		port, origin);

	if (length <= 0 || (size_t)length >= sizeof(request))
		fail("handshake request overflow");
	send_all(socket_fd, request, (size_t)length);
	while (used + 1 < sizeof(response)) {
		ssize_t amount = recv(socket_fd, response + used, 1, 0);

		if (amount <= 0)
			break;
		used++;
		if (used >= 4 && memcmp(response + used - 4, "\r\n\r\n", 4) == 0)
			break;
	}
	response[used] = '\0';
	if (expected_status == 101 && strstr(response, " 101 ") == NULL)
		fail("valid WebSocket origin was rejected");
	if (expected_status != 101 && strstr(response, " 101 ") != NULL)
		fail("invalid WebSocket origin was accepted");
	return socket_fd;
}

static void websocket_send_binary(int socket_fd, const unsigned char *payload,
				  size_t length)
{
	const unsigned char mask[4] = { 0x12, 0x34, 0x56, 0x78 };
	unsigned char header[8], *message;
	size_t index, header_length;

	if (length < 126) {
		header[0] = 0x82;
		header[1] = 0x80 | (unsigned char)length;
		memcpy(header + 2, mask, sizeof(mask));
		header_length = 6;
	} else {
		fail("test WebSocket message is too large");
	}
	message = malloc(header_length + length);
	if (!message)
		fail("out of memory");
	memcpy(message, header, header_length);
	for (index = 0; index < length; index++)
		message[header_length + index] = payload[index] ^ mask[index & 3];
	send_all(socket_fd, message, header_length + length);
	free(message);
}

static size_t websocket_receive_binary(int socket_fd, unsigned char *payload,
				       size_t capacity)
{
	unsigned char header[4];
	size_t length;

	read_exact(socket_fd, header, 2);
	if (header[0] != 0x82 || (header[1] & 0x80))
		fail("invalid server WebSocket frame");
	length = header[1] & 0x7f;
	if (length == 126) {
		read_exact(socket_fd, header + 2, 2);
		length = (size_t)header[2] << 8 | header[3];
	}
	if (length > capacity)
		fail("server WebSocket message is too large");
	read_exact(socket_fd, payload, length);
	return length;
}

static void *run_relay(void *argument)
{
	if (lowland_relay_run(argument) != 0)
		fail("relay run loop failed");
	return NULL;
}

static int descriptor_count(void)
{
	int count = 0, descriptor;

	for (descriptor = 0; descriptor < 1024; descriptor++) {
		if (fcntl(descriptor, F_GETFD) >= 0 || errno != EBADF)
			count++;
	}
	return count;
}

static void one_lifecycle(void)
{
	const struct lowland_relay_publication publication = {
		.listen_address = "127.0.0.1",
		.host_port = 0,
		.guest_port = 8080,
	};
	const struct lowland_relay_config config = {
		.listen_address = "127.0.0.1",
		.listen_port = 0,
		.required_origin = ORIGIN,
		.publications = &publication,
		.publication_count = 1,
	};
	unsigned char message[64], bind[] = { 0x06, 0, 0, 0x1f, 0x90 };
	unsigned char accept_request[17] = { 0x07 };
	struct lowland_relay *relay;
	pthread_t relay_thread;
	uint16_t relay_port, published_port;
	char error[256], byte;
	int rejected, control, native, pending_native, flow;
	size_t length;

	relay = lowland_relay_create(&config, error, sizeof(error));
	if (!relay)
		fail(error);
	relay_port = lowland_relay_bound_port(relay);
	if (relay_port == 0)
		fail("ephemeral relay port was not reported");
	if (pthread_create(&relay_thread, NULL, run_relay, relay) != 0)
		fail("could not start relay thread");

	rejected = websocket(relay_port, "http://wrong.invalid", 0);
	close(rejected);
	control = websocket(relay_port, ORIGIN, 101);
	websocket_send_binary(control, bind, sizeof(bind));
	length = websocket_receive_binary(control, message, sizeof(message));
	if (length != 3 || message[0] != 0x83)
		fail("publication did not become bound");
	published_port = (uint16_t)message[1] << 8 | message[2];
	if (published_port == 0)
		fail("ephemeral publication port was not reported");

	native = connect_loopback(published_port);
	length = websocket_receive_binary(control, message, sizeof(message));
	if (length != 17 || message[0] != 0x84)
		fail("publication did not report an incoming connection");
	memcpy(accept_request + 1, message + 1, 16);
	flow = websocket(relay_port, ORIGIN, 101);
	websocket_send_binary(flow, accept_request, sizeof(accept_request));
	length = websocket_receive_binary(flow, message, sizeof(message));
	if (length != 1 || message[0] != 0x85)
		fail("incoming flow was not accepted");
	message[0] = 0x03;
	message[1] = 'x';
	websocket_send_binary(flow, message, 2);
	read_exact(native, &byte, 1);
	if (byte != 'x')
		fail("accepted flow did not carry data");
	pending_native = connect_loopback(published_port);
	length = websocket_receive_binary(control, message, sizeof(message));
	if (length != 17 || message[0] != 0x84)
		fail("publication did not retain a pending connection");

	lowland_relay_stop(relay);
	if (pthread_join(relay_thread, NULL) != 0)
		fail("could not join relay thread");
	if (recv(native, &byte, 1, 0) > 0)
		fail("active publication survived relay stop");
	if (recv(pending_native, &byte, 1, 0) > 0)
		fail("pending publication survived relay stop");
	close(flow);
	close(native);
	close(pending_native);
	close(control);
	lowland_relay_destroy(relay);
}

int main(void)
{
	int before = descriptor_count();

	one_lifecycle();
	one_lifecycle();
	if (descriptor_count() != before)
		fail("relay lifecycle leaked descriptors");
	puts("relay library lifecycle passed");
	return 0;
}
