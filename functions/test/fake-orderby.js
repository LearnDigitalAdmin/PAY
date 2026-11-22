/* Adds orderBy(field, dir).limit(n) support to the shared FakeDb collection queries (it only has where(==) and limit). */
const { FakeDb } = require("./desk-fake-firestore");
const C = Object.getPrototypeOf(new FakeDb().collection("x"));
if (!C.__orderByPatched) {
  const get0 = C.get, lim0 = C.limit, where0 = C.where;
  C.where = function (f, op, v) {
    if (op === "==") { const c = where0.call(this, f, op, v); c._o = this._o; c._r = this._r; return c; }
    if (op !== ">=" && op !== "<") throw new Error("fake: unsupported op " + op);
    const c = new this.constructor(this._db, this.path, this._f, this._l); c._o = this._o; c._r = [...(this._r || []), { f, op, v }]; return c;
  };
  C.orderBy = function (f, d = "asc") { const n = Object.create(this); n._o = [f, d]; return n; };
  C.limit = function (n) { const c = lim0.call(this, n); c._o = this._o; c._r = this._r; c._lim = n; c._l = null; return c; };
  C.get = async function () {
    const q = await get0.call(this); let docs = q.docs;
    for (const r of this._r || []) docs = docs.filter((d) => (r.op === ">=" ? d.data()[r.f] >= r.v : d.data()[r.f] < r.v));
    if (this._o) { const [f, d] = this._o; docs = [...docs].sort((a, b) => (a.data()[f] < b.data()[f] ? -1 : a.data()[f] > b.data()[f] ? 1 : 0) * (d === "desc" ? -1 : 1)); }
    if (this._lim) docs = docs.slice(0, this._lim);
    return { docs, size: docs.length, empty: !docs.length };
  };
  C.__orderByPatched = true;
}
module.exports = { FakeDb };
