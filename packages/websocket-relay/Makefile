CC ?= cc
CFLAGS ?= -O2
CPPFLAGS ?=

.PHONY: all clean test

all: lowland-websocket-relay liblowland-websocket-relay.a

relay.o: relay.c relay.h
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c11 -D_POSIX_C_SOURCE=200809L \
		-Wall -Wextra -Werror -pthread -c -o $@ relay.c

main.o: main.c relay.h
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c11 -D_POSIX_C_SOURCE=200809L \
		-Wall -Wextra -Werror -pthread -c -o $@ main.c

liblowland-websocket-relay.a: relay.o
	ar rcs $@ $<

lowland-websocket-relay: main.o liblowland-websocket-relay.a
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c11 -D_POSIX_C_SOURCE=200809L \
		-Wall -Wextra -Werror -pthread -o $@ main.o liblowland-websocket-relay.a

library-test: library-test.c relay.h liblowland-websocket-relay.a
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c11 -D_POSIX_C_SOURCE=200809L \
		-Wall -Wextra -Werror -pthread -o $@ library-test.c liblowland-websocket-relay.a

test: library-test
	./library-test

clean:
	rm -f lowland-websocket-relay liblowland-websocket-relay.a library-test main.o relay.o
