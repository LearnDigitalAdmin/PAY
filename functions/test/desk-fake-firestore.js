/* In-memory Firestore for the desk checks (same approach as scripts/mychama/_fake-firestore.mjs, plus what the desk code
 * needs: create() with ALREADY_EXISTS, where(==).limit(), auto ids, and FieldValue.delete() inside update()). */
const admin = require("firebase-admin");
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const DEL = admin.firestore.FieldValue.delete();
const isDelete = (v) => v !== null && typeof v === "object" && typeof DEL.isEqual === "function" && DEL.isEqual(v);
let auto = 0;

function applyUpdate(cur, data) {
  const next = { ...cur };
  for (const [k, v] of Object.entries(data)) { if (isDelete(v)) delete next[k]; else next[k] = clone(v); }
  return next;
}

class Snap {
  constructor(db, path, data) { this.ref = new DocRef(db, path); this.id = this.ref.id; this._d = data; this.exists = data !== undefined; }
  data() { return this._d === undefined ? undefined : clone(this._d); }
}
class QSnap { constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; } }
class DocRef {
  constructor(db, path) { this._db = db; this.path = path; this.id = path.split("/").pop(); }
  collection(name) { return new CollRef(this._db, `${this.path}/${name}`); }
  async get() { return new Snap(this._db, this.path, this._db.store.get(this.path)); }
  async set(data, opts) {
    const cur = this._db.store.get(this.path);
    this._db.store.set(this.path, opts && opts.merge && cur ? applyUpdate(cur, data) : applyUpdate({}, data));
  }
  async create(data) {
    if (this._db.store.has(this.path)) throw Object.assign(new Error(`6 ALREADY_EXISTS: ${this.path}`), { code: 6 });
    this._db.store.set(this.path, applyUpdate({}, data));
  }
  async update(data) {
    const cur = this._db.store.get(this.path);
    if (cur === undefined) throw Object.assign(new Error(`NOT_FOUND: ${this.path}`), { code: 5 });
    this._db.store.set(this.path, applyUpdate(cur, data));
  }
  async delete() { this._db.store.delete(this.path); }
}
class CollRef {
  constructor(db, path, filters = [], lim = null) { this._db = db; this.path = path; this._f = filters; this._l = lim; }
  doc(id) { return new DocRef(this._db, `${this.path}/${id || "auto" + ++auto}`); }
  where(field, op, value) { if (op !== "==") throw new Error("fake: unsupported op " + op); return new CollRef(this._db, this.path, [...this._f, { field, value }], this._l); }
  limit(n) { return new CollRef(this._db, this.path, this._f, n); }
  async get() {
    const depth = this.path.split("/").length + 1;
    let docs = [];
    for (const [p, d] of this._db.store) {
      if (!p.startsWith(this.path + "/") || p.split("/").length !== depth) continue;
      if (this._f.every(({ field, value }) => d[field] === value)) docs.push(new Snap(this._db, p, d));
    }
    if (this._l !== null) docs = docs.slice(0, this._l);
    return new QSnap(docs);
  }
}
class FakeDb {
  constructor() { this.store = new Map(); }
  doc(path) { return new DocRef(this, path); }
  collection(path) { return new CollRef(this, path); }
  async runTransaction(fn) {
    const writes = [];
    const tx = {
      get: async (r) => r.get(),
      set: (r, d, o) => writes.push(() => r.set(d, o)),
      create: (r, d) => writes.push(() => r.create(d)),
      update: (r, d) => writes.push(() => r.update(d)),
      delete: (r) => writes.push(() => r.delete()),
    };
    const out = await fn(tx);
    for (const w of writes) await w();
    return out;
  }
  seed(path, data) { this.store.set(path, clone(data)); }
  read(path) { return clone(this.store.get(path)); }
  list(prefix) { return [...this.store.keys()].filter((p) => p.startsWith(prefix + "/")); }
  reset() { this.store.clear(); }
}
module.exports = { FakeDb };
