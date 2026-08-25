import { Errors } from "@/lib/errors";
import type { SessionUser } from "@/lib/auth/session";

export const ROLES = {
  COSTING_USER: "costing_user",
  SUPER_ADMIN: "super_admin",
  AUDITOR: "auditor",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export function hasRole(user: SessionUser, role: Role): boolean {
  return user.roles.includes(role);
}

/**
 * Central owner-based + role-based authorization policy (03_Roles_and_Access).
 * Every mutating API route calls one of these instead of inlining its own
 * check, so the access matrix has exactly one implementation to audit.
 * Default-deny: anything not explicitly allowed below throws.
 */
export const policy = {
  /** All authenticated roles may list/view any costing (DEC-003, DEC-018). Read is never denied by ownership. */
  canViewCosting(_user: SessionUser): true {
    return true;
  },

  /**
   * Only the owner may mutate a Draft/Calculated costing; Super Admin only after
   * an explicit reassignment makes them owner. Ownership is checked before state:
   * a non-owner always gets COSTING_READ_ONLY, even on a finalized record — the
   * reason they can't edit is "not yours," not "it's locked."
   */
  assertCanEditCosting(user: SessionUser, costing: { ownerUserId: string; status: string }): void {
    if (costing.ownerUserId !== user.userId) {
      throw Errors.costingReadOnly();
    }
    if (costing.status === "finalized" || costing.status === "revised" || costing.status === "voided") {
      throw Errors.costingLocked();
    }
  },

  /** Creating a costing is allowed for any authenticated costing_user or super_admin; the creator becomes owner. */
  assertCanCreateCosting(user: SessionUser): void {
    if (!hasRole(user, ROLES.COSTING_USER) && !hasRole(user, ROLES.SUPER_ADMIN)) {
      throw Errors.forbidden();
    }
  },

  /** Any reader may duplicate a readable costing into a new draft they own. */
  assertCanDuplicateCosting(user: SessionUser): void {
    if (!hasRole(user, ROLES.COSTING_USER) && !hasRole(user, ROLES.SUPER_ADMIN)) {
      throw Errors.forbidden();
    }
  },

  /**
   * Deleting is a stricter form of editing: only the owner, and only while the
   * costing is still Draft/Calculated. Once a quotation number is issued the
   * record must survive — Void is the reason-bearing act for that case.
   */
  assertCanDeleteCosting(user: SessionUser, costing: { ownerUserId: string; status: string }): void {
    if (costing.ownerUserId !== user.userId) {
      throw Errors.costingReadOnly();
    }
    if (costing.status !== "draft" && costing.status !== "calculated") {
      throw Errors.costingLocked();
    }
  },

  /**
   * The PO flag is commercial tracking layered on top of a quotation, not part
   * of the costing itself, so unlike every other mutation it stays available
   * after finalization — that is precisely when a PO can arrive. Owner or
   * Super Admin may set it; a voided costing never converts.
   */
  assertCanMarkPo(user: SessionUser, costing: { ownerUserId: string; status: string }): void {
    if (costing.ownerUserId !== user.userId && !hasRole(user, ROLES.SUPER_ADMIN)) {
      throw Errors.costingReadOnly();
    }
    if (costing.status === "voided") {
      throw Errors.costingLocked();
    }
  },

  assertIsSuperAdmin(user: SessionUser): void {
    if (!hasRole(user, ROLES.SUPER_ADMIN)) {
      throw Errors.forbidden();
    }
  },

  /** VER-004: guide compare/diff is read-only, available to Super Admin and Auditor (not Costing User). */
  assertCanViewGuideDiff(user: SessionUser): void {
    if (!hasRole(user, ROLES.SUPER_ADMIN) && !hasRole(user, ROLES.AUDITOR)) {
      throw Errors.forbidden();
    }
  },

  /** Auditor and Super Admin may read the audit trail for any visible costing; Costing User only sees costings they can already read (all of them, per DEC-018). */
  assertCanViewAudit(_user: SessionUser): void {
    // Read-only, same visibility as costings themselves — no additional restriction in Phase 1.
  },
};
