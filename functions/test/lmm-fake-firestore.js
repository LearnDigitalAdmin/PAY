/* In-memory Firestore for the Lipa Mos Mos flow test: transactions, FieldValue.increment / arrayUnion / delete, create(), and where() with
 * ==, >, <, in and array-contains. (The desk fake is == only.) */
const admin = require("firebase-admin");
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const kind = (v) => (v && typeof v === "object" ? v.constructor.name : "");
let auto = 0;
function applyUpdate(cur, data) {
  const next = { ...cur };
  for (const [k, v] of Object.entries(data)) {
    const t = kind(v);
    if (t === "DeleteTransform") delete next[k];
    else if (t === "NumericIncrementTransform") next[k] = (Number(next[k]) || 0) + v.operand;
    else if (t === "ArrayUnionTransform") { const a = Array.isArray(next[k]) ? [...next[k]] : []; for (const e of v.elements) if (!a.some((x) => JSON.stringify(x) === JSON.stringify(e))) a.push(clone(e)); next[k] = a; }
    else if (t === "ServerTimestampTransform") next[k] = Date.now();
    else next[k] = clone(v);
  }
  return next;
}
class Snap { constructor(db, path, data) { this.ref = new DocRef(db, path); this.id = this.ref.id; this._d = data; this.exists = data !== undefined; } data() { return this._d === undefined ? undefined : clone(this._d); } }
class QSnap { constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; } }
class DocRef {
  constructor(db, path) { this._db = db; this.path = path; this.id = path.split("/").pop(); }
  collection(n) { return new CollRef(this._db, `${this.path}/${n}`); }
  async get() { return new Snap(this._db, this.path, this._db.store.get(this.path)); }
  async set(d, o) { const cur = this._db.store.get(this.path); this._db.store.set(this.path, o && o.merge && cur ? applyUpdate(cur, d) : applyUpdate({}, d)); }
  async create(d) { if (this._db.store.has(this.path)) throw Object.assign(new Error("6 ALREADY_EXISTS " + this.path), { code: 6 }); this._db.store.set(this.path, applyUpdate({}, d)); }
  async update(d) { const cur = this._db.store.get(this.path); if (cur === undefined) throw Object.assign(new Error("NOT_FOUND " + this.path), { code: 5 }); this._db.store.set(this.path, applyUpdate(cur, d)); }
  async delete() { this._db.store.delete(this.path); }
}
const ops = { "==": (a, b) => a === b, ">": (a, b) => a > b, "<": (a, b) => a < b, in: (a, b) => b.includes(a), "array-contains": (a, b) => Array.isArray(a) && a.includes(b) };
class CollRef {
  constructor(db, path, f = [], lim = null) { this._db = db; this.path = path; this._f = f; this._l = lim; }
  doc(id) { return new DocRef(this._db, `${this.path}/${id || "auto" + ++auto}`); }
  where(field, op, value) { if (!ops[op]) throw new Error("fake: unsupported op " + op); return new CollRef(this._db, this.path, [...this._f, { field, op, value }], this._l); }
  orderBy() { return this; }
  limit(n) { return new CollRef(this._db, this.path, this._f, n); }
  async get() {
    const depth = this.path.split("/").length + 1; let docs = [];
    for (const [p, d] of this._db.store) { if (!p.startsWith(this.path + "/") || p.split("/").length !== depth) continue; if (this._f.every(({ field, op, value }) => ops[op](d[field], value))) docs.push(new Snap(this._db, p, d)); }
    if (this._l !== null) docs = docs.slice(0, this._l);
    return new QSnap(docs);
  }
}
class FakeDb {
  constructor() { this.store = new Map(); }
  doc(p) { return new DocRef(this, p); }
  collection(p) { return new CollRef(this, p); }
  async runTransaction(fn) {
    const writes = [];
    const tx = { get: async (r) => r.get(), set: (r, d, o) => writes.push(() => r.set(d, o)), create: (r, d) => writes.push(() => r.create(d)), update: (r, d) => writes.push(() => r.update(d)), delete: (r) => writes.push(() => r.delete()) };
    const out = await fn(tx); for (const w of writes) await w(); return out;
  }
  seed(p, d) { this.store.set(p, clone(d)); }
  read(p) { return clone(this.store.get(p)); }
  list(prefix) { return [...this.store.keys()].filter((p) => p.startsWith(prefix + "/")); }
}
/** Makes `admin.firestore()` return `db`, keeping `admin.firestore.FieldValue`. */
function install(db) {
  const real = admin.firestore; const fn = () => db; Object.assign(fn, real);
  Object.defineProperty(admin, "firestore", { value: fn, configurable: true, writable: true });
}
module.exports = { FakeDb, install };
