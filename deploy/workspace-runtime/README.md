# Isolated workspace runtime

This runtime is an optional Linux-container backend. It has not been executed on
this Windows development host: Docker, Podman, and an installed WSL distribution
are absent. Unit tests check command construction and fail-closed behavior only;
they are not evidence of kernel isolation or successful container deployment.

## Modes

- `AETHER_WORKSPACE_RUNTIME=restricted-files`: the built-in file terminal works;
  arbitrary external commands are unavailable. This is the authenticated default.
- `AETHER_WORKSPACE_RUNTIME=docker`: terminals use Linux Bash and command jobs run
  in containers. An unavailable daemon/image prevents execution, without fallback.
- `AETHER_WORKSPACE_RUNTIME=host`: only accepted with `AUTH_ENABLED=false`, for an
  operator's trusted single-user instance. This is explicitly not an isolation mode.

Approval modes do not choose an execution runtime. Changing safe/standard/full
access must not change tenant or host filesystem authorization.

## Operator preparation

Use a dedicated Linux Docker daemon, preferably rootless or with user namespaces.
Do not expose its socket/API to users or mount it in their containers. A remote
Docker daemon must see the same operator-authorized workspace storage paths;
otherwise provision a worker on that host instead of mounting unrelated paths.

Build `deploy/workspace-runtime/Dockerfile` with `BASE_IMAGE` set to a reviewed
`node:22-bookworm-slim@sha256:<64 hex>` image. The Dockerfile's dated Debian snapshot
pins the package index; retain the resulting image and its provenance internally.
The template and package set require a real image build before production use.

Set `AETHER_WORKSPACE_IMAGE` to the resulting local `sha256:<64 hex>` image ID or
`registry/repository@sha256:<64 hex>` digest and provision that image on the daemon.
The engine uses `--pull=never` and never downloads an unreviewed image implicitly.
`AETHER_DOCKER_BINARY` can select an operator-managed Docker executable.

On Linux the workspace must be writable by container UID/GID 10001 (or its
user-namespace mapping). Provision only the tenant workspace directory; do not
recursively change ownership of an existing host project as part of startup.

## Effective boundary and lifecycle

Each terminal/job gets one disposable container. The selected workspace is the
only host bind mount and appears as `/workspace`; commands share its files but
not process namespaces or changes to their ephemeral home/system layers.
Containers run as UID 10001, with a read-only root filesystem, no capabilities,
no-new-privileges, no network, 256 processes, 1 GiB memory, 2 CPUs, bounded tmpfs,
and a 1024-file descriptor limit. No host environment secrets enter the container.

`/home/aether` and `/tmp` are private temporary filesystems; only `/workspace`
persists. Tools needing executable caches may use `/home/aether` or `/workspace`.
The base image includes Bash, Git, Node/npm, Python, core filesystem and process
utilities, archives, JSON, SQLite and network diagnostic clients. Network clients
cannot reach the host/Internet in this profile. Privileged system administration,
daemons requiring extra capabilities, package installation into `/usr`, port
publishing, and shared persistent services need a separately reviewed runtime
profile; users cannot request Docker flags to enable them.

Creation is completed before a process launch plan is returned, eliminating the
race where cancellation stops only the CLI while Docker creates a container later.
Normal completion/cancellation validates private ownership labels and removes only
that container. Cleanup failure is an error, not a successful termination result.
Abrupt engine/host termination still needs an operator-controlled orphan-container
reconciler before production 24/7 use; it must not delete another live engine's
containers. Private labels identify managed/scope/execution ownership without
embedding raw tenant/user IDs.

OCI containers share a kernel. This backend does not claim complete VM isolation.
Hostile multi-tenant deployments should use dedicated workers or a VM-backed
runtime such as Kata/Firecracker, with network/storage quotas and image governance.

## Required real-environment acceptance

Before enabling this backend: test image build and UID mapping; Bash input/resize;
file/Git consistency; exit codes and cancellation; engine crash recovery;
host/sibling-tenant canaries; symlink and mount races; `/proc` and environment
exposure; blocked host/metadata/network access; process, memory, descriptor and
disk exhaustion; tenant ownership spoofing; and container/kernel patch management.
Do not label these checks passed when only a mocked Docker runner was available.
