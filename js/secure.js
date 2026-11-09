/* ============================================================
   الحماية: تشفير وتوقيع رسائل الغرفة (WebCrypto)
   - كل جهاز له مفتاحين ثابتين: ECDH (للتشفير) و ECDSA (للتوقيع)
   - بين أي جهازين نشتق مفتاح AES-GCM مشترك من ECDH
   - صاحب الغرفة يوقّع كل حالة يرسلها، واللاعبين يثبّتون مفتاحه أول مرة
   - حالة الغرفة مشفرة بمفتاح الغرفة، وكل لاعب يستلم مفتاح الغرفة ودوره السري مشفر له لحاله
   ============================================================ */
const KEYS_LS = "bara_keys";
const ECDH_ALG = { name: "ECDH", namedCurve: "P-256" };
const DSA_ALG = { name: "ECDSA", namedCurve: "P-256" };
const enc = new TextEncoder(), dec = new TextDecoder();

function b64(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
// المفتاح العام لـ P-256 بصيغة raw = 65 بايت = 88 حرف base64
function validPub(s) { return typeof s === "string" && s.length === 88 && /^[A-Za-z0-9+/]+=*$/.test(s); }
function validBox(b) { return b && typeof b === "object" && typeof b.i === "string" && b.i.length === 16 && typeof b.c === "string" && b.c.length < 300000; }
function cachePut(map, key, value, max = 256) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}
// رقم عشوائي آمن (للكود والمفاتيح)
function secureInt(n) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }

const Sec = {
  supported: !!(window.crypto && crypto.subtle && window.isSecureContext !== false),
  keys: null, pubEcdh: "", pubDsa: "",
  pairs: new Map(), verifiers: new Map(), groups: new Map(),
  initPromise: null,

  init() {
    if (!this.initPromise) this.initPromise = this._init().catch(e => { this.initPromise = null; throw e; });
    return this.initPromise;
  },
  async _init() {
    if (!this.supported) throw new Error("crypto not supported");
    let saved = null;
    try { saved = JSON.parse(LS.get(KEYS_LS)); } catch {}
    let ecdh = null, dsa = null;
    if (saved && saved.v === 1) {
      try {
        ecdh = { privateKey: await crypto.subtle.importKey("jwk", saved.ecdh, ECDH_ALG, true, ["deriveKey"]),
                 publicKey: await crypto.subtle.importKey("jwk", saved.ecdhPub, ECDH_ALG, true, []) };
        dsa = { privateKey: await crypto.subtle.importKey("jwk", saved.dsa, DSA_ALG, true, ["sign"]),
                publicKey: await crypto.subtle.importKey("jwk", saved.dsaPub, DSA_ALG, true, ["verify"]) };
      } catch { ecdh = dsa = null; }
    }
    if (!ecdh) {
      ecdh = await crypto.subtle.generateKey(ECDH_ALG, true, ["deriveKey"]);
      dsa = await crypto.subtle.generateKey(DSA_ALG, true, ["sign", "verify"]);
      const jwk = k => crypto.subtle.exportKey("jwk", k);
      LS.set(KEYS_LS, JSON.stringify({ v: 1, ecdh: await jwk(ecdh.privateKey), ecdhPub: await jwk(ecdh.publicKey), dsa: await jwk(dsa.privateKey), dsaPub: await jwk(dsa.publicKey) }));
    }
    this.keys = { ecdh, dsa };
    this.pubEcdh = b64(await crypto.subtle.exportKey("raw", ecdh.publicKey));
    this.pubDsa = b64(await crypto.subtle.exportKey("raw", dsa.publicKey));
  },

  // مفتاح مشترك بيني وبين جهاز ثاني
  async pairKey(theirPub) {
    if (!validPub(theirPub)) throw new Error("bad key");
    if (this.pairs.has(theirPub)) return this.pairs.get(theirPub);
    const p = (async () => {
      const pub = await crypto.subtle.importKey("raw", unb64(theirPub), ECDH_ALG, false, []);
      return crypto.subtle.deriveKey({ name: "ECDH", public: pub }, this.keys.ecdh.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    })();
    cachePut(this.pairs, theirPub, p, 256);
    return p.catch(error => {
      if (this.pairs.get(theirPub) === p) this.pairs.delete(theirPub);
      throw error;
    });
  },

  async seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
    return { i: b64(iv), c: b64(ct) };
  },
  async open(key, box) {
    if (!validBox(box)) throw new Error("bad box");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.i) }, key, unb64(box.c));
    return JSON.parse(dec.decode(pt));
  },

  async sign(str) {
    return b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.dsa.privateKey, enc.encode(str)));
  },
  async verify(pub, str, sig) {
    if (!validPub(pub) || typeof sig !== "string" || sig.length > 200) return false;
    let k = this.verifiers.get(pub);
    if (!k) {
      k = crypto.subtle.importKey("raw", unb64(pub), DSA_ALG, false, ["verify"]);
      cachePut(this.verifiers, pub, k, 256);
      k.catch(() => { if (this.verifiers.get(pub) === k) this.verifiers.delete(pub); });
    }
    try { return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await k, unb64(sig), enc.encode(str)); }
    catch { return false; }
  },

  // مفتاح الغرفة: يتغير لما أحد ينطرد أو يطلع
  newGroupRaw() { return b64(crypto.getRandomValues(new Uint8Array(32))); },
  async groupKey(raw) {
    if (typeof raw !== "string" || raw.length !== 44) throw new Error("bad group key");
    if (!this.groups.has(raw)) {
      const keyPromise = crypto.subtle.importKey("raw", unb64(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
      cachePut(this.groups, raw, keyPromise, 64);
      keyPromise.catch(() => { if (this.groups.get(raw) === keyPromise) this.groups.delete(raw); });
    }
    return this.groups.get(raw);
  }
};
