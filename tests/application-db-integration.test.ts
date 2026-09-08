import { describe, expect, test } from "bun:test";
import { DefaultApplicationService } from "@openbot/application";
import { accountIdSchema, agentIdSchema, externalIdSchema } from "@openbot/core";
import { OpenbotDb, SqliteApplicationStore, SqliteRunQueue, id, uuidIdGenerator } from "@openbot/db";
import { validateJsonSchema } from "../apps/server/src/json-schema-validator.ts";

describe("application and SQLite integration", () => {
  test("commits one event/outbox record per mutation and exposes leased run work", async () => {
    const db = OpenbotDb.open(":memory:");
    const userId = id();
    const accountId = accountIdSchema.parse(id());
    const agentId = agentIdSchema.parse(id());
    db.run("INSERT INTO users(id, github_login, created_at) VALUES (?, 'contract-db', 1)", [userId]);
    db.run("INSERT INTO accounts(id, auth_user_id, created_at) VALUES (?, ?, 1)", [accountId, userId]);
    db.run(
      `INSERT INTO bots
       (id, account_id, name, description, status, provider_id, runtime_config_json, created_at, updated_at)
       VALUES (?, ?, 'Ada', '', 'active', 'grok', ?, 1, 1)`,
      [agentId, accountId, JSON.stringify({ providerId: "grok", modelId: "grok-4.6", options: {} })],
    );
    const store = new SqliteApplicationStore(db);
    const service = new DefaultApplicationService({
      unitOfWork: store,
      eventLog: store,
      ids: uuidIdGenerator,
      clock: { now: () => 10 },
      responseValidator: { validate: validateJsonSchema },
    });
    const principal = { accountId, subjectId: "user:test", kind: "user" as const, scopes: ["tasks:*"] };
    const view = await service.submit({
      principal,
      agentId,
      message: { role: "user", parts: [{ kind: "text", text: "hello" }] },
    });
    expect(view.lastSeq).toBe(4);
    expect((await store.read(accountId, view.task.id, 0, 20)).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM application_outbox WHERE topic = 'task.event'")?.n).toBe(4);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM application_outbox WHERE topic = 'run.queued'")?.n).toBe(1);
    const work = await new SqliteRunQueue(db).claim("test-worker", 10, 100, 10);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ kind: "execute", taskId: view.task.id, continuationInterruptIds: [] });
    expect((await service.list({ principal, limit: 10 })).totalSize).toBe(1);

    const peerPrincipal = { ...principal, subjectId: "peer:test" };
    const sharedTaskRef = {
      protocol: "a2a",
      namespace: "https://peer.example/a2a/v1",
      kind: "task" as const,
      externalId: externalIdSchema.parse("same-remote-task"),
    };
    const firstScoped = await service.submit({
      principal,
      agentId,
      externalRefs: { task: sharedTaskRef },
      message: { role: "user", parts: [{ kind: "text", text: "first peer" }] },
    });
    const secondScoped = await service.submit({
      principal: peerPrincipal,
      agentId,
      externalRefs: { task: sharedTaskRef },
      message: { role: "user", parts: [{ kind: "text", text: "second peer" }] },
    });
    expect((await service.resolve(principal, sharedTaskRef))?.internalId).toBe(firstScoped.task.id);
    expect((await service.resolve(peerPrincipal, sharedTaskRef))?.internalId).toBe(secondScoped.task.id);
    expect(db.all<{ subject_id: string }>(
      "SELECT subject_id FROM protocol_identities WHERE external_id = ? ORDER BY subject_id",
      [sharedTaskRef.externalId],
    ).map((row) => row.subject_id)).toEqual(["peer:test", "user:test"]);

    const responseTarget = {
      protocol: "a2a",
      namespace: "https://peer.example/a2a/v1",
      kind: "task" as const,
      internalId: view.task.id,
    };
    const firstResponseId = await service.getOrCreate(principal, responseTarget);
    const secondResponseId = await service.getOrCreate(peerPrincipal, responseTarget);
    expect(firstResponseId.ref.externalId).not.toBe(secondResponseId.ref.externalId);
    expect(await service.getOrCreate(principal, responseTarget)).toEqual(firstResponseId);
    expect(await service.getOrCreate(peerPrincipal, responseTarget)).toEqual(secondResponseId);
    expect(await service.resolve(peerPrincipal, firstResponseId.ref)).toBeNull();
    db.close();
  });
});
