#!/usr/bin/env bash
# Idempotent bazel-remote cache bootstrap. Run ON the cache host (root), with
# bazel-remote.yaml from this directory next to it:
#
#   PUBLIC_SAN=<public DNS name or IPv4> VMON_EGRESS_CIDRS=<cidr>[,<cidr>…] ./setup.sh
#
# Both values persist under $STATE_DIR after the first run, so later runs need
# no arguments (pass them again to change them).
#
# What it does (safe to re-run; every step is guarded or apply-based):
#   1. Generates a self-signed CA + server cert under $STATE_DIR. SANs: the
#      in-cluster service DNS, the host's private admin name, and PUBLIC_SAN
#      (the name/address in the BAZEL_REMOTE_URL secret). The server cert is
#      reissued (same CA) whenever that SAN set changes.
#   2. Creates/updates secrets:
#        bazel-cache/bazel-remote-tls    - server cert + key (kubernetes.io/tls)
#        bazel-cache/bazel-remote-auth   - htpasswd (bcrypt, user `ci`)
#   3. Installs the node-port source filter: nft table `inet bazel_remote_public`
#      (prerouting, before kube-proxy's DNAT) accepts tcp/30992 only from
#      VMON_EGRESS_CIDRS, the tailnet, and loopback, and drops the rest; a
#      oneshot unit reloads it at boot before k3s. firewalld's public zone
#      opens 30992/tcp so the filter is the single source of truth.
#   4. Applies bazel-remote.yaml (namespace, PVC, Deployment, ClusterIP service,
#      NodePort `bazel-remote-public` on 30992), restarting the Deployment when
#      the server cert changed.
#   5. Prints the CA cert (commit it as infra/bazel-remote/ca.crt) and the
#      GitHub repository secrets the CI workflows read.
#
# Env knobs:
#   PUBLIC_SAN         DNS name or IPv4 the vmon runners dial  [persisted; required once]
#   VMON_EGRESS_CIDRS  vmon nodes' egress addresses as seen by this host, comma separated
#                                                           [persisted; required once]
#   TAILNET_CIDR       admin/dev read access over Tailscale [100.64.0.0/10]
#   KUBECONFIG         kubeconfig path                      [/etc/rancher/k3s/k3s.yaml]
#   STATE_DIR          where CA/certs/password persist      [/root/bazel-remote-cache]
#   ADMIN_SAN          extra DNS SAN for host-side debugging [can.internal]
#   CERT_DAYS          CA + server cert lifetime            [3650]
set -euo pipefail

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
STATE_DIR="${STATE_DIR:-/root/bazel-remote-cache}"
ADMIN_SAN="${ADMIN_SAN:-can.internal}"
TAILNET_CIDR="${TAILNET_CIDR:-100.64.0.0/10}"
CERT_DAYS="${CERT_DAYS:-3650}"
NS=bazel-cache
NODE_PORT=30992
NFT_FILE=/etc/bazel-remote-public.nft
NFT_UNIT=/etc/systemd/system/bazel-remote-public-filter.service

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/bazel-remote.yaml" ] || { echo "missing $here/bazel-remote.yaml (run from a checkout of infra/bazel-remote/)" >&2; exit 1; }
for bin in kubectl openssl nft systemctl; do
  command -v "$bin" >/dev/null || { echo "missing required tool: $bin" >&2; exit 1; }
done
if ! command -v htpasswd >/dev/null; then
  echo "==> htpasswd missing; installing httpd-tools/apache2-utils"
  if command -v dnf >/dev/null; then dnf install -y httpd-tools
  elif command -v apt-get >/dev/null; then apt-get update && apt-get install -y apache2-utils
  else echo "cannot install htpasswd (no dnf/apt-get); install it manually" >&2; exit 1
  fi
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
cd "$STATE_DIR"

# PUBLIC_SAN / VMON_EGRESS_CIDRS: argument wins, else the persisted value.
persist() { # <name> <file>
  local value="${!1:-}"
  if [ -n "$value" ]; then
    printf '%s\n' "$value" > "$2"
  elif [ -s "$2" ]; then
    value="$(cat "$2")"
  else
    echo "set $1 (see the header of $0)" >&2
    exit 1
  fi
  printf -v "$1" '%s' "$value"
}
persist PUBLIC_SAN public-san
persist VMON_EGRESS_CIDRS vmon-egress-cidrs

if [[ "$PUBLIC_SAN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  public_san_ext="IP:${PUBLIC_SAN}"
else
  public_san_ext="DNS:${PUBLIC_SAN}"
fi
SANS="DNS:bazel-remote.${NS}.svc.cluster.local,DNS:bazel-remote.${NS}.svc,DNS:${ADMIN_SAN},${public_san_ext}"

# --- 1. CA + server certificate -------------------------------------------
if [ ! -s ca.crt ] || [ ! -s ca.key ]; then
  echo "==> [1/5] generating CA"
  openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days "$CERT_DAYS" \
    -keyout ca.key -out ca.crt \
    -subj "/CN=bazel-remote-ca" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  chmod 600 ca.key
else
  echo "==> [1/5] reusing existing CA ($STATE_DIR/ca.crt)"
fi

cert_changed=false
if [ ! -s server.crt ] || [ ! -s server.key ] || [ "$(cat server.sans 2>/dev/null)" != "$SANS" ]; then
  echo "==> [1/5] issuing server certificate ($SANS)"
  openssl req -newkey rsa:4096 -sha256 -nodes \
    -keyout server.key -out server.csr \
    -subj "/CN=bazel-remote.${NS}.svc.cluster.local"
  cat > server.ext <<EOF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${SANS}
EOF
  openssl x509 -req -sha256 -days "$CERT_DAYS" \
    -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -extfile server.ext -out server.crt
  rm -f server.csr server.ext
  chmod 600 server.key
  printf '%s' "$SANS" > server.sans
  cert_changed=true
else
  echo "==> [1/5] reusing existing server certificate"
fi

# --- 2. Credentials + secrets ----------------------------------------------
if [ ! -s ci-password ]; then
  echo "==> [2/5] generating ci password"
  openssl rand -base64 24 | tr -d '/+=' > ci-password
  chmod 600 ci-password
else
  echo "==> [2/5] reusing existing ci password"
fi
CI_PASSWORD="$(cat ci-password)"
htpasswd -Bbc htpasswd ci "$CI_PASSWORD" >/dev/null 2>&1
chmod 600 htpasswd

echo "==> [2/5] applying secrets"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" create secret tls bazel-remote-tls \
  --cert=server.crt --key=server.key \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" create secret generic bazel-remote-auth \
  --from-file=htpasswd=htpasswd \
  --dry-run=client -o yaml | kubectl apply -f -

# --- 3. Node-port source filter (before the NodePort exists) ---------------
echo "==> [3/5] installing the tcp/${NODE_PORT} source filter (${VMON_EGRESS_CIDRS}, ${TAILNET_CIDR})"
allowed="${VMON_EGRESS_CIDRS},${TAILNET_CIDR},127.0.0.0/8"
cat > "$NFT_FILE" <<EOF
# Managed by infra/bazel-remote/setup.sh: only the vmon CI egress addresses,
# the tailnet, and loopback may reach the bazel-remote NodePort. Runs at
# mangle priority, before kube-proxy's DNAT rewrites the destination port.
table inet bazel_remote_public
delete table inet bazel_remote_public
table inet bazel_remote_public {
  set allowed4 {
    type ipv4_addr
    flags interval
    elements = { ${allowed//,/, } }
  }
  chain prerouting {
    type filter hook prerouting priority mangle; policy accept;
    tcp dport ${NODE_PORT} ip saddr @allowed4 accept
    tcp dport ${NODE_PORT} drop
  }
}
EOF
nft -c -f "$NFT_FILE"
cat > "$NFT_UNIT" <<EOF
[Unit]
Description=bazel-remote NodePort source filter (infra/bazel-remote/setup.sh)
Before=k3s.service
After=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$(command -v nft) -f ${NFT_FILE}

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable bazel-remote-public-filter.service >/dev/null
systemctl restart bazel-remote-public-filter.service
nft list chain inet bazel_remote_public prerouting >/dev/null
if command -v firewall-cmd >/dev/null && ! firewall-cmd --permanent --zone=public --query-port="${NODE_PORT}/tcp" >/dev/null 2>&1; then
  firewall-cmd --permanent --zone=public --add-port="${NODE_PORT}/tcp"
  firewall-cmd --reload
fi

# --- 4. bazel-remote itself -------------------------------------------------
echo "==> [4/5] applying bazel-remote.yaml"
kubectl apply -f "$here/bazel-remote.yaml"
if [ "$cert_changed" = true ]; then
  # bazel-remote reads its certificate at startup only.
  kubectl -n "$NS" rollout restart deployment/bazel-remote
fi
kubectl -n "$NS" rollout status deployment/bazel-remote --timeout=180s

# --- 5. Operator hand-off -----------------------------------------------------
echo "==> [5/5] done. Manual follow-ups:"
echo
echo "1. infra/bazel-remote/ca.crt must equal this CA (it changes only when"
echo "   $STATE_DIR/ca.key is regenerated; the script cannot commit):"
echo "   --- $STATE_DIR/ca.crt ---"
cat ca.crt
echo "   --- end ca.crt ---"
echo
echo "2. GitHub repository secrets read by .github/actions/bazel-cache:"
echo "     BAZEL_REMOTE_URL       grpcs://${PUBLIC_SAN}:${NODE_PORT}"
echo "     BAZEL_REMOTE_USER      ci"
echo "     BAZEL_REMOTE_PASSWORD  contents of $STATE_DIR/ci-password"
echo
echo "Endpoints: grpcs://${PUBLIC_SAN}:${NODE_PORT} (vmon egress + tailnet only),"
echo "           grpcs://bazel-remote.${NS}.svc.cluster.local:9092 (in-cluster)"
