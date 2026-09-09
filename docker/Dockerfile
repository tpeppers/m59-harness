# Meridian 59 server (blakserv) — portable Linux container.
#
# Builds blakcomp, compiles the Blakod, and builds blakserv from source. No
# Windows toolchain and no prebuilt artifacts, so this runs anywhere docker
# does — Windows with Docker Desktop, Linux, a Steam Deck.
#
# The build context is the SERVER SOURCE TREE, not this repository:
#
#   docker build -f docker/Dockerfile -t m59-blakserv:local /path/to/Meridian59
#
# It works unmodified against either tree, because both lay their sources out
# the same way:
#
#   https://github.com/Meridian59/Meridian59        upstream, public
#   https://github.com/tpeppers/Meridian59-deck     fork with gamepad + Deck support
#
# Ports: 5959 game, 9998 maintenance (the admin socket — publish it on loopback
# only, because it is authenticated by IP mask alone and has no password).

# ---------------------------------------------------------------- build

FROM debian:bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential flex bison make ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . /src

# fmtlib is an external dependency the upstream tree ships in external/fmtlib/
# but which is absent from a plain git clone. Download the header-only subset
# needed to compile blakserv (only fmt/format.h and its includes are used).
RUN if [ ! -f external/fmtlib/fmt/format.h ]; then \
      mkdir -p external/fmtlib && \
      curl -fsSL https://github.com/fmtlib/fmt/archive/refs/tags/10.2.1.tar.gz \
        | tar -xz --strip-components=1 -C external/fmtlib fmt-10.2.1/include/fmt; \
      mv external/fmtlib/include/fmt external/fmtlib/fmt && \
      rm -rf external/fmtlib/include; \
    fi

# The tree is built with -Werror, which is a reasonable policy for the project
# and a bad one for a portability build on whatever g++ the base image ships.
# Warnings here are not the project's finding; a failed build would just be noise.
RUN sed -i 's/ -Werror//' common.mak.linux

# MAKE THE OUTPUT DIRECTORIES BEFORE BUILDING IN PARALLEL.
#
# Both makefiles read `all : makedirs $(OUTDIR)/<target>`, and prerequisites of
# one rule are not ordered relative to each other — so under -j, `mkdir -p
# release/` races the first compile. It usually wins. When it does not, flex
# reports "could not create release/lexyy.c" and the build fails somewhere that
# has nothing to do with what you changed. Running makedirs to completion first
# costs nothing and removes the race, without giving up the parallel build.

# blakcomp produces bc, the Blakod compiler.
RUN make -C blakcomp -f makefile.linux RELEASE=1 makedirs \
 && make -C blakcomp -f makefile.linux RELEASE=1 -j"$(nproc)"

# Compile the game code to .bof bytecode. The kod makefile copies each .bof
# into run/server/loadkod, which must be a DIRECTORY.
#
# `rm -rf`, NOT `rm -f`, AND THE DIFFERENCE IS A BUILD THAT WILL NOT RUN AT ALL.
# Upstream ships run/server/loadkod as a plain FILE (a placeholder) and `rm -f`
# clears that. A checkout where it is already a DIRECTORY — which is what a tree
# that has been built once locally looks like, and what tpeppers/Meridian59-deck
# ships — makes `rm -f` fail with "cannot remove: Is a directory", and because the
# RUN is `&&`-chained the whole layer exits 1. Measured 2026-09-07: this took the
# local test server out entirely, which takes the shadow fleet with it, which is
# every integration test that needs a server to run against.
#
# The makefile's copy rule only runs when it recompiles; since .bof files are
# already committed to the tree, we also collect them explicitly afterwards.
RUN rm -rf run/server/loadkod && mkdir -p run/server/loadkod && \
    make -C kod -f makefile.linux RELEASE=1 && \
    find kod -name '*.bof' -exec cp {} run/server/loadkod/ \;

# The server itself.
RUN make -C blakserv -f makefile.linux RELEASE=1 makedirs \
 && make -C blakserv -f makefile.linux RELEASE=1 -j"$(nproc)"

RUN find . -name blakserv -type f -perm -u+x -newer common.mak.linux \
      -exec cp {} /tmp/blakserv \; -quit && test -x /tmp/blakserv

# -------------------------------------------------------------- runtime

FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 blak

WORKDIR /m59
COPY --from=build /tmp/blakserv            /m59/blakserv
COPY --from=build /src/run/server/         /m59/
COPY --from=build /src/resource/rooms/     /m59/rooms/
COPY --from=build /src/kod/kodbase.txt     /m59/kod/kodbase.txt

# START CLEAN, AND THIS IS NOT COSMETIC.
#
# run/server/ in a tree that has ever been run carries the previous operator's
# savegame, memmap and channel logs. Baking those into an image does two bad
# things at once:
#
#   * it publishes them — the channel logs are real player chat, with account
#     names and everything anyone said, and an image is a thing people push;
#   * it stops the server booting. A savegame written by a different build of
#     blakserv is not loadable by this one; it comes up, fails somewhere inside
#     LoadAll with "Memory count would go negative", and exits 1 with nothing on
#     stdout, which is a very quiet way to lose an afternoon.
#
# An empty savegame directory makes blakserv initialise a new game, which is what
# a freshly built server should do.
RUN rm -rf /m59/savegame/* /m59/memmap/* /m59/channel/*.txt /m59/blakserv.cfg.bak

# The config ships with Windows path separators, and the project README notes it
# needs manual changes on Linux. Rewrite the [Path] block to container-absolute
# paths, and open the maintenance mask to the docker bridge and LAN.
#
# Mask semantics (blakserv/async.c): each non-zero byte must match, zero bytes
# are wildcards. 172.0.0.0 therefore means "any 172.x.x.x", which is the docker
# gateway. Publishing 9998 on loopback only is what actually protects it.
#
# [Channel] Flush defaults to No (blakserv/config.c), and with it off every
# channel log is buffered and never reaches disk — DebugDisk Yes is not enough.
# That masquerades as "my hook isn't firing" and costs an afternoon, so it is
# turned on here rather than left to be discovered.
RUN set -eux; \
# STRIP CR FIRST, BEFORE ANYTHING ELSE READS THIS FILE.
#
# A tree cloned on Windows has blakserv.cfg in CRLF, and blakserv on Linux does
# not strip the CR: every section header parses as "[Socket]\r", which it reports
# as "found extra stuff after grouping", and every key under it as "data before a
# group declared". The whole config is then silently defaulted — the maintenance
# socket never opens, no channel logs are written, and the server sits there
# listening and unadministrable with no single line saying what went wrong.
#
# This is the "requires some manual changes to run on Linux" the project README
# mentions, and it is the entire content of that warning for most people.
    sed -i 's/\r$//' blakserv.cfg; \
    sed -i \
      -e 's#^Bof .*#Bof                  /m59/loadkod/#' \
      -e 's#^Memmap .*#Memmap               /m59/memmap/#' \
      -e 's#^Rsc .*#Rsc                  /m59/rsc/#' \
      -e 's#^Rooms .*#Rooms                /m59/rooms/#' \
      -e 's#^Motd .*#Motd                 /m59/#' \
      -e 's#^Channel .*#Channel              /m59/channel/#' \
      -e 's#^LoadSave .*#LoadSave             /m59/savegame/#' \
      -e 's#^Forms .*#Forms                /m59/#' \
      -e 's#^Kodbase .*#Kodbase              /m59/kod#' \
      -e 's#^PackageFile .*#PackageFile          /m59/#' \
      -e 's#^Filename .*blakston.*#Filename             /m59/blakston.khd#' \
      blakserv.cfg; \
# Set a key INSIDE its section. Appending at the end of the file is wrong and
# fails silently: blakserv.cfg is sectioned, the last section is [Service], and a
# key parked there is simply never read. Upstream ships [Socket] empty, so an
# appended MaintenancePort lands under [Service], the maintenance socket never
# opens, and the server looks healthy while nothing can administer it.
    setkey() { \
      sed -i "/^$2 /d" blakserv.cfg; \
      sed -i "/^\[$1\]/a $2                $3" blakserv.cfg; \
    }; \
    setkey Socket MaintenancePort 9998; \
    setkey Socket MaintenanceMask '127.0.0.1;172.0.0.0;192.168.0.0;10.0.0.0;0.0.0.0'; \
    setkey Channel Flush Yes; \
    setkey Channel DebugDisk Yes; \
    setkey Channel ErrorDisk Yes; \
    setkey Channel LogDisk Yes; \
    grep -q '^MaintenancePort' blakserv.cfg; \
    mkdir -p /m59/channel /m59/savegame /m59/memmap; \
    chown -R blak:blak /m59

USER blak
EXPOSE 5959 9998

# channel/ is where player chat lands once tracing is on; savegame/ is state.
VOLUME ["/m59/channel", "/m59/savegame"]

CMD ["/m59/blakserv"]
