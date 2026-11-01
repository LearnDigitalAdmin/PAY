// One greeting for every SMS: "Dear John" from "John Doe" (cut at the first space). Shared so no template builds its own.
export function firstName(full: unknown): string {
  const s = typeof full === "string" ? full.trim() : "";
  const first = s.split(/\s+/)[0] ?? "";
  // keep letters (any script), apostrophes and hyphens; drop anything that could break an SMS
  const clean = first.replace(/[^\p{L}'’-]/gu, "");
  return clean.length > 0 ? clean.charAt(0).toUpperCase() + clean.slice(1) : "";
}
/** "Dear John," or "Dear Tenant," when there is no usable name. */
export const dearLine = (full: unknown): string => `Dear ${firstName(full) || "Tenant"},`;
