/* A small in-memory Firestore for the compliance report tests: subcollections, where (== in >= <=), orderBy, limit, startAfter,
 * transactions and FieldValue delete / serverTimestamp / increment. */
const admin = require("firebase-admin");
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const kind = (v) => {
  if (!v || typeof v !== "object" || !(v instanceof admin.firestore.FieldValue)) return null;
  if (v.isEqual(admin.firestore.FieldValue.delete())) return "delete";
  if (v.isEqual(admin.firestore.FieldValue.serverTimestamp())) return "ts";
  if (typeof v.operand === "number") return "inc";
  return null;
};
function setPath(obj, dotted, value) {
  const parts = dotted.split("."); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== "object" || o[parts[i]] === null) o[parts[i]] = {}; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = value;
}
function merge(cur, data, deep) {
  const out = clone(cur || {});
  for (const [k, v] of Object.entries(data)) {
    const kd = kind(v);
    const put = (val) => (k.includes(".") ? setPath(out, k, val) : (out[k] = val));
    if (kd === "delete") delete out[k];
    else if (kd === "ts") put(new Date().toISOString());
    else if (kd === "inc") put((Number(out[k]) || 0) + v.operand);
    else if (deep && v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) out[k] = merge(out[k], v, true);
    else put(clone(v));
  }
  return out;
}
class Snap { constructor(path, d, ref) { this.id = path.split("/").pop(); this.exists = d !== undefined; this._d = d; this.ref = ref; } data() { return this._d; } }
class Q { constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; } forEach(f) { this.docs.forEach(f); } }
class Doc {
  constructor(db, p) { this.db = db; this.path = p; this.id = p.split("/").pop(); }
  collection(n) { return new Coll(this.db, `${this.path}/${n}`); }
  async get() { return new Snap(this.path, this.db.store.get(this.path), this); }
  async set(d, o) { this.db.store.set(this.path, merge(o && o.merge ? this.db.store.get(this.path) : {}, d, !!(o && o.merge))); }
  async update(d) { if (!this.db.store.has(this.path)) throw new Error("NOT_FOUND " + this.path); this.db.store.set(this.path, merge(this.db.store.get(this.path), d, false)); }
}
class Coll {
  constructor(db, p, f = [], o = null, lim = 0, after = null) { this.db = db; this.path = p; this.f = f; this.o = o; this.lim = lim; this.after = after; }
  doc(id) { return new Doc(this.db, `${this.path}/${id}`); }
  where(field, op, value) { return new Coll(this.db, this.path, [...this.f, { field, op, value }], this.o, this.lim, this.after); }
  orderBy(field) { return new Coll(this.db, this.path, this.f, field, this.lim, this.after); }
  limit(n) { return new Coll(this.db, this.path, this.f, this.o, n, this.after); }
  startAfter(v) { return new Coll(this.db, this.path, this.f, this.o, this.lim, v); }
  async get() {
    let docs = [];
    for (const [p, d] of this.db.store) {
      if (!p.startsWith(this.path + "/") || p.slice(this.path.length + 1).includes("/")) continue;
      const ok = this.f.every(({ field, op, value }) => {
        const x = d[field];
        if (op === "==") return x === value; if (op === "in") return value.includes(x);
        if (op === ">=") return x !== undefined && x >= value; if (op === "<=") return x !== undefined && x <= value;
        throw new Error("op " + op);
      });
      if (ok) docs.push({ id: p.split("/").pop(), exists: true, data: () => d, ref: new Doc(this.db, p) });
    }
    if (this.o !== null) {
      const byId = typeof this.o !== "string";
      docs.sort((a, b) => { const x = byId ? a.id : a.data()[this.o], y = byId ? b.id : b.data()[this.o]; return x < y ? -1 : x > y ? 1 : 0; });
      if (this.after !== null) docs = docs.filter((d) => (byId ? d.id : d.data()[this.o]) > this.after);
      if (!byId) docs = docs.filter((d) => d.data()[this.o] !== undefined);
    }
    if (this.lim) docs = docs.slice(0, this.lim);
    return new Q(docs);
  }
}
class Batch { constructor() { this.w = []; } set(r, d, o) { this.w.push(() => r.set(d, o)); } update(r, d) { this.w.push(() => r.update(d)); } async commit() { for (const w of this.w) await w(); } }
class FakeDb {
  constructor() { this.store = new Map(); }
  collection(p) { return new Coll(this, p); }
  batch() { return new Batch(); }
  async runTransaction(fn) {
    const writes = [];
    const tx = { get: (r) => r.get(), set: (r, d, o) => writes.push(() => r.set(d, o)), update: (r, d) => writes.push(() => r.update(d)) };
    const out = await fn(tx);
    for (const w of writes) await w();
    return out;
  }
}
module.exports = { FakeDb, Doc };
