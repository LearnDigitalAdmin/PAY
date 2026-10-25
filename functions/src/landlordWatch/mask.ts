// Server-side masking (contract section 6). Clients never receive more than their level allows.
import { createHash } from "crypto";
import { maskN, maskName, maskPhone } from "./format";
import type { MaskLevel, N, Snapshot, TenantRow } from "./types";

const isN = (x: unknown): x is N =>
  !!x && typeof x === "object" && "d" in (x as object) && "v" in (x as object) && Object.keys(x as object).length === 2;

/** Mask every N inside a value (objects and arrays), leaving everything else as it is. */
function maskAllN<T>(value: T): T {
  if (isN(value)) return maskN(value) as unknown as T;
  if (Array.isArray(value)) return value.map(maskAllN) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskAllN(v);
    return out as T;
  }
  return value;
}

const maskedRow = (r: TenantRow, i: number): TenantRow => ({
  ref: `t_masked${i + 1}`, name: maskName(r.name), phone: maskPhone(r.phone), unit: "••", status: "masked",
  rent: maskN(r.rent), billed: maskN(r.billed), paid: maskN(r.paid), balance: maskN(r.balance),
  dueDate: null, paidOn: null, paidOnTime: null,
});

export function maskSnapshot(open: Snapshot, level: MaskLevel): Snapshot {
  if (level === "open") return open;

  if (level === "tenant") {
    return { ...open, tenants: open.tenants.map((t) => ({ ...t, name: maskName(t.name), phone: maskPhone(t.phone) })) };
  }

  // full: everything masked. At most 5 placeholder rows, never the real list.
  const masked = maskAllN({ ...open, tenants: [] as TenantRow[] });
  return {
    ...masked,
    property: { ...masked.property, name: maskName(open.property.name), address: open.property.address ? "••••••••" : null },
    tenants: open.tenants.slice(0, 5).map(maskedRow),
    summary: {
      ...masked.summary,
      statement: {
        ...masked.summary.statement,
        notes: null,
        items: open.summary.statement.items.map((it) => ({ label: "••••••", kind: it.kind, amount: maskN(it.amount) })),
      },
    },
  };
}

/** Content hash that changes whenever the visible content, mask level or language changes. */
export function etagOf(snapshot: Snapshot, lang: string): string {
  const { generatedAt: _generatedAt, ...stable } = snapshot;
  void _generatedAt;
  return createHash("sha256").update(JSON.stringify(stable)).update(lang).digest("hex").slice(0, 16);
}
