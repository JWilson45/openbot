import type {
  ExternalEntityRef,
  ExternalIdentityBinding,
  ExternalIdentityPort,
  ExternalIdentityTarget,
  ProtocolPrincipal,
} from "@openbot/application";
import { externalIdSchema, type ExternalId } from "@openbot/core";
import { AG_UI_PROTOCOL, AgUiAdapterError } from "./types.ts";

export type AgUiIdentityKind = ExternalEntityRef["kind"];

export function agUiExternalRef<K extends AgUiIdentityKind>(
  namespace: string,
  kind: K,
  externalId: string,
): ExternalEntityRef & { kind: K } {
  const parsed = externalIdSchema.safeParse(externalId);
  if (!parsed.success) {
    throw new AgUiAdapterError(
      "invalid_external_id",
      `Invalid AG-UI ${kind} identifier`,
      400,
      { cause: parsed.error },
    );
  }
  return {
    protocol: AG_UI_PROTOCOL,
    namespace,
    kind,
    externalId: parsed.data,
  } as ExternalEntityRef & { kind: K };
}

/**
 * Allocates and verifies all external identifiers through the application port.
 * Internal UUIDs are deliberately never used as protocol identifiers.
 */
export class AgUiIdentityMap {
  private readonly cache = new Map<string, ExternalId>();

  constructor(
    private readonly identities: ExternalIdentityPort,
    private readonly principal: ProtocolPrincipal,
    readonly namespace: string,
  ) {}

  ref<K extends AgUiIdentityKind>(kind: K, externalId: string): ExternalEntityRef & { kind: K } {
    return agUiExternalRef(this.namespace, kind, externalId);
  }

  async resolve<K extends AgUiIdentityKind>(
    kind: K,
    externalId: string,
  ): Promise<Extract<ExternalIdentityBinding, { ref: { kind: K } }> | null> {
    const binding = await this.identities.resolve(this.principal, this.ref(kind, externalId));
    if (binding === null) return null;
    this.assertBinding(binding, kind);
    return binding as Extract<ExternalIdentityBinding, { ref: { kind: K } }>;
  }

  async externalId(target: ExternalIdentityTarget): Promise<string> {
    const key = `${target.kind}:${target.internalId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const binding = await this.identities.getOrCreate(this.principal, target);
    this.assertBinding(binding, target.kind);
    this.cache.set(key, binding.ref.externalId);
    return binding.ref.externalId;
  }

  private assertBinding(binding: ExternalIdentityBinding, expectedKind: AgUiIdentityKind): void {
    if (
      binding.ref.protocol !== AG_UI_PROTOCOL ||
      binding.ref.namespace !== this.namespace ||
      binding.ref.kind !== expectedKind
    ) {
      throw new AgUiAdapterError(
        "identity_boundary_violation",
        "The external identity port returned a binding outside the AG-UI namespace",
        500,
      );
    }
    const parsed = externalIdSchema.safeParse(binding.ref.externalId);
    if (!parsed.success) {
      throw new AgUiAdapterError(
        "identity_boundary_violation",
        "The external identity port returned an invalid external identifier",
        500,
        { cause: parsed.error },
      );
    }
  }
}
