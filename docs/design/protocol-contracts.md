# OpenBot Protocol and Runtime Contracts

Status: **Frozen v1 (ratified)**  
Effective: 2026-09-03

This document is normative for the MCP, A2A, AG-UI, runtime-provider, event,
and application boundaries. The words MUST, MUST NOT, SHOULD, and MAY have the
usual RFC 2119 meaning.

The freeze covers contract names, dependency direction, lifecycle semantics,
identity, event ordering, and public endpoints. Implementations may change
behind these boundaries. A breaking contract change requires a new major
contract version and a migration; it MUST NOT be introduced by adding a second
legacy read path or a dual write.

This is the final v1 baseline. "Frozen" means that code which disagrees with
this document is a defect; it does not mean that every future feature is part
of v1. The executable schemas and protocol-oracle tests named below are part of
the freeze and take precedence over examples in older phase design documents.

## Scope

This cutover implements these sibling adapters:

| Boundary | Frozen profile | Endpoint |
| --- | --- | --- |
| MCP | MCP `2026-07-28`, stateless Streamable HTTP | `POST /mcp` |
| A2A | A2A `1.0`, JSON-RPC binding | `POST /a2a/v1` |
| A2A discovery | A2A `1.0` Agent Card | `GET /.well-known/agent-card.json` |
| AG-UI | AG-UI HTTP/SSE, OpenBot profile `1` | `POST /ag-ui/v1/run` |
| AG-UI replay | OpenBot transport extension | `GET /ag-ui/v1/runs/:runId/events?after=<seq>` |
| AG-UI cancellation | OpenBot transport extension | `DELETE /ag-ui/v1/runs/:runId` |
| Browser conversation bootstrap | OpenBot REST resource | `GET /v1/agents/:agentId/conversation` |

The implementation pins `@modelcontextprotocol/server` and client test oracle
to `2.0.0`, `@a2a-js/sdk` to `1.1.0` (implementing A2A wire `1.0`), and
`@ag-ui/core`, `@ag-ui/encoder`, and the client test oracle to `0.0.59`.
AG-UI's formal 1.0 specification is not ratified as of this freeze. OpenBot's
`/ag-ui/v1` path is an OpenBot route profile, not a claim that AG-UI 1.0 is
final. AG-UI translation remains isolated so a later ratified version can be
adopted without changing core events.

A2UI and generated-component rendering are explicitly out of scope. REST
remains the interface for resource navigation, configuration, calendars, and
administration. Runner RPC remains a private compute-control protocol and is
not A2A.

`/mcp/v1` and `/fed/v1/*` are removed at the cutover rather than shimmed. The
browser human-DM path no longer consumes raw ACP events, legacy thread messages,
or the live-work endpoint. Legacy product turn/live-work routes remain outside
this frozen protocol surface for group, calendar, and internal workflows.

The v1 server accepts inbound A2A tasks. The outbound A2A client and its
security boundary are frozen and implemented, but v1 does not advertise an
operator or agent action that initiates a remote task. A future composition
MUST persist an outbound intent before network I/O and use the frozen client;
it MUST NOT revive `/fed/v1/*` as an interim transport.

## Dependency direction

```text
protocol-mcp ─┐
protocol-a2a ─┼──> application ───> core
protocol-ag-ui┘          ↑             ↑
server composition ─────┼─────────────┤
db adapter ─────────────┘             │
runtime-grok ─────────────────────────┘
runner adapter ───────────────────────┘
```

`@openbot/core` contains data and validation only. It MUST NOT import MCP,
A2A, AG-UI, ACP, Grok, Hono, SQLite, browser, or runner code.

`@openbot/application` owns use cases and ports. It may import only
`@openbot/core` from OpenBot packages. Protocol packages may import
`@openbot/core` and `@openbot/application`; they MUST NOT import the database,
runtime providers, runner, Hono, or each other. The server is the composition
root and is the only layer that wires adapters together.

Adding a provider MUST require only a provider package and a registry entry.
Adding or replacing a protocol adapter MUST NOT change provider code.

## Canonical model

The executable source of truth is `@openbot/core`.

- `Conversation` is durable conversational context and uses `ThreadId`.
- `Task` is a durable unit of work. It can span interruptions and multiple run
  attempts.
- `Run` is one execution attempt for a task.
- `Message` contains typed `ContentPart[]`, never a protocol-specific message
  object or a single assumed text body.
- `Artifact` is durable task output. A system-message prefix is not an artifact.
- `Interrupt` is a durable request for permission, input, or authentication.
- `Agent.runtime` is always `{ providerId, modelId, options }`.

Canonical agents, conversations, and tasks carry an `AccountId`; account
ownership is checked inside application use cases, not only at HTTP ingress.
Internal IDs are UUIDs and are branded by entity type in TypeScript. External
protocol IDs are opaque strings. Adapters MUST persist an explicit mapping and
MUST NOT infer an internal ID from an external ID, or expose an internal ID as
a promise that another protocol can reuse.

External identity uniqueness is scoped by account, authenticated `subjectId`,
protocol, namespace, and entity kind. Rotating a credential may preserve a
subject only when authentication has independently established that stable
principal. Possession of a different credential in the same account does not
grant access to another subject's mappings.

For the initial migration, an existing thread may become the `Conversation`,
and an existing turn may seed one `Task` and one `Run`. That migration is an
implementation detail, not an identity equivalence contract.

### Task lifecycle

The canonical task states are:

```text
submitted
  ├─> working ─> input_required ─> working
  │       ├────> auth_required ──> working
  │       ├────> completed
  │       ├────> failed
  │       └────> canceled
  ├─> rejected
  └─> canceled
```

`completed`, `failed`, `canceled`, and `rejected` are terminal. Repeating the
current state is idempotent. An adapter maps spelling and status differences at
its edge; protocol enum values do not leak into the application state machine.

The canonical run states are `queued`, `running`, `interrupted`, `completed`,
`failed`, and `canceled`. A resumed provider session can continue the same task
in a new run; `runId` is therefore never used as a task ID.

## Runtime provider boundary

The executable ports are `RuntimeProvider`, `RuntimeSession`, and
`RuntimeProviderRegistry` in `@openbot/application`.

- A provider descriptor declares stable identity and authentication methods.
  Models and capabilities are resolved asynchronously for an account and
  configuration. Callers MUST feature-detect through those operations, not
  property probes or provider-name checks.
- Provider configuration is validated by the selected provider. Unknown
  provider options are contained in `options` and MUST NOT become columns or
  core fields unless they are genuinely cross-provider.
- A runtime session receives only canonical IDs, validated provider config,
  opaque capability references, and bounded public metadata. It never receives
  host paths or an arbitrary environment map. Provider secrets are resolved by
  the adapter through the scoped credential port at composition time.
- A runtime session emits `RuntimeEventDraft` values. Message drafts have a
  provider-local reference and balanced start/delta/finish events, so multiple
  messages and actions can interleave. Drafts do not assign durable IDs,
  timestamps, or sequence numbers.
- The application validates every draft, applies policy, assigns canonical
  identities, and appends a `TaskEventEnvelope` before publication.
- Raw provider/ACP event names MUST NOT escape the provider adapter.
- Private chain-of-thought MUST NOT be persisted or sent to clients. Only an
  explicitly classified `summary` may become `reasoning.summary.delta`.
- Provider request references used to resume interrupts are stored only in the
  private `RuntimeCorrelationRepository`. A queued continuation contains
  canonical interrupt IDs; the runtime worker loads the authorized response
  and correlation after its lease is claimed. Provider references and response
secrets never enter public metadata or canonical event payloads.

A paused provider bridge is reusable only by the same account, agent, task,
and exact persisted provider-session reference. A process restart cannot
recover an in-memory permission exchange; such a continuation fails closed
instead of guessing at provider state.

Cancellation is cooperative through `AbortSignal` and `RuntimeSession.cancel`.
A provider MUST produce at most one terminal draft (`completed` or `failed`).
The application remains authoritative for the durable terminal task/run state.

## Application ports

`AgentTaskPort` is the sole task-facing interface for MCP actions, A2A, AG-UI,
local handoff, and future transports. `ActionPort` is the provider-neutral
action catalog/call interface. Both receive a `ProtocolPrincipal`; adapters
MUST authenticate before invoking them. Internal transition and artifact
operations are isolated on `TaskCoordinatorPort` and are not available to
protocol adapters.

Authorization is evaluated inside the application boundary as well as at HTTP
ingress. A principal contains account, subject, kind, and scopes. Repository
lookups without a principal are outbound implementation ports and MUST only be
called after the use case has established tenancy.

`AgentTaskPort.submit` accepts an optional idempotency key and opaque external
entity references, never caller-selected internal IDs. The durable
implementation MUST scope idempotency to the authenticated principal and
operation. Cancellation and identical interrupt responses are idempotent.
Conflicting reuse returns `conflict`.

Submitted input is explicitly a `user` or `tool` message; a tool message carries
its action-call correlation ID. Interrupt continuation uses one atomic
`resume` command that validates and resolves every open interrupt, optionally
records a new input message, creates a new run with its external binding, and
transitions the task back to work. Partial interrupt resolution cannot enqueue
a resume run.

Free-form protocol follow-ups use the distinct atomic `continue` command. It
is valid only for an `input_required` task: it records the message, cancels the
superseded open input interrupts, creates a new run and external bindings, and
returns the task to work. It cannot resurrect a terminal task, satisfy an
`auth_required` task, append concurrently to a working run, or bypass the
explicit structured-response semantics of `resume`.

Authorized get, cancel, and subscribe operations accept an explicit task-or-run,
internal-or-external selector; selecting a run addresses its owning task while
preserving run identity. Interrupt operations accept their own explicit selector.
External thread/task/run/message bindings are
created in the same submission transaction. Protocol adapters never resolve or
write mapping rows directly. Get, submit, and cancel return a bounded
`TaskView` containing the authorized task, runs, requested message history,
artifacts, interrupts, and last event sequence, so adapters never query
repositories to assemble a protocol response.

Task pages include an exact `totalSize` before pagination and accept a bounded
`updatedAfter` filter. Adapters may translate those neutral fields into native
list controls; protocol pagination structures are not stored in core.

For entities created after submission, adapters use the authorized
`ExternalIdentityPort.getOrCreate` operation to obtain stable protocol IDs.
This application operation scopes allocation by principal, protocol,
namespace, and entity kind; the underlying mapping repository remains private.

Adapters import inline or remote files through `AttachmentPort`, which enforces
tenant, SSRF, media, size, and digest policy before returning an
`AttachmentRef`. Authorized egress uses the same port to open a bounded stream
or mint a short-lived download URL. Protocol packages never reach blob storage
or fetch attachment URLs directly.
Ingress adapters derive a stable principal-scoped attachment idempotency key
from their message ID and part position. Replays return the prior stored
reference before repeating a remote fetch, and conflicting key reuse fails.

`ActionPort` descriptors use JSON Schema values because runtime providers also
need a portable schema vocabulary. MCP annotations and structured-result
wrappers are adapter-owned and are not part of the application contract. An
action has one schema source; protocol declarations and runtime validation MUST
be derived from it. Business failures are typed outcomes, while malformed
calls, missing actions, and authentication failures are application errors.
An action may return a neutral `input_required` outcome containing bounded
input requests and opaque continuation state; MCP maps this to its modern
multi-round-trip result without introducing protocol types into application.
On retry, fulfilled responses and the echoed state arrive in the neutral
`ActionInvocationContext.continuation`; adapters MUST NOT merge reserved fields
into the action's validated business input. Protocol-native response envelopes
are normalized to accepted values or declined/canceled status before crossing
the port.

## Canonical events

The executable schema is `TaskEventEnvelope` version `1`:

```ts
{
  version: 1
  eventId: EventId
  accountId: AccountId
  taskId: TaskId
  runId: RunId | null
  agentId: AgentId
  threadId: ThreadId
  seq: number
  time: number
  type: CanonicalEvent["type"]
  data: CanonicalEvent["data"]
  metadata: JsonObject
}
```

`seq` starts at 1 and is strictly monotonic per task. `(taskId, seq)` and
`eventId` are unique. Sequence allocation, domain mutation, event append, and
outbox insertion MUST commit atomically through transaction-scoped
repositories. `EventLog.stream` performs a gap-free committed replay followed
by a live tail; publication occurs only by draining committed outbox records.
Consumers deduplicate by `eventId`, order by `seq`, and resume after the last
fully applied sequence.

Runtime execution is claimed post-commit through `RunQueuePort`. Claims are
leased, bounded, and acknowledged only after the canonical run reaches an
interrupted or terminal state. Provider work never begins inside the database
transaction that creates a task or continuation.

The worker renews its lease while provider work is active. Loss of lease
ownership aborts the provider session and retries the durable work item; two
workers must never continue the same run concurrently.

The frozen event families are:

- task and run status changes, including interruption and resumption;
- message start, text delta, and message finish;
- safe reasoning-summary deltas;
- action start, argument delta, and finish;
- artifact changes;
- interrupt request and resolution;
- safe activity updates.

Unknown provider events are retained only as provider diagnostics. They are not
promoted to `RAW` or `CUSTOM` UI events without an explicit contract revision.
Malformed known events fail the run rather than being silently forwarded.

No events may be appended after a terminal run event for that run. A task can
have later events only when its state permits another run or interrupt
resolution. Snapshot plus replay MUST reduce to the same state as uninterrupted
delivery.

`message.started` reserves its canonical `MessageId` by inserting an empty
typed message in the same transaction as the event. `message.finished`
finalizes that same row using a guarded identity-preserving upsert. This keeps
protocol ID allocation referentially valid throughout a live stream and avoids
dual message identities.

## Protocol mappings

### MCP

MCP is a tool/resource protocol, not the internal event bus. `/mcp` is
stateless at the protocol layer and accepts POST only. Every request MUST use
`MCP-Protocol-Version: 2026-07-28`; required method/name routing headers and the
JSON-RPC body MUST agree. `initialize` and session IDs are not supported.

Authentication, Origin/Host policy, request caps, and abort propagation are
enforced before `ActionPort`. The public handler supports the final
`server/discover`/tool envelopes and modern multi-round-trip input results. If
a runtime provider only speaks an older MCP dialect, translation is private to
that provider adapter and does not change `/mcp`.

### A2A

A2A external tasks map to canonical `Task`; A2A messages and parts map to
`Message` and `ContentPart`; A2A artifacts map to canonical `Artifact`.
External context/task/message IDs are stored in a protocol-ID mapping table.

The Agent Card advertises exactly the implemented transport, authentication,
input/output modes, streaming, push, and skills. A2A task operations call
`AgentTaskPort`; they do not inspect database thread kinds. Streaming and
resubscription replay committed canonical events. Results are artifacts, never
status-message text conventions.

When composed, outbound A2A is persisted before network I/O. Discovery and
delivery enforce HTTPS outside an explicitly trusted loopback origin, complete
A/AAAA classification, connection-time IP pinning with the original Host and
TLS SNI, response limits, redirect rejection, deadlines, and tenancy. Ordinary
`fetch` is not a conforming connection primitive because it cannot prove which
resolved address was used. The current one-hop policy remains application
authorization policy rather than an A2A extension field.

### AG-UI

`POST /ag-ui/v1/run` accepts a validated `RunAgentInput` and emits official
`BaseEvent` objects over SSE. Client-supplied AG-UI `runId`, `threadId`, and
message IDs are external IDs and are mapped explicitly. After transactional
submission, the adapter opens the gap-free event stream from sequence zero;
committed replay followed by the live tail prevents an initial-event race.

AG-UI has no durable task identifier. `forwardedProps.openbot.taskId` is an
OpenBot continuation extension used only while a canonical task is waiting for
input or an interrupt response. A free-form follow-up selects `continue`; a
structured interrupt response selects `resume`. After success or failure, the
next conversational turn submits a new task with a new `runId` while retaining
the same external `threadId`; terminal tasks are never resurrected.

Each stream emits exactly one `RUN_STARTED` and exactly one terminal
`RUN_FINISHED` or `RUN_ERROR`. Message and tool event sequences are balanced.
Tool argument chunks concatenate to valid JSON before `TOOL_CALL_END`.
Canonical activity events use the official activity shape selected by the
pinned SDK. Private reasoning is dropped; summary reasoning uses official
reasoning events only when the selected SDK declares them stable.

The 0.0.59 request is validated with `RunAgentInputSchema` and requires
`threadId`, `runId`, `messages`, `tools`, and `context`; `forwardedProps` is
normalized before entering the application. Every emitted event validates with
the official `EventSchemas`, and completed streams pass `verifyEvents` plus
OpenBot's stricter terminal/boundary checks. A canonical interrupted run maps to
the pinned experimental interrupt outcome. A canceled run maps to `RUN_ERROR`
because this AG-UI version has no cancellation terminal event.

A network disconnect detaches a subscriber and does not cancel the run.
Explicit DELETE cancellation does. AG-UI 0.0.59 has no standard reconnect or
remote-cancel operation: replay and DELETE are clearly labeled OpenBot
extensions and are not expected to be used automatically by the official
client. Replay returns only committed events after `seq`; it cannot invent
success when a stream ended without a terminal event.

The browser consumes AG-UI events through a deterministic reducer. It MUST NOT
parse ACP event names. Non-run invalidations, such as roster or calendar
changes, remain on a separate typed notification channel.

The browser bootstraps a human conversation from
`GET /v1/agents/:agentId/conversation`; legacy thread messages and live-work
events are not its durable source of truth. The authenticated response is
either `{ conversation: null }` or a bounded conversation containing the
external AG-UI `threadId`, ordered public `messages`, and at most one `active`
task with external task/run/interrupt IDs, status, and replay cursor. Internal
canonical IDs, provider session references, private reasoning, and credentials
MUST NOT cross this boundary. Browser storage MAY retain an optimistic display
cache, but it MUST reconcile against this resource after navigation or reload.

The browser's calendar capture request is also explicit at this boundary.
`POST /v1/calendar/learn` accepts either strict `{ agentId }` for a human
conversation or strict `{ threadId, botId? }` for a group, never both. Human
capture reads only the bounded canonical AG-UI `user` and `agent` messages for
the authenticated subject; it does not fall back to legacy human messages,
live-work, system/tool content, or another subject's protocol identities.

## Persistence requirements

The durable adapter provides tasks, runs, artifacts, interrupts, protocol ID
mappings, canonical events, idempotency records, and an outbox. Migrations
preserve user data but replace obsolete protocol columns and conventions in one
direction. There are no dual reads or dual writes.

At minimum, storage enforces:

- unique external IDs within
  `(account, subject, protocol, namespace, entity kind)`;
- unique idempotency keys within `(principal, operation)`;
- unique `event_id` and `(task_id, seq)`;
- one open resolution per interrupt;
- legal state transitions under a write transaction;
- leases for queued work, and for any future outbound delivery, so concurrent
  workers cannot double-process the same durable record.

Canceling a task atomically cancels every open interrupt for that task. A
later interrupt response cannot resurrect a canceled task or enqueue another
run.

## Error and transport policy

Application errors use the stable codes in `ApplicationErrorCode`. Protocol
adapters map those codes to their native error/status vocabulary and preserve
retryability; core never imports protocol error classes.

Request bodies, streamed chunks, event payloads, action output, and replay
pages have explicit byte/count limits. Canonical file content is a bounded
`AttachmentRef` with blob identity, size, media type, and digest; remote URLs
and inline bytes are resolved at protocol ingress under SSRF and storage policy.
Client-visible metadata is key/count/byte bounded. Secrets and bearer
credentials MUST NOT appear in canonical events, protocol metadata, logs,
runner environment echoes, or error details. Correlation and W3C trace metadata
may be carried as public metadata but never used as authorization identity.

## Contract change procedure

A change to any frozen name, enum, envelope field, lifecycle rule, endpoint,
or dependency direction requires all of the following:

1. an ADR amendment describing the incompatibility and migration;
2. a new major contract/event profile when persisted or externally visible;
3. schema fixtures and negative tests;
4. mappings for MCP, A2A, and AG-UI where applicable;
5. boundary, type, focused contract, replay, and full regression gates.

Provider-specific additions that remain inside `RuntimeProviderConfig.options`
and protocol-private metadata do not revise the core contract.

## Executable freeze gates

The frozen baseline is accepted only when all of these gates pass:

- `check:contracts`: core schemas, lifecycle, application authorization, and
  atomic use cases;
- `check:persistence`: SQLite constraints, identity scope, outbox ordering,
  idempotency, and leases;
- `check:protocols`: official MCP, A2A, and AG-UI client/schema oracles plus the
  pinned A2A network primitive;
- `check:runtime`: provider mapping, lease behavior, pause/resume correlation,
  and live AG-UI/A2A-to-runtime execution;
- `check:boundaries`: package dependency direction;
- the full regression suite and release build.

The protocol packages pin exact oracle versions. Updating an oracle is a
contract review, not dependency housekeeping.

## Normative protocol references

- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP TypeScript SDK server 2.0.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol/server%402.0.0)
- [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/)
- [A2A JavaScript SDK 1.1.0](https://github.com/a2aproject/a2a-js/releases/tag/v1.1.0)
- [AG-UI draft specification](https://docs.ag-ui.com/spec/draft/index.md)
- [AG-UI HTTP/SSE transport](https://docs.ag-ui.com/spec/draft/basic/transports/http-sse.md)
