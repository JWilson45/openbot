import { describe, expect, test } from "bun:test";
import {
  accountIdSchema,
  agentIdSchema,
  conversationSchema,
  externalIdSchema,
  interruptIdSchema,
  interruptSchema,
  messageSchema,
  runIdSchema,
  runSchema,
  taskIdSchema,
  taskSchema,
} from "../packages/core/src/index.ts";
import { OpenbotDb, SqliteApplicationStore, SqliteRunQueue } from "../packages/db/src/index.ts";

const rawUuid = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

function fixture() {
  const db = OpenbotDb.open(":memory:");
  const accountId = accountIdSchema.parse(rawUuid("1"));
  const agentId = agentIdSchema.parse(rawUuid("2"));
  const threadId = conversationSchema.shape.id.parse(rawUuid("3"));
  const taskId = taskIdSchema.parse(rawUuid("4"));
  const runId = runIdSchema.parse(rawUuid("5"));
  db.run("INSERT INTO accounts(id, auth_user_id, created_at) VALUES (?, ?, ?)", [accountId, rawUuid("90"), 1]);
  db.run(
    `INSERT INTO bots
     (id, account_id, name, description, status, provider_id, runtime_config_json, created_at, updated_at)
     VALUES (?, ?, 'Ada', '', 'active', 'grok', ?, 1, 1)`,
    [agentId, accountId, JSON.stringify({ providerId: "grok", modelId: "grok-4.6", options: {} })],
  );
  const store = new SqliteApplicationStore(db);
  store.transaction((tx) => {
    tx.conversations.create(
      conversationSchema.parse({ id: threadId, accountId, title: null, metadata: {}, createdAt: 1, updatedAt: 1 }),
    );
    tx.tasks.create(
      taskSchema.parse({ id: taskId, accountId, threadId, agentId, status: "submitted", metadata: {}, createdAt: 1, updatedAt: 1 }),
    );
    tx.runs.create(
      runSchema.parse({
        id: runId,
        accountId,
        taskId,
        threadId,
        agentId,
        attempt: 1,
        status: "queued",
        providerSessionRef: null,
        metadata: {},
        createdAt: 1,
        startedAt: null,
        finishedAt: null,
      }),
    );
  });
  return { db, store, accountId, agentId, threadId, taskId, runId };
}

describe("canonical SQLite task store", () => {
  test("one-way migration preserves legacy conversations, turns, and messages with distinct task/run ids", () => {
    const db = OpenbotDb.open(":memory:");
    const accountId = rawUuid("21");
    const agentId = rawUuid("22");
    const threadId = rawUuid("23");
    const turnId = rawUuid("24");
    const messageId = rawUuid("25");
    db.run("INSERT INTO accounts(id, auth_user_id, created_at) VALUES (?, ?, 1)", [accountId, rawUuid("91")]);
    db.run(
      "INSERT INTO bots(id, account_id, name, description, status, created_at) VALUES (?, ?, 'Ada', '', 'active', 1)",
      [agentId, accountId],
    );
    db.run(
      "INSERT INTO threads(id, account_id, bot_id, title, kind, created_at) VALUES (?, ?, ?, 'Old thread', 'human', 2)",
      [threadId, accountId, agentId],
    );
    db.run(
      "INSERT INTO turns(id, thread_id, bot_id, status, created_at) VALUES (?, ?, ?, 'completed', 3)",
      [turnId, threadId, agentId],
    );
    db.run(
      "INSERT INTO messages(id, thread_id, turn_id, role, origin, body, created_at) VALUES (?, ?, ?, 'assistant', 'fallback', 'hello', 4)",
      [messageId, threadId, turnId],
    );

    db.migrate();
    db.migrate();
    const mapped = db.get<{ agent_task_id: string; agent_run_id: string }>(
      "SELECT agent_task_id, agent_run_id FROM turns WHERE id = ?",
      [turnId],
    );
    expect(mapped?.agent_task_id).not.toBe(turnId);
    expect(mapped?.agent_run_id).not.toBe(turnId);
    expect(mapped?.agent_run_id).not.toBe(mapped?.agent_task_id);
    expect(db.get<{ status: string }>("SELECT status FROM agent_tasks WHERE id = ?", [mapped!.agent_task_id])?.status).toBe("completed");
    expect(db.get<{ role: string }>("SELECT role FROM agent_messages WHERE id = ?", [messageId])?.role).toBe("agent");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks")?.n).toBe(1);
    db.close();
  });

  test("allocates monotonic event sequences and persists a committed outbox", async () => {
    const f = fixture();
    f.store.transaction((tx) => {
      tx.events.append({
        accountId: f.accountId,
        taskId: f.taskId,
        runId: null,
        agentId: f.agentId,
        threadId: f.threadId,
        event: { type: "task.status.changed", data: { from: null, to: "submitted" } },
      });
      tx.events.append({
        accountId: f.accountId,
        taskId: f.taskId,
        runId: f.runId,
        agentId: f.agentId,
        threadId: f.threadId,
        event: { type: "run.status.changed", data: { from: null, to: "queued" } },
      });
      expect(tx.events.lastSeq(f.accountId, f.taskId)).toBe(2);
    });

    const events = await f.store.read(f.accountId, f.taskId, 0, 100);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
    expect(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM application_outbox")?.n).toBe(2);
    expect(f.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM application_outbox WHERE delivered_at IS NOT NULL")?.n).toBe(2);
    f.db.close();
  });

  test("stream has gap-free replay then live tail and stops on abort", async () => {
    const f = fixture();
    f.store.transaction((tx) => {
      tx.events.append({
        accountId: f.accountId,
        taskId: f.taskId,
        runId: null,
        agentId: f.agentId,
        threadId: f.threadId,
        event: { type: "task.status.changed", data: { from: null, to: "submitted" } },
      });
    });

    const controller = new AbortController();
    const iterator = f.store.stream(f.accountId, f.taskId, 0, controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.seq).toBe(1);
    const live = iterator.next();
    f.store.transaction((tx) => {
      tx.events.append({
        accountId: f.accountId,
        taskId: f.taskId,
        runId: f.runId,
        agentId: f.agentId,
        threadId: f.threadId,
        event: { type: "run.status.changed", data: { from: "queued", to: "running" } },
      });
    });
    expect((await live).value?.seq).toBe(2);
    controller.abort();
    expect((await iterator.next()).done).toBe(true);
    f.db.close();
  });

  test("rejects inconsistent identities and events after a terminal run event", () => {
    const f = fixture();
    expect(() =>
      f.store.transaction((tx) =>
        tx.events.append({
          accountId: f.accountId,
          taskId: f.taskId,
          runId: f.runId,
          agentId: agentIdSchema.parse(rawUuid("77")),
          threadId: f.threadId,
          event: { type: "activity.updated", data: { label: "bad" } },
        }),
      ),
    ).toThrow("event aggregate identity does not match task");

    f.store.transaction((tx) => {
      tx.events.append({
        accountId: f.accountId,
        taskId: f.taskId,
        runId: f.runId,
        agentId: f.agentId,
        threadId: f.threadId,
        event: { type: "run.status.changed", data: { from: "running", to: "completed" } },
      });
    });
    expect(() =>
      f.store.transaction((tx) =>
        tx.events.append({
          accountId: f.accountId,
          taskId: f.taskId,
          runId: f.runId,
          agentId: f.agentId,
          threadId: f.threadId,
          event: { type: "activity.updated", data: { label: "late" } },
        }),
      ),
    ).toThrow("run already ended");
    f.db.close();
  });

  test("repositories are account and subject scoped and external identity lookup is bidirectional", () => {
    const f = fixture();
    f.store.transaction((tx) => {
      const message = messageSchema.parse({
        id: rawUuid("6"),
        accountId: f.accountId,
        threadId: f.threadId,
        taskId: f.taskId,
        runId: f.runId,
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
        metadata: {},
        createdAt: 2,
      });
      const peerMessage = messageSchema.parse({ ...message, id: rawUuid("7"), createdAt: 3 });
      tx.messages.append(message);
      tx.messages.append(peerMessage);
      const ref = {
        protocol: "a2a",
        namespace: "peer.example",
        kind: "message" as const,
        externalId: externalIdSchema.parse("remote-message-1"),
      };
      tx.externalIdentities.bind(f.accountId, "peer-a", { ref, internalId: message.id });
      tx.externalIdentities.bind(f.accountId, "peer-b", { ref, internalId: peerMessage.id });
      expect(tx.externalIdentities.resolve(f.accountId, "peer-a", ref)?.internalId).toBe(message.id);
      expect(tx.externalIdentities.resolve(f.accountId, "peer-b", ref)?.internalId).toBe(peerMessage.id);
      expect(
        tx.externalIdentities.findByInternal(f.accountId, "peer-a", {
          protocol: ref.protocol,
          namespace: ref.namespace,
          kind: ref.kind,
          internalId: message.id,
        })?.ref.externalId,
      ).toBe(ref.externalId);
      expect(tx.externalIdentities.findByInternal(f.accountId, "peer-b", {
        protocol: ref.protocol,
        namespace: ref.namespace,
        kind: ref.kind,
        internalId: message.id,
      })).toBeNull();
      expect(tx.messages.get(accountIdSchema.parse(rawUuid("99")), message.id)).toBeNull();
    });
    f.db.close();
  });

  test("leases, acknowledges, and retries committed runtime work", async () => {
    const f = fixture();
    f.store.transaction((tx) => {
      tx.outbox.enqueue({
        id: `run-queued:${f.runId}`,
        accountId: f.accountId,
        topic: "run.queued",
        payload: {
          accountId: f.accountId,
          taskId: f.taskId,
          runId: f.runId,
          threadId: f.threadId,
          agentId: f.agentId,
          attempt: 1,
        },
        createdAt: 10,
      });
    });
    const queue = new SqliteRunQueue(f.db);
    const first = await queue.claim("worker-a", 10, 100, 10);
    expect(first).toEqual([{
      kind: "execute",
      outboxId: `run-queued:${f.runId}`,
      accountId: f.accountId,
      taskId: f.taskId,
      runId: f.runId,
      threadId: f.threadId,
      agentId: f.agentId,
      attempt: 1,
      continuationInterruptIds: [],
    }]);
    expect(await queue.claim("worker-b", 11, 101, 10)).toEqual([]);
    expect(await queue.renew("worker-b", first[0]!.outboxId, 20, 200)).toBe(false);
    expect(await queue.renew("worker-a", first[0]!.outboxId, 20, 200)).toBe(true);
    expect(await queue.claim("worker-b", 101, 201, 10)).toEqual([]);
    await queue.retry("worker-a", first[0]!.outboxId, 50, "provider offline");
    expect(await queue.claim("worker-b", 49, 149, 10)).toEqual([]);
    const retried = await queue.claim("worker-b", 50, 150, 10);
    expect(retried).toHaveLength(1);
    await queue.acknowledge("worker-b", retried[0]!.outboxId, 60);
    expect(await queue.claim("worker-c", 200, 300, 10)).toEqual([]);
    expect(f.db.get<{ attempts: number; last_error: string | null; delivered_at: number }>(
      "SELECT attempts, last_error, delivered_at FROM application_outbox WHERE id = ?",
      [first[0]!.outboxId],
    )).toEqual({ attempts: 2, last_error: null, delivered_at: 60 });
    f.db.close();
  });

  test("keeps provider interrupt references in a private tenant-scoped correlation table", () => {
    const f = fixture();
    const interruptId = interruptIdSchema.parse(rawUuid("8"));
    f.store.transaction((tx) => {
      tx.interrupts.put(interruptSchema.parse({
        id: interruptId,
        accountId: f.accountId,
        taskId: f.taskId,
        runId: f.runId,
        kind: "permission",
        prompt: "Allow this action?",
        responseSchema: { type: "boolean" },
        status: "open",
        createdAt: 2,
        expiresAt: null,
        resolvedAt: null,
        metadata: {},
      }));
      tx.runtimeCorrelations.bindInterrupt({
        accountId: f.accountId,
        taskId: f.taskId,
        runId: f.runId,
        interruptId,
        providerRequestRef: "private-provider-request-7",
      });
      expect(tx.runtimeCorrelations.getInterrupt(f.accountId, interruptId)?.providerRequestRef).toBe(
        "private-provider-request-7",
      );
      expect(tx.runtimeCorrelations.getInterrupt(accountIdSchema.parse(rawUuid("99")), interruptId)).toBeNull();
    });
    const eventJson = f.db.all<{ event_json: string }>("SELECT event_json FROM task_events");
    expect(JSON.stringify(eventJson)).not.toContain("private-provider-request-7");
    f.db.close();
  });
});
