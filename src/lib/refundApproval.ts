// A refund above the tenant's limit needs two different approvers. A refund at
// or below the limit, or with no limit set, needs one. A rejection always needs one.
export type ApprovalStep =
  | { kind: "FINAL" }
  | { kind: "FIRST" }
  | { kind: "BLOCKED"; code: string; message: string };

export function approvalStep(input: {
  limitMinor: bigint | null;
  amountMinor: bigint;
  firstApprovedBy: string | null;
  actor: string;
  decision: "APPROVED" | "REJECTED";
}): ApprovalStep {
  if (input.decision === "REJECTED") return { kind: "FINAL" };
  if (input.limitMinor === null || input.amountMinor <= input.limitMinor) return { kind: "FINAL" };
  if (input.firstApprovedBy === null) return { kind: "FIRST" };
  if (input.firstApprovedBy === input.actor) {
    return {
      kind: "BLOCKED",
      code: "second_approver_required",
      message: "This refund is above the approval limit. A different person must give the second approval.",
    };
  }
  return { kind: "FINAL" };
}
