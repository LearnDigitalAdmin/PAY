// mychama1 Firestore paths (READ-mostly from PAY). Mirrors Chama repo
// functions/shared/firestore_paths.py. Do not invent new collections in mychama1.
export const chama = (c: string) => `chamas/${c}`;
export const members = (c: string) => `chamas/${c}/members`;
export const member = (c: string, m: string) => `chamas/${c}/members/${m}`;
export const contributions = (c: string) => `chamas/${c}/contributions`;
export const loans = (c: string) => `chamas/${c}/loans`;
export const mgrPots = (c: string) => `chamas/${c}/mgrPots`;
export const mgrPot = (c: string, p: string) => `chamas/${c}/mgrPots/${p}`;
export const mgrRecords = (c: string, p: string) => `chamas/${c}/mgrPots/${p}/records`;
export const mgrPayouts = (c: string, p: string) => `chamas/${c}/mgrPots/${p}/payouts`;
export const mgrArrears = (c: string, p: string) => `chamas/${c}/mgrPots/${p}/arrears`;
export const paymentIntents = (c: string) => `chamas/${c}/paymentIntents`;
export const paymentIntent = (c: string, ref: string) => `chamas/${c}/paymentIntents/${ref}`;
export const transactions = (c: string) => `chamas/${c}/transactions`;
