import { describe, expect, test } from "bun:test";
import {
  compactEdDsaJws,
  FedJwsError,
  generateEd25519,
  signFedJws,
  verifyFedJws,
} from "@openbot/federation";

const fromOrg = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const toOrg = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const msgId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const nowSec = 1_700_000_000;
const body = JSON.stringify({ id: msgId, hop: 1 });

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error(`expected FedJwsError ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(FedJwsError);
    expect((err as FedJwsError).code).toBe(code);
  }
}

describe("federation JWS", () => {
  test("sign then verify round-trip", () => {
    const kp = generateEd25519();
    const token = signFedJws({
      privateKey: kp.privateKey,
      fromOrgId: fromOrg,
      toOrgId: toOrg,
      messageId: msgId,
      rawBody: body,
      nowSec,
    });
    const payload = verifyFedJws(token, {
      publicKey: kp.publicKeyRawB64,
      expectedAud: toOrg,
      expectedJti: msgId,
      rawBody: body,
      nowSec,
    });
    expect(payload.iss).toBe(fromOrg);
    expect(payload.aud).toBe(toOrg);
    expect(payload.jti).toBe(msgId);
    expect(payload.scope).toBe("fed.messages");
    expect(payload.exp - payload.iat).toBe(120);
  });

  test("wrong alg", () => {
    const kp = generateEd25519();
    const token = compactEdDsaJws(
      { alg: "HS256", typ: "JWT", kid: fromOrg },
      {
        iss: fromOrg,
        aud: toOrg,
        iat: nowSec,
        exp: nowSec + 120,
        jti: msgId,
        scope: "fed.messages",
        bth: "00",
      },
      kp.privateKey,
    );
    expectCode(
      () =>
        verifyFedJws(token, {
          publicKey: kp.publicKeyRawB64,
          expectedAud: toOrg,
          expectedJti: msgId,
          rawBody: body,
          nowSec,
        }),
      "alg",
    );
  });

  test("truncated sig", () => {
    const kp = generateEd25519();
    const token = signFedJws({
      privateKey: kp.privateKey,
      fromOrgId: fromOrg,
      toOrgId: toOrg,
      messageId: msgId,
      rawBody: body,
      nowSec,
    });
    const parts = token.split(".");
    const truncated = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, 12)}`;
    expectCode(
      () =>
        verifyFedJws(truncated, {
          publicKey: kp.publicKeyRawB64,
          expectedAud: toOrg,
          expectedJti: msgId,
          rawBody: body,
          nowSec,
        }),
      "truncated",
    );
  });

  test("aud mismatch", () => {
    const kp = generateEd25519();
    const token = signFedJws({
      privateKey: kp.privateKey,
      fromOrgId: fromOrg,
      toOrgId: toOrg,
      messageId: msgId,
      rawBody: body,
      nowSec,
    });
    expectCode(
      () =>
        verifyFedJws(token, {
          publicKey: kp.publicKeyRawB64,
          expectedAud: "dddddddd-dddd-dddd-dddd-dddddddddddd",
          expectedJti: msgId,
          rawBody: body,
          nowSec,
        }),
      "aud",
    );
  });

  test("iss !== kid", () => {
    const kp = generateEd25519();
    const token = compactEdDsaJws(
      { alg: "EdDSA", typ: "JWT", kid: fromOrg },
      {
        iss: toOrg,
        aud: toOrg,
        iat: nowSec,
        exp: nowSec + 120,
        jti: msgId,
        scope: "fed.messages",
        bth: "00",
      },
      kp.privateKey,
    );
    expectCode(
      () =>
        verifyFedJws(token, {
          publicKey: kp.publicKeyRawB64,
          expectedAud: toOrg,
          expectedJti: msgId,
          rawBody: body,
          nowSec,
        }),
      "bind",
    );
  });

  test("jti !== body.id", () => {
    const kp = generateEd25519();
    const token = signFedJws({
      privateKey: kp.privateKey,
      fromOrgId: fromOrg,
      toOrgId: toOrg,
      messageId: msgId,
      rawBody: body,
      nowSec,
    });
    expectCode(
      () =>
        verifyFedJws(token, {
          publicKey: kp.publicKeyRawB64,
          expectedAud: toOrg,
          expectedJti: "dddddddd-dddd-dddd-dddd-dddddddddddd",
          rawBody: body,
          nowSec,
        }),
      "bind",
    );
  });

  test("future iat", () => {
    const kp = generateEd25519();
    const token = signFedJws({
      privateKey: kp.privateKey,
      fromOrgId: fromOrg,
      toOrgId: toOrg,
      messageId: msgId,
      rawBody: body,
      nowSec: nowSec + 120,
    });
    expectCode(
      () =>
        verifyFedJws(token, {
          publicKey: kp.publicKeyRawB64,
          expectedAud: toOrg,
          expectedJti: msgId,
          rawBody: body,
          nowSec,
        }),
      "iat",
    );
  });

  test("expired exp", () => {
    const kp = generateEd25519();
    const token = signFedJws({
      privateKey: kp.privateKey,
      fromOrgId: fromOrg,
      toOrgId: toOrg,
      messageId: msgId,
      rawBody: body,
      nowSec: nowSec - 200,
    });
    expectCode(
      () =>
        verifyFedJws(token, {
          publicKey: kp.publicKeyRawB64,
          expectedAud: toOrg,
          expectedJti: msgId,
          rawBody: body,
          nowSec,
        }),
      "exp",
    );
  });

  test("bth mismatch", () => {
    const kp = generateEd25519();
    const token = signFedJws({
      privateKey: kp.privateKey,
      fromOrgId: fromOrg,
      toOrgId: toOrg,
      messageId: msgId,
      rawBody: body,
      nowSec,
    });
    expectCode(
      () =>
        verifyFedJws(token, {
          publicKey: kp.publicKeyRawB64,
          expectedAud: toOrg,
          expectedJti: msgId,
          rawBody: JSON.stringify({ id: msgId, hop: 2 }),
          nowSec,
        }),
      "bth",
    );
  });
});
