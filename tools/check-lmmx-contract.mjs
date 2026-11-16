// Fails if the frontend copy of the Lipa Mdogo Mdogo (LMMX) contract drifted from the backend one.
// Backend copy: functions/src/lmmx/contract.ts (added by CORE). Frontend copy: src/lmmx/contract.ts (this patch).
import { existsSync, readFileSync } from "node:fs";
const backend = "functions/src/lmmx/contract.ts";
const frontend = "src/lmmx/contract.ts";
if (!existsSync(backend)) {
  console.error(`LMMX contract check: ${backend} does not exist yet.`);
  console.error("It is added by the CORE patch (PAY backend). Apply that patch, then run this check again.");
  process.exit(1);
}
if (readFileSync(backend, "utf8") !== readFileSync(frontend, "utf8")) {
  console.error(`LMMX contract drift: ${backend} !== ${frontend}`);
  console.error(`Fix: cp ${backend} ${frontend}  (or the other way round, whichever is the current Appendix A)`);
  process.exit(1);
}
console.log("LMMX contract: backend and frontend copies are identical.");
