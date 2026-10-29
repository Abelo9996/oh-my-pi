# 04 — Caching: bazel-remote and the CI caches

vmon sandboxes share no filesystem: every job forks the same `omp-ci` snapshot and its writes die with it. CI therefore has two kinds of cache:

| Cache | Where | Written by | Read by |
| --- | --- | --- | --- |
| Bazel action cache + CAS (Rust compiles, clippy, rustfmt, tests, `.node` addons) | bazel-remote on can.internal | non-PR vmon jobs (`ci` credentials) | non-PR vmon jobs |
| Bazel repository cache, repo contents cache, xwin download cache | `/opt/bazel-repo-cache` in the `omp-ci` template | template build | vmon jobs (`.github/actions/bazel-cache`) |
| Bazel install base + fetched output base, bazelisk's Bazel | `~/.cache/bazel`, `~/.cache/bazelisk` in the template | template build | vmon jobs |
| bun package store | `~/.bun/install/cache` in the template; `bun-<os>-<lockhash>` actions/cache entry | template build; main's hosted jobs (`bun-cache-warm.yml`, release jobs) | vmon jobs; GitHub-hosted jobs (PRs, releases) |
| Cargo registry | `~/.cargo/registry` in the template | template build | `check` (`cargo fetch --locked` then offline `cargo deny`) |
| linux-x64 addon pair for PRs | actions/cache `natives-linux-x64-v1-<native inputs hash>` | main's `native_addons` | PR `native_addons` |
| Addons within a run | workflow artifacts `natives-linux-x64`, `native-addons` (1 day) | `native_addons`, `native_addons_cross` | test and release jobs (`.github/actions/native-artifacts`) |

Template caches are refreshed by rebuilding `omp-ci` ([02-omp-ci-template.md](02-omp-ci-template.md#2-freshness)). Only bazel-remote is shared, mutable infrastructure; the rest of this guide is about it.

## 1. Deploy bazel-remote

The deployment lives in [`infra/bazel-remote/`](../bazel-remote/) and runs on the cache host's k3s ([03-cache-host.md](03-cache-host.md)):

- [`bazel-remote.yaml`](../bazel-remote/bazel-remote.yaml) — namespace `bazel-cache`; a 100Gi `local-path` PVC (`bazel-remote-data`); a single-replica `Recreate` Deployment of `buchgr/bazel-remote-cache:v2.6.2` (`--max_size=90` GiB LRU, gRPC `:9092`, HTTP `:8080`, TLS + htpasswd from secret mounts, `--allow_unauthenticated_reads`, 10Gi memory limit for concurrent ~150 MB addon uploads); the ClusterIP Service `bazel-remote` (9092 + 8080); and the NodePort Service `bazel-remote-public` (gRPC only, node port **30992**, `externalTrafficPolicy: Local`).
- [`setup.sh`](../bazel-remote/setup.sh) — the idempotent bootstrap, run **on the cache host** as root from a checkout of `infra/bazel-remote/`:

   ```bash
   PUBLIC_SAN=<PUBLIC_SAN> VMON_EGRESS_CIDRS=<VMON_EGRESS_CIDRS> ./setup.sh
   ```

   It (1) creates the CA and a server certificate (reissued with the same CA when the SAN set changes), (2) writes the `bazel-cache/bazel-remote-tls` and `bazel-cache/bazel-remote-auth` secrets, (3) installs the node-port source filter (§2), (4) applies `bazel-remote.yaml` (restarting the Deployment when the certificate changed), and (5) prints the CA and the GitHub secrets to set. The CA, server cert, `ci` password, `PUBLIC_SAN` and `VMON_EGRESS_CIDRS` persist in `/root/bazel-remote-cache`, so re-running needs no arguments.

Verify:

```bash
kubectl -n bazel-cache get deploy,svc,pvc
# deployment.apps/bazel-remote          1/1
# service/bazel-remote                  ClusterIP   10.43.x.x   9092/TCP,8080/TCP
# service/bazel-remote-public           NodePort    10.43.x.x   9092:30992/TCP
# persistentvolumeclaim/bazel-remote-data   Bound   100Gi   local-path

# Status endpoint (in-cluster HTTPS; -k or --cacert the committed CA):
curl -sk "https://$(kubectl -n bazel-cache get pod -l app=bazel-remote \
  -o jsonpath='{.items[0].status.podIP}'):8080/status"
# {"CurrSize": ..., "MaxSize": 96636764160, "NumFiles": ..., ...}

nft list table inet bazel_remote_public      # the source filter
```

## 2. Endpoint, TLS, auth, exposure

| Client | Endpoint | Writes |
| --- | --- | --- |
| vmon CI jobs (non-PR) | `BAZEL_REMOTE_URL` = `grpcs://<PUBLIC_SAN>:30992` | yes — `ci` credentials from repository secrets |
| Developers on the tailnet (optional) | `grpcs://can.internal:30992` | no — `--config=cache-ro` |
| In-cluster | `grpcs://bazel-remote.bazel-cache.svc.cluster.local:9092` | as authenticated |
| GitHub-hosted runners (PRs, releases) | none — they run no Bazel builds | n/a |

- **Why a public endpoint.** vmon sandboxes can reach only the public internet: their egress policy always denies private, link-local and tailnet (`100.64.0.0/10`) destinations, and lifting that per node would open the whole cache host to every tenant's sandboxes. The runners therefore dial the cache host's public address.
- **Exposure filter.** The NodePort is reachable only from `VMON_EGRESS_CIDRS` (the vmon nodes' egress addresses as seen by the cache host), the tailnet and loopback: `setup.sh` installs the nft table `inet bazel_remote_public` (prerouting at mangle priority, i.e. before kube-proxy rewrites the port) from `/etc/bazel-remote-public.nft`, reloaded at boot by `bazel-remote-public-filter.service`, and opens `30992/tcp` in firewalld's public zone so the nft table is the single source of truth. Find the egress addresses from inside a vmon sandbox on each node (`curl -s https://api.ipify.org`); re-run `setup.sh` with the new `VMON_EGRESS_CIDRS` when nodes are added or renumbered.
- **TLS.** The server certificate is signed by the self-signed CA committed at [`infra/bazel-remote/ca.crt`](../bazel-remote/ca.crt); every client passes `--tls_certificate=infra/bazel-remote/ca.crt`. SANs: the in-cluster service names, `can.internal` (`ADMIN_SAN`) and `<PUBLIC_SAN>` (`DNS:` or `IP:`), which must be the host in `BAZEL_REMOTE_URL`. Only the CA key stays on the host (`/root/bazel-remote-cache/ca.key`).
- **Auth.** `bazel-cache/bazel-remote-auth` is a bcrypt htpasswd with the single user `ci`; `--allow_unauthenticated_reads` keeps reads open to whoever passes the filter. Cache entries are build outputs of the public repository.

## 3. Bazel flags

`.bazelrc` carries only cache *policy*: `cache-rw` (upload local results) and `cache-ro` (no uploads), both with `--remote_local_fallback`, 2 retries and a 60 s timeout, so a cache outage degrades to local execution instead of failing the build. Endpoint and credentials are always composed by the consumer:

```bash
bazelisk build \
  --config=cache-rw \
  --remote_cache="$BAZEL_REMOTE_URL" \
  --tls_certificate=infra/bazel-remote/ca.crt \
  --remote_header="authorization=Basic $(printf %s "$BAZEL_REMOTE_USER:$BAZEL_REMOTE_PASSWORD" | base64 -w0)" \
  //:natives-all
```

Developers on the tailnet can read the cache from `.bazelrc.user` (gitignored, `try-import`ed by `.bazelrc`):

```
build --config=cache-ro
build --remote_cache=grpcs://can.internal:30992
build --tls_certificate=infra/bazel-remote/ca.crt
```

## 4. Secrets and the bazel-cache action

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `BAZEL_REMOTE_URL` | `grpcs://<PUBLIC_SAN>:30992` |
| `BAZEL_REMOTE_USER` | `ci` |
| `BAZEL_REMOTE_PASSWORD` | `/root/bazel-remote-cache/ci-password` on the cache host |

The endpoint is a secret too, so the public repository carries only the CA certificate. Each Bazel job passes the three secrets as inputs to [`.github/actions/bazel-cache`](../../.github/actions/bazel-cache/action.yml) only (no job-level env), which writes a bazelrc fragment (`rc` output) for `bazelisk --bazelrc=…`:

- not a vmon runner (`VMON_CI` unset): `--config=ci` only, uncached;
- vmon runner: `--config=ci`, `--repository_cache=/opt/bazel-repo-cache`, `--repo_env=OMP_XWIN_CACHE_DIR=/opt/bazel-repo-cache/xwin` (template-baked, §1 of [02-omp-ci-template.md](02-omp-ci-template.md#1-what-omp-ci-adds));
- plus, with the secrets: `--config=cache-rw`, the remote endpoint, the CA, the Basic-auth header (masked in logs before `--announce_rc` can print it) and `--remote_download_toplevel`. A partial secret set fails the step; a missing set warns and builds without the remote cache.

## 5. Poisoning boundary

The store is content-addressed and writes require the `ci` credentials, so the poisoning surface is exactly the set of jobs that receive the secrets: non-PR runs of `ci.yml` (pushes to `main`, dispatches, releases) on vmon. PR jobs run on GitHub-hosted runners, build nothing with Bazel, and fork PRs never receive secrets; vmon additionally refuses jobs from actors outside the public-repo allow-list ([01-vmon-runners.md](01-vmon-runners.md#4-trust-split)). Nothing else is shared between jobs: `node_modules`, Cargo `target/` and Bazel outputs live and die inside each sandbox, and the template caches are written only at template build time.

## 6. Operate

- **Pressure.** bazel-remote evicts LRU at `--max_size=90` GiB; watch `CurrSize` on `/status`, and grow the PVC and the flag together if hit rates drop.
- **Hit rates.** Each Bazel job posts a "Bazel build summary" notice with its process counts; a warm build is dominated by `remote cache hit`.
- **Rotate the `ci` password.** Delete `/root/bazel-remote-cache/ci-password`, re-run `setup.sh`, `kubectl -n bazel-cache rollout restart deploy/bazel-remote`, update `BAZEL_REMOTE_PASSWORD`.
- **Change the public name or address.** Re-run `setup.sh` with the new `PUBLIC_SAN` (reissues the server cert and restarts bazel-remote), then update `BAZEL_REMOTE_URL`.
- **Regenerating the CA** (deleting `ca.key`) changes `ca.crt`: commit the new certificate in the same change that rolls the server.
- **Logs.** `kubectl -n bazel-cache logs deploy/bazel-remote -f`.
