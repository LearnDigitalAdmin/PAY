// Minimal in-memory Firestore (just the surface the MyChama money-plane code uses) so the tests run with no
// emulator. Semantics that matter here: update() on a missing doc throws; set({merge:true}) merges; transactions
// buffer writes and apply them on commit (reads see pre-transaction state, like Firestore).
let auto = 0;
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

class Snap {
  constructor(db, path, data) { this.ref = new DocRef(db, path); this.id = this.ref.id; this._d = data; this.exists = data !== undefined; }
  data() { return this._d === undefined ? undefined : clone(this._d); }
}
class QSnap {
  constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; }
}
class DocRef {
  constructor(db, path) { this._db = db; this.path = path; this.id = path.split("/").pop(); }
  get parent() { return new CollRef(this._db, this.path.split("/").slice(0, -1).join("/")); }
  async get() { return new Snap(this._db, this.path, this._db.store.get(this.path)); }
  async set(data, opts) {
    const cur = this._db.store.get(this.path);
    this._db.store.set(this.path, opts && opts.merge && cur ? { ...cur, ...clone(data) } : clone(data));
  }
  async update(data) {
    const cur = this._db.store.get(this.path);
    if (cur === undefined) throw Object.assign(new Error(`NOT_FOUND: ${this.path}`), { code: 5 });
    this._db.store.set(this.path, { ...cur, ...clone(data) });
  }
  async delete() { this._db.store.delete(this.path); }
}
class CollRef {
  constructor(db, path, filters = [], lim = null) { this._db = db; this.path = path; this._f = filters; this._l = lim; }
  doc(id) { return new DocRef(this._db, `${this.path}/${id || "auto" + ++auto}`); }
  async add(data) { const r = this.doc(); await r.set(data); return r; }
  where(field, op, value) { return new CollRef(this._db, this.path, [...this._f, { field, op, value }], this._l); }
  limit(n) { return new CollRef(this._db, this.path, this._f, n); }
  _run() {
    const depth = this.path.split("/").length + 1;
    let docs = [];
    for (const [p, d] of this._db.store) {
      if (!p.startsWith(this.path + "/") || p.split("/").length !== depth) continue;
      const ok = this._f.every(({ field, op, value }) => {
        const x = d[field];
        if (op === "==") return x === value;
        if (op === ">=") return x >= value;
        throw new Error("fake: unsupported op " + op);
      });
      if (ok) docs.push(new Snap(this._db, p, d));
    }
    if (this._l !== null) docs = docs.slice(0, this._l);
    return new QSnap(docs);
  }
  async get() { return this._run(); }
}
export class FakeDb {
  constructor() { this.store = new Map(); }
  doc(path) { return new DocRef(this, path); }
  collection(path) { return new CollRef(this, path); }
  async runTransaction(fn) {
    const writes = [];
    const tx = {
      get: async (r) => r.get(),
      set: (ref, data, opts) => writes.push(() => ref.set(data, opts)),
      update: (ref, data) => writes.push(() => ref.update(data)),
      delete: (ref) => writes.push(() => ref.delete()),
    };
    const out = await fn(tx);
    for (const w of writes) await w();
    return out;
  }
  seed(path, data) { this.store.set(path, clone(data)); }
  read(path) { return clone(this.store.get(path)); }
  list(prefix) { return [...this.store.keys()].filter((p) => p.startsWith(prefix + "/")); }
}
