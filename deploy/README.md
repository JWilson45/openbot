# Kubernetes org pilot

This directory packages **one existing OpenBot org server per namespace**.
It is a pilot chart, not an implemented org operator. Install one release per
dedicated namespace. The namespace-wide network policy and quota must not be
installed into a namespace containing unrelated applications.

## Current verification

Helm rendering and lint are checked locally. On 2026-09-08 Kata 4.1.0 was
installed through Argo CD on HomeLab's imac00. A non-root pod ran guest kernel
6.18.35 versus host kernel 6.8.0-137-generic, wrote to a dedicated Longhorn PVC,
and had no Kubernetes service-account token. A cross-namespace connectivity test
succeeded before an egress policy, failed with that policy while DNS still worked,
and succeeded after its removal. See `kata-smoke.yaml` and `network-smoke*.yaml`.

The amd64 image builds and its application readiness probe passes. Chromium renders
with its sandbox under a local seccomp-unconfined container, but Docker's default
seccomp blocks its namespace setup. The chart still uses RuntimeDefault; browser
startup with that exact policy on Kata must be tested before deployment.

A real org deployment still requires a published runtime image, org credentials,
and end-to-end browser/Grok/access checks. Do not
interpret a passing HTTP readiness probe as proof that Grok or Chromium works.

## Build

```sh
docker build --platform linux/amd64 -t YOUR_REGISTRY/openbot:YOUR_TAG .
docker push YOUR_REGISTRY/openbot:YOUR_TAG
```

The Dockerfile also supports linux/arm64. It bundles Bun, Chromium, Python, Git,
and Grok 1.0.13. The Grok artifact is downloaded from x.ai at build time; no login
or application credentials are included in the image. Validate both architectures
before publishing a multi-platform image. The Chromium sandbox remains enabled.
The image does not add bubblewrap; the org boundary is its pod runtime and network
policy, while ACP path checks continue to apply inside the shared org desk.

## Configure an org

Supply a stable UUID in `org.id`, a slug, a name and an HTTPS public origin.
Supply `image.repository` and `image.tag`. Set `ingress.enabled=true` and the
matching host to expose it through the chosen ingress controller. The default
ingress class is Tailscale. The default network policy admits that controller's
namespace only; change `networkPolicy.ingressNamespaces` for another controller.

`deploy/kata-homelab.yaml` records the single-worker Kata installation using chart
4.1.0. Before applying it, verify `/dev/kvm` and hardware virtualization on imac00
over SSH and account for the container-runtime restart. It does not change the
cluster's default runtime. The authoritative installed values are in the sibling
`infra` repository at `apps/kata/values.yaml`; change those through Argo CD.

Create an org-specific Secret containing `OPENBOT_GITHUB_CLIENT_ID`,
`OPENBOT_GITHUB_CLIENT_SECRET`, and `OPENBOT_GITHUB_ALLOWLIST`, then reference its
name with `credentialsSecret`. The GitHub callback is
`https://ORG_HOST/auth/callback/github`. OAuth uses a browser-bound state cookie.
A private Tailscale endpoint still uses application
authentication; membership in the tailnet does not automatically sign a user in.

For model credentials, either sign in and use Settings to store a key in the vault,
or reference a Secret with the org's `auth.json` using `grokAuthSecret`. Never
commit plaintext credentials or pass secrets in Helm values. A shared operator's
login must not be silently copied into unrelated orgs.

For a fresh Grok login, run `grok login --device-auth` inside the org's `openbot`
container and complete the displayed device authorization yourself. The chart sets
`HOME=/data/operator-home`, so the source login persists on that org's disk across
restarts. Do not configure `grokAuthSecret` for this writable device-login flow.

```sh
helm upgrade --install openbot deploy/helm/openbot \
  --kube-context HomeLab --namespace openbot-YOUR_ORG --create-namespace \
  -f /path/to/nonsecret-org-values.yaml
```

`runtimeClassName` defaults to `kata-qemu-runtime-rs`; a missing runtime leaves the pod
unschedulable rather than falling back to an ordinary container. Emptying the value
explicitly selects the cluster's standard runtime and removes the VM boundary.
Account for RuntimeClass overhead when sizing namespace quotas and node capacity.

## Persistence and lifecycle

The PVC explicitly requests Longhorn and is retained on Helm uninstall. Do not
manually delete the PVC or namespace without a verified backup: HomeLab's existing
Longhorn StorageClass uses `reclaimPolicy: Delete`. A namespace deletion can still
delete the PVC despite Helm's keep annotation. The pilot does not implement org
deletion automation, backups, or restore automation.

Keep exactly one replica. SQLite, warm agent children, and the shared browser
require a single active server. Never force-delete a pod on an unreachable node
and start a replacement until the old writer is fenced. Stopping the pod stops
the calendar and in-flight work. Kubernetes restarts do not provide uninterrupted
agent execution.

The app binds loopback inside the pod. An unprivileged proxy exposes only port
8080, blocks the private runtime bridge, local demo login and runner management,
and supports WebSockets and streaming responses. No service-account token is
mounted in org pods. Egress allows cluster DNS and public HTTP(S), excluding
private, link-local and Tailscale ranges. Actual enforcement must be tested on
the target cluster, including node and API-server destinations.

## Acceptance before real use

1. Run a Kata smoke pod and verify its guest kernel differs from the host kernel.
2. Confirm Chromium starts with its sandbox and a real Grok turn completes.
3. Provision two org namespaces; confirm cross-org, node, and API access is denied.
4. Confirm authorized sign-in, streaming and takeover through the HTTPS endpoint.
5. Restart and upgrade the org; verify its identity, database, files and browser state.
6. Back up and restore to a separate volume before relying on the deployment.

An eventual `OpenBotOrg` operator should reconcile this same workload shape with
durable status, explicit suspend/retention semantics and idempotent provisioning.
