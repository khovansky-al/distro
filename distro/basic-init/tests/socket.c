#define _GNU_SOURCE

#include "test.h"

#include <arpa/inet.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

static void bring_up_loopback(void)
{
	struct ifreq request = { 0 };
	int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);

	if (fd == -1)
		test_perror("socket for loopback setup");
	strcpy(request.ifr_name, "lo");
	if (ioctl(fd, SIOCGIFFLAGS, &request) == -1)
		test_perror("get loopback flags");
	request.ifr_flags |= IFF_UP;
	if (ioctl(fd, SIOCSIFFLAGS, &request) == -1)
		test_perror("bring up loopback");
	close(fd);
}

static void expect_message(int fd, const char *expected)
{
	char buffer[32];
	ssize_t length = recv(fd, buffer, sizeof(buffer), 0);

	if (length == -1)
		test_perror("recv");
	if ((size_t)length != strlen(expected) ||
	    memcmp(buffer, expected, length) != 0)
		test_fail("unexpected socket data");
}

int main(void)
{
	static const char request[] = "request";
	static const char response[] = "response";
	struct sockaddr_in address = {
		.sin_family = AF_INET,
		.sin_addr.s_addr = htonl(INADDR_LOOPBACK),
	};
	socklen_t address_length = sizeof(address);
	int listener, client, server;

	bring_up_loopback();
	listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (listener == -1)
		test_perror("socket listener");
	if (bind(listener, (struct sockaddr *)&address, sizeof(address)) == -1)
		test_perror("bind");
	if (getsockname(listener, (struct sockaddr *)&address, &address_length) == -1)
		test_perror("getsockname");
	if (listen(listener, 1) == -1)
		test_perror("listen");

	client = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (client == -1)
		test_perror("socket client");
	if (connect(client, (struct sockaddr *)&address, sizeof(address)) == -1)
		test_perror("connect");
	server = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
	if (server == -1)
		test_perror("accept4");

	if (send(client, request, strlen(request), 0) != (ssize_t)strlen(request))
		test_perror("send request");
	expect_message(server, request);
	if (send(server, response, strlen(response), 0) != (ssize_t)strlen(response))
		test_perror("send response");
	expect_message(client, response);

	close(server);
	close(client);
	close(listener);
	test_pass();
}
