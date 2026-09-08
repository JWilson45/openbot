import type {
  ExternalEntityRef,
  ExternalIdentityBinding,
  ExternalIdentityPort,
  ExternalIdentityTarget,
  ProtocolPrincipal,
} from "@openbot/application";
import { externalIdSchema, type ExternalId } from "@openbot/core";
import { InvalidAgentResponseError, RequestMalformedError } from "@a2a-js/sdk/errors";
import { A2A_PROTOCOL } from "./types.ts";

export type A2AIdentityKind = ExternalEntityRef["kind"];

export function a2aExternalRef<K extends A2AIdentityKind>(
  namespace: string,
  kind: K,
  externalId: string,
): ExternalEntityRef & { kind: K } {
  const parsed = externalIdSchema.safeParse(externalId);
  if (!parsed.success) {
    throw new RequestMalformedError(`Invalid A2A ${kind} identifier`);
  }
  return {
    protocol: A2A_PROTOCOL,
    namespace,
    kind,
    externalId: parsed.data,
  } as ExternalEntityRef & { kind: K };
}

/** All A2A wire identifiers are resolved or allocated by the application identity port. */
export class A2AIdentityMap {
  readonly #cache = new Map<string, ExternalId>();

  constructor(
    private readonly identities: ExternalIdentityPort,
    private readonly principal: ProtocolPrincipal,
    readonly namespace: string,
  ) {}

  ref<K extends A2AIdentityKind>(kind: K, externalId: string): ExternalEntityRef & { kind: K } {
    return a2aExternalRef(this.namespace, kind, externalId);
  }

  async resolve<K extends A2AIdentityKind>(
    kind: K,
    externalId: string,
  ): Promise<(ExternalIdentityBinding & { ref: { kind: K } }) | null> {
    const binding = await this.identities.resolve(this.principal, this.ref(kind, externalId));
    if (binding === null) return null;
    this.#assertBinding(binding, kind);
    return binding as ExternalIdentityBinding & { ref: { kind: K } };
  }

  async externalId(target: ExternalIdentityTarget): Promise<string> {
    const key = `${target.kind}:${target.internalId}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;

    const binding = await this.identities.getOrCreate(this.principal, target);
    this.#assertBinding(binding, target.kind);
    this.#cache.set(key, binding.ref.externalId);
    return binding.ref.externalId;
  }

  #assertBinding(binding: ExternalIdentityBinding, expectedKind: A2AIdentityKind): void {
    if (
      binding.ref.protocol !== A2A_PROTOCOL ||
      binding.ref.namespace !== this.namespace ||
      binding.ref.kind !== expectedKind
    ) {
      throw new InvalidAgentResponseError(
        "The external identity port returned a binding outside the A2A namespace",
      );
    }
    if (!externalIdSchema.safeParse(binding.ref.externalId).success) {
      throw new InvalidAgentResponseError(
        "The external identity port returned an invalid A2A identifier",
      );
    }
  }
}

