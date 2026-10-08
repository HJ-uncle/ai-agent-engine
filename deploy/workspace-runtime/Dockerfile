# Required: an operator-reviewed node:22-bookworm-slim image locked by digest.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG DEBIAN_SNAPSHOT=20260930T000000Z
USER root
# The dated snapshot fixes the package index used for this image build. The
# resulting image ID/digest, never a mutable tag, is used by the engine.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources \
    && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm main\n' "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       bash coreutils findutils grep sed gawk less tree file procps iproute2 \
       dnsutils iputils-ping curl wget openssh-client git python3 python3-venv \
       python3-pip unzip zip tar gzip jq sqlite3 openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 aether \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash aether \
    && mkdir -p /workspace \
    && chown 10001:10001 /workspace
ENV HOME=/home/aether LANG=C.UTF-8
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/bin/bash", "--noprofile", "--norc"]
