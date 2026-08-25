import { ulid } from "ulid";

/** Server-generated sortable identifier, prefixed by entity kind for readability in logs/audit. */
export function generateId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
