// Desk module (W3-A). Pure exports only — nothing here is a deployable function. See notes for why the desk rent
// batch trigger is not part of this module.
export * from "./config";
export * from "./money";
export * from "./owner";
export * from "./split";
export * from "./events";
export * from "./sms";
export * from "./rent";
export * from "./hooks";
export type { DeskEventDoc, DeskCommission, DeskOwner } from "./types";
