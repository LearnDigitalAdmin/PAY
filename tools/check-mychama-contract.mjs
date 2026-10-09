// Fails if the frontend copy of the MyChama contract drifted from the backend one.
import { readFileSync } from "node:fs";
const a = readFileSync("functions/src/mychama/contract.ts", "utf8");
const b = readFileSync("src/mychama/contract.ts", "utf8");
if (a !== b) {
  console.error("MyChama contract drift: functions/src/mychama/contract.ts !== src/mychama/contract.ts");
  console.error("Fix: cp functions/src/mychama/contract.ts src/mychama/contract.ts");
  process.exit(1);
}
console.log("MyChama contract: backend and frontend copies are identical.");
