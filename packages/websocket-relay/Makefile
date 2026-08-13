CC ?= cc
CFLAGS ?= -O2
CPPFLAGS ?=

.PHONY: all clean

all: lowland-websocket-relay

lowland-websocket-relay: relay.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c11 -D_POSIX_C_SOURCE=200809L \
		-Wall -Wextra -Werror -pthread -o $@ $<

clean:
	rm -f lowland-websocket-relay
