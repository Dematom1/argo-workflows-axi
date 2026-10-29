import type { WriteOperationId } from "./registry.js";

/**
 * Proof that the write gate approved one write. `src/gate.ts` mints these;
 * the seam refuses to run a write operation without one.
 */
export interface WriteApproval {
  readonly op: WriteOperationId;
  readonly [APPROVAL]: true;
}

const APPROVAL: unique symbol = Symbol("argo-workflows-axi.write-approval");
const minted = new WeakSet<object>();

export function mintApproval(op: WriteOperationId): WriteApproval {
  const approval: WriteApproval = Object.freeze({
    op,
    [APPROVAL]: true as const,
  });
  minted.add(approval);
  return approval;
}

export function isApprovalFor(
  value: unknown,
  op: WriteOperationId,
): value is WriteApproval {
  return (
    typeof value === "object" &&
    value !== null &&
    minted.has(value) &&
    (value as WriteApproval).op === op
  );
}
