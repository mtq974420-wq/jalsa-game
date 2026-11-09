/* ============================================================
   اللعب أونلاين (غرف عبر Supabase Realtime)
   صاحب الغرفة (الهوست) يحتفظ بحالة اللعبة ويرسلها للكل،
   وباقي اللاعبين يرسلون حركاتهم (دخول، تصويت، تخمين، دردشة) للهوست.
   ============================================================ */

// مفتاح publishable مصمم يكون ظاهر في كود المتصفح
const SB_URL = "https://hhstlsdnqvuhxzmtmdtm.supabase.co";
const SB_KEY = "sb_publishable_rPw-G-hp6wDLkGI-6oXB_w__M1Rfahw";

const PID_KEY = "bara_pid";
const NAME_KEY = "bara_name";
const LOOK_KEY = "bara_look";
function myLook() { const l = LS.get(LOOK_KEY); return decodeLook(l) ? l : ""; }
const HOST_PREFIX = "bara_host_";
const MAX_PLAYERS = 12;
// رقم نسخة الغرفة: لو صاحب الغرفة واللاعب عندهم نسخ مختلفة من اللعبة نطلب منهم تحديث الصفحة
const ROOM_VERSION = 16;
const CODE_LEN = 6;

const myId = LS.get(PID_KEY) || (() => {
  const id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
  LS.set(PID_KEY, id);
  return id;
})();

const On = {
  sb: null, ch: null, code: null, isHost: false,
  room: null, online: new Set(),
  wasIn: false, joinTimer: null, lastJoinSent: 0, stateRetryTimer: null, stateRetryCount: 0,
  lastSig: null, lastPhase: null, lastQ: null,
  hostPk: null, myRole: null, myVote: null, envSeq: 0, sawRoom: false, locked: false, fp: "", fpFor: "",
  hq: Promise.resolve(), cq: Promise.resolve(), rate: new Map(), lastChat: new Map(), sendC: 0, sending: false, dirty: false,
  chatOpen: false, chatSeenT: null,
  ui: {}
};
function freshUi() { return { shown: false, peek: false, resultShown: 0, suspenseFor: 0, finishShown: 0, timeUpFor: null }; }
On.ui = freshUi();

async function sendRealtimeBroadcast(channel, event, payload) {
  if (!channel) throw new Error(`Realtime channel missing for ${event}`);
  const status = await channel.send({ type: "broadcast", event, payload });
  if (status !== "ok") throw new Error(`Realtime ${event} broadcast failed: ${String(status)}`);
  return status;
}

function myName() { return cleanText(LS.get(NAME_KEY), 20); }
function shareLink(code) {
  const k = On.isHost && Sec.pubDsa ? "#k=" + encodeURIComponent(Sec.pubDsa) : "";
  return location.origin + location.pathname + "?room=" + code + k;
}
const SS = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  del(k) { try { sessionStorage.removeItem(k); } catch {} }
};
const ACTIVE_ROOM_KEY = "jalsah_active_room";
function setActiveRoom(game, code) {
  if (!/^\d{6}$/.test(String(code || ""))) return;
  SS.set(ACTIVE_ROOM_KEY, JSON.stringify({ game, code: String(code), updated: Date.now() }));
}
function getActiveRoom() {
  try {
    const saved = JSON.parse(SS.get(ACTIVE_ROOM_KEY) || "null");
    if (!saved || !["bara", "atarsh"].includes(saved.game) || !/^\d{6}$/.test(saved.code) ||
        !Number.isFinite(saved.updated) || Date.now() - saved.updated > 24 * 60 * 60 * 1000) return null;
    return saved;
  } catch { return null; }
}
function clearActiveRoom(game = null) {
  const saved = getActiveRoom();
  if (!game || !saved || saved.game === game) SS.del(ACTIVE_ROOM_KEY);
}
function nextActionCounter(scope, current = 0) {
  const key = `jalsah_counter_${scope}_${myId}`;
  const stored = Number(LS.get(key)) || 0;
  const next = Math.max(Date.now(), stored + 1, Number(current) + 1);
  LS.set(key, String(next));
  return next;
}
function pinKey(code) { return "bara_pin_" + code; }
function pkOf(id) {
  const r = On.room;
  const p = r && r.players.concat(r.waiting).find(x => x.id === id);
  return p && validPub(p.pk) ? p.pk : null;
}
// بصمة الغرفة: 4 إيموجي من مفتاح توقيع صاحب الغرفة. لو نفسها عند الكل، ما أحد ينتحل صاحب الغرفة
const FP_EMOJI = ["🍕","🐪","⚽","🚀","🌵","🎸","🦁","🍉","🎈","🐢","🌙","🔥","🍩","🦊","🎯","🐳","🌈","🍔","🦄","⭐","🍋","🐙","🎲","🌻",
  "🍿","🦉","🚗","🍎","🐝","🎁","🌊","🍪","🦒","⛄","🎻","🍇","🐧","🚲","🌴","🍓","🦋","🎮","🍦","🐬","⚡","🌍","🍄","🦜",
  "🎺","🍒","🐘","🛸","🌸","🍫","🦀","🎨","🍍","🐼","🚁","🌋","🍭","🦈","🎳","🥥"];
async function fingerprint(pub) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64(pub)));
  return [0, 1, 2, 3].map(i => FP_EMOJI[h[i] % 64]).join(" ");
}
async function setFingerprint(pub) {
  if (!validPub(pub) || On.fpFor === pub) return;
  const channel = On.ch, code = On.code;
  On.fpFor = pub;
  try {
    const value = await fingerprint(pub);
    if (On.ch !== channel || On.code !== code || On.fpFor !== pub) return;
    On.fp = value;
    renderOnline();
  } catch (e) { console.warn("fingerprint", e); }
}
function cryptoError() {
  renderError("متصفحك ما يدعم التشفير المطلوب للعب أونلاين 😕", "حدّث المتصفح، أو افتح اللعبة من الرابط اللي يبدأ بـ https.");
}
function codeTiles(code) { return `<div class="room-code">${[...code].map((d, i) => `<span style="--i:${i}">${esc(d)}</span>`).join("")}</div>`; }

/* ---------- الشاشة الرئيسية: اختيار اللعبة ---------- */
function renderHome() {
  clearActiveRoom();
  if (typeof leaveChannel !== "undefined") leaveChannel();
  if (typeof leaveAtChannel !== "undefined") leaveAtChannel();
  Music.setMood("calm");
  history.replaceState(null, "", location.pathname);
  setFloaters(["🕵️", "🥁", "🎺", "🤫", "🎵", "❓", "🎲"]);
  paint("picker", `
    <div class="hero">
      <div class="logo-badge" style="background: linear-gradient(145deg, var(--violet), var(--pink))">
        <span class="logo-emoji">🎉</span>
      </div>
      <h1 class="logo">جلسة</h1>
      <p class="tagline">اختار لعبة وابدأ السهرة 🎲</p>
    </div>
    <div class="game-picker-cards">
      <div class="game-card">
        <div class="game-card-icon">🕵️</div>
        <div class="game-card-title">مين برا السالفة؟</div>
        <p class="game-card-tagline">لعبة الشك والضحك</p>
        <button class="big" id="pickGame1Btn" data-quiet="1">العب الآن ➜</button>
      </div>
      <div class="game-card">
        <div class="game-card-icon">🥁</div>
        <div class="game-card-title">مين الأطرش بالزفة؟</div>
        <p class="game-card-tagline">لعبة الأسئلة المزدوجة</p>
        <button class="big" id="pickGame2Btn" data-quiet="1" style="background: linear-gradient(135deg, var(--gold), var(--orange))">العب الآن ➜</button>
      </div>
    </div>
  `);
  document.getElementById("pickGame1Btn").onclick = () => { SFX.select(); renderGame1Home(); };
  document.getElementById("pickGame2Btn").onclick = () => { SFX.select(); renderGame2Home(); };
}

/* ---------- لعبة مين برا السالفة؟ ---------- */
function renderGame1Home() {
  clearActiveRoom();
  leaveChannel();
  if (typeof leaveAtChannel !== "undefined") leaveAtChannel();
  Music.setMood("calm");
  history.replaceState(null, "", location.pathname);
  setFloaters(HOME_FLOATERS);
  paint("home", `
    <div class="hero">
      <div class="logo-badge"><span class="logo-emoji">🕵️</span></div>
      <h1 class="logo">مين برا<br><span>السالفة؟</span></h1>
      <p class="tagline">لعبة الشك والضحك مع الشباب 🤫</p>
    </div>
    <div class="card">
      <div class="card-title">👤 اسمك</div>
      <input id="homeName" placeholder="اكتب اسمك" maxlength="20" autocomplete="off" value="${esc(myName())}">
    </div>
    <div class="card">
      <div class="card-title">🌐 العب أونلاين</div>
      <button class="big" id="createBtn" data-quiet="1" style="margin-top:0">سوّي غرفة جديدة ➕</button>
      <div class="divider">أو ادخل غرفة بالكود</div>
      <div class="row">
        <input id="codeInput" class="code-input" placeholder="000000" maxlength="6" inputmode="numeric" autocomplete="off">
        <button id="joinBtn" data-quiet="1">ادخل</button>
      </div>
    </div>
    <button class="big ghost" id="localBtn">📱 العب على جوال واحد</button>
    <button class="big ghost" id="pickerBtn">الرئيسية 🏠</button>
    <details class="card how" style="margin-top:14px">
      <summary>📖 طريقة اللعب</summary>
      <ol>
        <li>كل اللاعبين يعرفون السالفة إلا واحد: "برا السالفة".</li>
        <li>تسألون بعض أسئلة عن السالفة بدون ما تفضحونها.</li>
        <li>تصوّتون مين تتوقعون إنه برا السالفة.</li>
        <li>وبرا السالفة يحاول يخمّن السالفة بالنهاية.</li>
      </ol>
    </details>
    ${TMDB_NOTE}`);
  const nameEl = document.getElementById("homeName");
  const codeEl = document.getElementById("codeInput");
  const needName = () => {
    const n = cleanText(nameEl.value, 20);
    if (!n) { shakeEl(nameEl); SFX.wrong(); nameEl.focus(); toast("اكتب اسمك أول ✍️"); return null; }
    LS.set(NAME_KEY, n);
    return n;
  };
  document.getElementById("createBtn").onclick = () => { if (needName()) { SFX.start(); createRoom(); } };
  const join = () => {
    const code = codeEl.value.replace(/\D/g, "");
    if (code.length !== CODE_LEN) { shakeEl(codeEl); SFX.wrong(); return; }
    if (needName()) { SFX.select(); joinRoom(code); }
  };
  document.getElementById("joinBtn").onclick = join;
  codeEl.oninput = () => { codeEl.value = codeEl.value.replace(/\D/g, "").slice(0, CODE_LEN); };
  codeEl.onkeydown = e => { if (e.key === "Enter") join(); };
  document.getElementById("localBtn").onclick = renderSetup;
  document.getElementById("pickerBtn").onclick = renderHome;
}

// شاشة إدخال الاسم لما يفتح أحد رابط غرفة لأول مرة
function renderNameForRoom(code) {
  setFloaters(HOME_FLOATERS);
  paint("name-" + code, `
    <div class="hero">
      <div class="logo-badge"><span class="logo-emoji">🕵️</span></div>
      <h1 class="logo">مين برا<br><span>السالفة؟</span></h1>
    </div>
    <div class="card center">
      <div class="muted">عزموك على الغرفة 🎉</div>
      ${codeTiles(code)}
    </div>
    <div class="card">
      <div class="card-title">👤 اسمك</div>
      <input id="roomName" placeholder="اكتب اسمك" maxlength="20" autocomplete="off">
    </div>
    <button class="big" id="goBtn" data-quiet="1">ادخل الغرفة 🚪</button>
    <button class="big ghost" id="backBtn">الرئيسية 🏠</button>`);
  const el = document.getElementById("roomName");
  const go = () => {
    const n = cleanText(el.value, 20);
    if (!n) { shakeEl(el); SFX.wrong(); return; }
    LS.set(NAME_KEY, n); SFX.select(); joinRoom(code);
  };
  document.getElementById("goBtn").onclick = go;
  el.onkeydown = e => { if (e.key === "Enter") go(); };
  document.getElementById("backBtn").onclick = renderHome;
  el.focus();
}

/* ---------- الاتصال ---------- */
async function createRoom() {
  try { await Sec.init(); } catch { cryptoError(); return; }
  const code = String(100000 + secureInt(900000));
  On.isHost = true;
  On.room = {
    v: ROOM_VERSION, code, hostId: myId, phase: "lobby", categories: loadCats(),
    players: [{ id: myId, name: myName(), score: 0, look: myLook(), pk: Sec.pubEcdh }],
    waiting: [], round: null, chat: [], seq: 1, locked: false, outsiderHistory: [],
    gk: Sec.newGroupRaw(), ctr: {}          // gk و ctr خاصة بصاحب الغرفة وما تنرسل
  };
  sysChat(`${myName()} سوّى الغرفة 🎉`);
  saveHost();
  connect(code);
}

async function joinRoom(code) {
  try { await Sec.init(); } catch { cryptoError(); return; }
  let saved = null;
  try { saved = JSON.parse(LS.get(HOST_PREFIX + code)); } catch {}
  if (saved && saved.hostId === myId) {
    saved.categories = validCats(saved.categories);   // غرف محفوظة من نسخة قديمة
    saved.v = ROOM_VERSION;
    if (typeof saved.gk !== "string" || saved.gk.length !== 44) saved.gk = Sec.newGroupRaw();
    if (!saved.ctr || typeof saved.ctr !== "object") saved.ctr = {};
    if (!Array.isArray(saved.outsiderHistory)) saved.outsiderHistory = [];
    const me = saved.players.concat(saved.waiting || []).find(x => x.id === myId);
    if (me) me.pk = Sec.pubEcdh;
    On.isHost = true; On.room = saved;
  }
  else { On.isHost = false; On.room = null; }
  connect(code);
}

function connect(code) {
  leaveChannel();
  if (!window.supabase) { renderError("ما قدرنا نحمّل مكتبة الاتصال. تأكد من الإنترنت وجرب مرة ثانية."); return; }
  On.sb = On.sb || window.supabase.createClient(SB_URL, SB_KEY);
  On.code = code;
  setActiveRoom("bara", code);
  On.wasIn = false; On.lastSig = null; On.lastPhase = null; On.lastJoinSent = 0; On.joinEncrypted = false;
  clearTimeout(On.stateRetryTimer); On.stateRetryTimer = null; On.stateRetryCount = 0;
  On.hq = Promise.resolve(); On.cq = Promise.resolve(); On.rate.clear(); On.lastChat.clear();
  On.online = new Set(); On.sending = false; On.dirty = false;
  On.hostPk = null; On.myRole = null; On.myVote = null; On.envSeq = 0; On.sawRoom = false; On.locked = false; On.fp = ""; On.fpFor = "";
  if (On.isHost) setFingerprint(Sec.pubDsa);
  On.ui = freshUi();
  history.replaceState(null, "", "?room=" + code);

  const ch = On.sb.channel("bara:" + code, { config: { broadcast: { self: false, ack: true }, presence: { key: myId } } });
  On.ch = ch;
  ch.on("broadcast", { event: "state" }, ({ payload }) => {
    if (ch !== On.ch || On.isHost) return;
    On.cq = On.cq.then(() => ch === On.ch ? receiveEnvelope(payload, ch) : undefined).catch(e => console.warn("state", e));
  });
  ch.on("broadcast", { event: "action" }, ({ payload }) => {
    if (ch !== On.ch || !On.isHost) return;
    On.hq = On.hq.then(() => ch === On.ch ? hostReceive(payload, ch) : undefined).catch(e => console.warn("action", e));
  });
  ch.on("broadcast", { event: "rtc" }, ({ payload }) => { if (ch === On.ch) Voice.onSignal(payload); });
  ch.on("broadcast", { event: "closed" }, async ({ payload }) => {
    if (ch !== On.ch || On.isHost || !payload || typeof payload.s !== "string") return;
    const pin = SS.get(pinKey(code));
    let msg = null; try { msg = JSON.parse(payload.s); } catch { return; }
    if (!pin || !msg || msg.code !== code || !(await Sec.verify(pin, payload.s, payload.sig)) || ch !== On.ch) return;   // لازم يكون من صاحب الغرفة والقناة الحالية
    leaveChannel(); renderError("صاحب الغرفة قفل الغرفة 🚪");
  });
  ch.on("presence", { event: "sync" }, () => {
    if (ch !== On.ch) return;
    On.online = new Set(Object.keys(ch.presenceState()));
    Voice.onPresence(ch.presenceState());
    if (On.isHost) commit(); else renderOnline();
  });
  ch.subscribe(async status => {
    if (ch !== On.ch) return;
    Voice.onChannelStatus(ch, status);
    if (status === "SUBSCRIBED") {
      await Voice._track();
      if (ch !== On.ch) return;
      if (On.isHost) commit(); else sendJoin();
    }
  });

  if (On.isHost) renderOnline();
  else {
    paint("connecting", `
      <div class="card status-big" style="margin-top:60px">
        <div class="big-emoji spin">🌀</div>
        <div class="title">جاري الدخول للغرفة</div>
        ${codeTiles(code)}
      </div>
      <button class="big ghost" id="cancelBtn">إلغاء</button>`);
    document.getElementById("cancelBtn").onclick = renderHome;
    // نعيد طلب الدخول كل ثانيتين لين يقبلنا صاحب الغرفة
    clearInterval(On.joinRetry);
    On.joinRetry = setInterval(() => {
      if (ch !== On.ch || On.room) { clearInterval(On.joinRetry); return; }
      if (!On.locked) sendJoin();
    }, 2000);
    On.joinTimer = setTimeout(() => {
      if (On.room || ch !== On.ch) return;
      leaveChannel();
      if (On.sawRoom && On.locked) renderError("الغرفة مقفلة 🔒", "صاحب الغرفة قفل الغرفة، ما يقدر يدخلها أحد جديد.");
      else if (On.sawRoom) renderError("صاحب الغرفة ما قبل دخولك 😕", "تأكد إن الغرفة مو مليانة، وجرب مرة ثانية.");
      else renderError(`ما لقينا الغرفة ${esc(code)} 😕`, "تأكد من الكود، أو إن صاحب الغرفة فاتح اللعبة.");
    }, 30000);
  }
}

function leaveChannel() {
  if (On.ch && On.sb) {
    try { Promise.resolve(On.sb.removeChannel(On.ch)).catch(e => console.warn("remove channel", e)); }
    catch (e) { console.warn("remove channel", e); }
  }
  On.ch = null;
  Voice.resetRoom();
  clearTimeout(On.stateRetryTimer); On.stateRetryTimer = null; On.stateRetryCount = 0;
  clearTimeout(On.joinTimer);
  clearInterval(On.joinRetry);
  removeChat();
  On.chatSeenT = null;
}

function renderError(msg, sub = "") {
  clearActiveRoom("bara");
  history.replaceState(null, "", location.pathname);
  paint("error-" + Math.random(), `
    <div class="card status-big" style="margin-top:60px">
      <div class="big-emoji wiggle">🙈</div>
      <div class="title">${msg}</div>
      ${sub ? `<p class="hint">${esc(sub)}</p>` : ""}
    </div>
    <button class="big" id="homeBtn">الرئيسية 🏠</button>`);
  SFX.wrong();
  document.getElementById("homeBtn").onclick = renderHome;
}

function sendAction(a) {
  if (On.isHost) { hostHandle({ ...a, from: myId }); return Promise.resolve(); }
  if (!On.ch) return Promise.resolve();
  if (a.type === "hello") {
    return sendRealtimeBroadcast(On.ch, "action", { type: "hello", from: myId })
      .catch(e => { console.warn("hello", e); return false; });
  }
  if (!On.hostPk) return Promise.resolve();
  // عدّاد يزيد دايماً: يمنع إعادة إرسال رسالة قديمة
  On.sendC = nextActionCounter("bara", On.sendC);
  const body = { ...a, c: On.sendC };
  const ch = On.ch;
  return Sec.pairKey(On.hostPk).then(k => Sec.seal(k, body)).then(box => {
    if (ch === On.ch) return sendRealtimeBroadcast(ch, "action", { from: myId, box });
  }).catch(e => { console.warn("send", e); });
}
async function sendJoin() {
  const ch = On.ch;
  if (!ch) return false;
  const now = Date.now();
  if (now - On.lastJoinSent < 1200) return false;
  On.lastJoinSent = now;

  On.joinEncrypted = !!On.hostPk;
  try {
    if (!On.hostPk) {
      await sendAction({ type: "hello" });
      return true;
    }
    On.sendC = nextActionCounter("bara", On.sendC);
    const body = { type: "join", name: myName(), look: myLook(), c: On.sendC };
    const key = await Sec.pairKey(On.hostPk);
    const box = await Sec.seal(key, body);
    if (ch !== On.ch) return false;
    await sendRealtimeBroadcast(ch, "action", { from: myId, pk: Sec.pubEcdh, box });
    return true;
  } catch (e) {
    console.warn("join", e);
    return false;
  }
}


document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && On.ch && !On.isHost) sendAction({ type: "hello" });
});

/* ---------- جهة اللاعب: استقبال الحالة ---------- */
function versionError() {
  leaveChannel();
  renderError("نسخة اللعبة عندك تختلف عن نسخة صاحب الغرفة 🔄", "خلّ الكل يسوي تحديث للصفحة (Ctrl + Shift + R أو اسحب الصفحة لتحت في الجوال) وادخلوا مرة ثانية.");
}

async function receiveEnvelope(payload, sourceChannel = On.ch) {
  const channel = sourceChannel;
  const roomCode = On.code;
  if (!channel || channel !== On.ch || !payload || typeof payload.s !== "string" || payload.s.length > 500000 || typeof payload.sig !== "string") return;
  let env; try { env = JSON.parse(payload.s); } catch { return; }
  if (!env || typeof env !== "object" || env.code !== roomCode) return;
  if (env.v !== ROOM_VERSION) { if (channel === On.ch) versionError(); return; }
  if (!validPub(env.hpk) || !validPub(env.hek) || typeof env.hostId !== "string" || !env.hostId.length || env.hostId.length > 64 || !Number.isSafeInteger(env.seq) || env.seq < 0) return;
  if (!Number.isSafeInteger(env.ts)) return;

  const age = Date.now() - env.ts;
  if (age > 60000 || age < -10000) {
    console.warn("[Online] Rejecting envelope: invalid timestamp", age);
    return;
  }

  const pin = SS.get(pinKey(roomCode));
  if (pin && pin !== env.hpk) return;
  if (!(await Sec.verify(env.hpk, payload.s, payload.sig))) return;
  if (channel !== On.ch || On.code !== roomCode) return;
  if (!pin) SS.set(pinKey(roomCode), env.hpk);
  setFingerprint(env.hpk);

  if (env.seq <= On.envSeq) {
    console.warn("[Online] Rejecting envelope: old sequence", env.seq, "<=", On.envSeq);
    return;
  }

  const mine = env.keys && env.keys[myId];
  if (!mine) {
    On.envSeq = env.seq;
    On.hostPk = env.hek; On.locked = !!env.locked; On.sawRoom = true;
    if (On.wasIn) { leaveChannel(); renderError("صاحب الغرفة طلّعك من الغرفة 👋"); return; }
    if (!env.locked && (!On.joinEncrypted || Date.now() - On.lastJoinSent > 1500)) sendJoin();
    return;
  }

  let room, role;
  try {
    const k = await Sec.open(await Sec.pairKey(env.hek), mine);
    room = await Sec.open(await Sec.groupKey(k.g), env.enc);
    role = k.role && typeof k.role === "object" ? k.role : null;
  } catch { return; }
  if (channel !== On.ch || On.code !== roomCode) return;
  if (!room || room.hostId !== env.hostId || room.seq !== env.seq) return;

  On.envSeq = env.seq;
  On.hostPk = env.hek; On.locked = !!env.locked; On.sawRoom = true;
  On.myRole = role && typeof role.n === "number" ? { n: role.n, out: role.out === true, word: typeof role.word === "string" ? role.word : null, emoji: typeof role.emoji === "string" ? role.emoji : null } : null;
  receiveState(room);
}

// نتأكد إن كل قيمة بالنوع والطول الصح قبل ما نعرضها
function sanitizeRoom(r) {
  const okId = x => typeof x === "string" && x.length > 0 && x.length <= 64;
  const okInt = x => Number.isInteger(x) && x >= 0 && x < 1e6;
  const PHASES = ["lobby", "roles", "questions", "vote", "result", "guess", "finish"];
  if (typeof r.code !== "string" || !/^\d{6}$/.test(r.code) || !okId(r.hostId) || !okInt(r.seq) || !PHASES.includes(r.phase)) return false;
  if (r.players.length > MAX_PLAYERS || r.waiting.length > MAX_PLAYERS || r.chat.length > 60) return false;
  for (const p of r.players.concat(r.waiting)) {
    if (!p || !okId(p.id) || typeof p.name !== "string" || p.name.length > 30) return false;
    p.score = Number.isInteger(p.score) && p.score >= 0 && p.score < 1e5 ? p.score : 0;
    if (p.look && !decodeLook(p.look)) p.look = "";
    if (p.pk && !validPub(p.pk)) p.pk = "";
  }
  for (const m of r.chat) {
    if (!m || typeof m.id !== "string" || m.id.length > 64 || typeof m.text !== "string" || m.text.length > 300 || typeof m.name !== "string" || m.name.length > 30 || typeof m.t !== "number") return false;
  }
  const rd = r.round;
  if (rd) {
    if (!okInt(rd.n) || !okInt(rd.q) || !okInt(rd.qi || 0)) return false;
    if (!rd.pairs.every(pr => okId(pr[0]) && okId(pr[1]))) return false;
    if (rd.outsiderId != null && !okId(rd.outsiderId)) return false;
    if (rd.word != null && typeof rd.word !== "string") return false;
    if (rd.emoji != null && typeof rd.emoji !== "string") return false;
    if (rd.options && (!Array.isArray(rd.options) || rd.options.length > 12 || !rd.options.every(o => Array.isArray(o) && typeof o[0] === "string" && typeof o[1] === "string"))) return false;
    if (rd.notes && (!Array.isArray(rd.notes) || !rd.notes.every(n => typeof n === "string" && n.length < 200))) return false;
    rd.caught = rd.caught === true;
  }
  r.locked = r.locked === true;
  return true;
}

function receiveState(r) {
  if (r && typeof r === "object" && r.code === On.code && r.v !== ROOM_VERSION) { versionError(); return; }
  if (!r || typeof r !== "object" || !Array.isArray(r.players) || !Array.isArray(r.waiting) || !Array.isArray(r.chat) || r.code !== On.code) return;
  if (!Array.isArray(r.categories) || r.categories.some(c => !CATEGORIES[c])) return;
  if (r.round && (!Array.isArray(r.round.pairs) || !r.round.pairs.every(p => Array.isArray(p) && p.length === 2))) return;
  if (r.round && !CATEGORIES[r.round.cat]) return;
  if (!sanitizeRoom(r)) return;
  if (On.room && (r.hostId !== On.room.hostId || r.seq < On.room.seq)) return;
  clearTimeout(On.joinTimer);
  On.room = r;
  setActiveRoom("bara", r.code);
  const inRoom = r.players.some(p => p.id === myId) || r.waiting.some(p => p.id === myId);
  if (inRoom) On.wasIn = true;
  else if (On.wasIn) { leaveChannel(); renderError("صاحب الغرفة طلّعك من الغرفة 👋"); return; }
  else if (Date.now() - On.lastJoinSent > 1500) sendJoin();
  renderOnline();
}

/* ---------- جهة الهوست: منطق اللعبة ---------- */
function saveHost() { if (On.room) LS.set(HOST_PREFIX + On.room.code, JSON.stringify(On.room)); }

function commit() {
  const r = On.room; if (!r) return;
  setActiveRoom("bara", r.code);
  r.seq++;
  saveHost();
  broadcastState();
  renderOnline();
}

// اللي يشوفه الكل: بدون السالفة ومين برا السالفة والأصوات لين وقت الكشف
function publicRoom(r) {
  const c = JSON.parse(JSON.stringify(r));
  delete c.gk; delete c.ctr;
  if (c.round) {
    const reveal = ["result", "guess", "finish"].includes(c.phase);
    if (!reveal) {
      delete c.round.word; delete c.round.emoji; delete c.round.outsiderId; delete c.round.counts;
      c.round.votes = Object.fromEntries(Object.keys(c.round.votes || {}).map(k => [k, true]));
    }
  }
  return c;
}
function roleFor(r, id) {
  const rd = r.round;
  if (!rd) return null;
  const out = rd.outsiderId === id;
  return { n: rd.n, out, word: out ? null : rd.word, emoji: out ? null : rd.emoji };
}

// نرسل الحالة وحدة وحدة بالترتيب، ولو تغيرت أثناء الإرسال نرسل الأحدث بعدها
async function broadcastState(isRetry = false) {
  if (On.sending) { On.dirty = true; return; }
  if (!isRetry) On.stateRetryCount = 0;
  On.sending = true;
  try {
    do { On.dirty = false; await sendStateNow(); } while (On.dirty);
    On.stateRetryCount = 0;
    clearTimeout(On.stateRetryTimer); On.stateRetryTimer = null;
  } catch (e) {
    console.warn("broadcast", e);
    if (On.ch && On.isHost && On.stateRetryCount < 3) {
      const delay = 1000 * (On.stateRetryCount + 1);
      On.stateRetryCount++;
      clearTimeout(On.stateRetryTimer);
      On.stateRetryTimer = setTimeout(() => { if (On.ch && On.isHost) broadcastState(true); }, delay);
    }
  } finally { On.sending = false; }
}
async function sendStateNow() {
  const r = On.room, ch = On.ch;
  if (!r || !ch || !On.isHost) return;
  const keys = {};
  for (const p of r.players.concat(r.waiting)) {
    if (p.id === myId || !validPub(p.pk)) continue;
    try { keys[p.id] = await Sec.seal(await Sec.pairKey(p.pk), { g: r.gk, role: roleFor(r, p.id) }); }
    catch { /* مفتاح خربان: نتجاوزه */ }
  }
  const env = {
    v: ROOM_VERSION, code: r.code, hostId: r.hostId, seq: r.seq, locked: !!r.locked,
    ts: Date.now(), // إضافة timestamp لمنع replay attacks
    hpk: Sec.pubDsa, hek: Sec.pubEcdh, keys,
    enc: await Sec.seal(await Sec.groupKey(r.gk), publicRoom(r))
  };
  const s = JSON.stringify(env);
  const sig = await Sec.sign(s);
  if (ch === On.ch && r === On.room) await sendRealtimeBroadcast(ch, "state", { s, sig });
}

// حد للرسائل: 30 رسالة كل 10 ثواني لكل لاعب
function rateOk(id, limit = 30) {
  const now = Date.now();
  const list = (On.rate.get(id) || []).filter(t => now - t < 10000);
  const allowed = list.length < limit;
  if (allowed) list.push(now); // do not grow the bucket after it is already blocked
  On.rate.delete(id); // move this sender to the newest end of the bounded map
  On.rate.set(id, list);
  if (On.rate.size > 256) On.rate.delete(On.rate.keys().next().value);
  return allowed;
}

async function hostReceive(p, sourceChannel = On.ch) {
  const r = On.room;
  const channel = sourceChannel;
  if (!r || !p || typeof p !== "object" || typeof p.from !== "string" || !p.from.length || p.from.length > 64 || p.from === myId) return;
  if (p.box) {
    // لاعب موجود: لازم تنفك بمفتاحه المسجّل. لاعب جديد: يرسل مفتاحه العام مع رسالة دخول مشفرة
    let pk = pkOf(p.from);
    const newcomer = !pk;
    if (newcomer) {
      // Limit join retries per sender; one impatient player must not block all newcomers.
      if (!validPub(p.pk) || !rateOk("*newcomers*", 96) || !rateOk(p.from, 6)) return;
      pk = p.pk;
    } else if (!rateOk(p.from)) return;
    let a;
    try { a = await Sec.open(await Sec.pairKey(pk), p.box); } catch { return; }   // مفتاح خربان أو مو منه: نرفضها
    if (channel !== On.ch || r !== On.room) return;
    if (!a || typeof a !== "object" || !Number.isSafeInteger(a.c) || a.c < 0 || typeof a.type !== "string") return;
    if (newcomer && a.type !== "join") return;
    if (a.c <= (r.ctr[p.from] || 0)) return;   // رسالة مكررة
    r.ctr[p.from] = a.c;
    a.from = p.from;
    if (a.type === "join") a.pk = pk;
    hostHandle(a);
  } else if (p.type === "hello") {
    if (!rateOk(p.from) || !rateOk("*open*")) return;
    hostHandle({ type: "hello", from: p.from });
  }
}

function sysChat(text) {
  const r = On.room;
  r.chat.push({ id: "sys", name: "", text, t: Date.now() });
  if (r.chat.length > 40) r.chat.splice(0, r.chat.length - 40);
}

function uniqueName(name, r) {
  const taken = new Set(r.players.concat(r.waiting).map(p => p.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
}

function hostHandle(a) {
  const r = On.room;
  if (!r || !a || typeof a.from !== "string") return;
  const from = a.from;
  const p = r.players.find(x => x.id === from);
  const w = r.waiting.find(x => x.id === from);
  const rd = r.round;
  switch (a.type) {
    case "hello": break;
    case "look": {
      // اللاعب اختار شكل شخصيته
      const who = p || w;
      if (!who || !decodeLook(a.look)) return;
      who.look = a.look;
      break;
    }
    case "join": {
      if (!validPub(a.pk)) return;
      const ex = p || w;
      if (ex) {
        if (ex.pk && ex.pk !== a.pk) return;   // واحد يحاول ياخذ مكان لاعب موجود
        ex.pk = a.pk;
        break;
      }
      if (r.locked) return;
      if (r.players.length + r.waiting.length >= MAX_PLAYERS) return;
      const entry = { id: from, name: uniqueName(cleanText(a.name, 20) || "لاعب", r), score: 0, look: decodeLook(a.look) ? a.look : "", pk: a.pk };
      if (r.phase === "lobby") r.players.push(entry); else r.waiting.push(entry);
      sysChat(`${entry.name} دخل الغرفة 👋`);
      break;
    }
    case "leave": {
      if (w) r.waiting = r.waiting.filter(x => x.id !== from);
      else if (p && r.phase === "lobby") r.players = r.players.filter(x => x.id !== from);
      else return;
      sysChat(`${(p || w).name} طلع من الغرفة 🚶`);
      r.gk = Sec.newGroupRaw();   // مفتاح جديد عشان اللي طلع ما يقدر يقرأ بعدين
      break;
    }
    case "ready":
      if (r.phase !== "roles" || !p) return;
      rd.ready[from] = true;
      if (r.players.every(x => rd.ready[x.id])) toQuestions();
      break;
    case "next":
      // ينتقل للسؤال الجاي: صاحب الغرفة أو اللي يسأل أو اللي ينسأل
      if (r.phase !== "questions" || a.qi !== rd.qi || rd.qi >= rd.pairs.length) return;
      if (from !== r.hostId && !rd.pairs[rd.qi].includes(from)) return;
      rd.qi++;
      break;
    case "vote":
      if (r.phase !== "vote" || !p || a.target === from || !r.players.some(x => x.id === a.target)) return;
      rd.votes[from] = a.target;
      if (r.players.every(x => rd.votes[x.id])) tally();
      break;
    case "guess":
      if (r.phase !== "guess" || from !== rd.outsiderId || !rd.options.some(o => o[0] === a.word)) return;
      finishOnline(a.word);
      break;
    case "chat": {
      const text = cleanText(a.text, 200);
      const who = p || w;
      if (!text || !who) return;
      if (from !== myId && Date.now() - (On.lastChat.get(from) || 0) < 500) return;   // ما نسمح بالإغراق
      On.lastChat.delete(from);
      On.lastChat.set(from, Date.now());
      if (On.lastChat.size > 256) On.lastChat.delete(On.lastChat.keys().next().value);
      r.chat.push({ id: from, name: who.name, text, t: Date.now() });
      if (r.chat.length > 40) r.chat.splice(0, r.chat.length - 40);
      break;
    }
    default: return;
  }
  commit();
}

function hostStart() {
  const r = On.room;
  r.players.push(...r.waiting); r.waiting = [];
  if (r.players.length < 3) { toast("لازم 3 لاعبين على الأقل"); commit(); return; }
  const cat = pickCat(r.categories);
  const [word, emoji] = CATEGORIES[cat].words[rand(CATEGORIES[cat].words.length)];
  const outsiderIdx = pickOutsider(r.players, r.outsiderHistory);
  const maxHistory = Math.min(5, r.players.length - 1);
  updateOutsiderHistory(r.outsiderHistory, r.players[outsiderIdx].id, maxHistory);
  r.round = {
    n: ((r.round && r.round.n) || 0) + 1, q: 0,
    cat, word, emoji, outsiderId: r.players[outsiderIdx].id,
    ready: {}, votes: {}, pairs: [], qi: 0, caught: false, options: [], guess: null, notes: []
  };
  r.phase = "roles";
  commit();
}

function toQuestions() {
  const r = On.room, rd = r.round;
  rd.pairs = makePairs(r.players.map(p => p.id));
  rd.qi = 0;
  rd.q++;
  r.phase = "questions";
}

function tally() {
  const r = On.room, rd = r.round;
  const counts = {};
  Object.values(rd.votes).forEach(t => counts[t] = (counts[t] || 0) + 1);
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter(k => counts[k] === max);
  rd.caught = max > 0 && top.length === 1 && top[0] === rd.outsiderId;
  rd.counts = counts;
  r.phase = "result";
}

function toGuess() {
  const r = On.room, rd = r.round;
  rd.options = makeGuessOptions(rd.cat, rd.word, rd.emoji);
  r.phase = "guess";
}

function finishOnline(guess) {
  const r = On.room, rd = r.round;
  rd.guess = guess;
  const right = guess === rd.word;
  const notes = [];
  r.players.forEach(p => {
    if (p.id !== rd.outsiderId && rd.votes[p.id] === rd.outsiderId) { p.score += 1; notes.push(`✅ ${p.name} +1 (صوّت صح)`); }
  });
  const out = r.players.find(p => p.id === rd.outsiderId);
  if (out) {
    if (!rd.caught) { out.score += 2; notes.push(`😎 ${out.name} +2 (ما انكشف)`); }
    if (right) { out.score += 2; notes.push(`🧠 ${out.name} +2 (عرف السالفة)`); }
  }
  rd.notes = notes;
  r.phase = "finish";
}

const Host = {
  toggleCat(c) { On.room.categories = toggleCat(On.room.categories, c); saveCats(On.room.categories); commit(); },
  kick(id) {
    const r = On.room;
    const p = r.players.concat(r.waiting).find(x => x.id === id);
    if (!p || id === myId) return;
    if (r.phase !== "lobby" && r.players.some(x => x.id === id)) { toast("تقدر تطلّع اللاعبين بين الجولات بس"); return; }
    r.players = r.players.filter(x => x.id !== id);
    r.waiting = r.waiting.filter(x => x.id !== id);
    sysChat(`${p.name} طلع من الغرفة 🚶`);
    r.gk = Sec.newGroupRaw();   // مفتاح جديد عشان اللي انطرد ما يقدر يقرأ بعدين
    commit();
  },
  toggleLock() {
    const r = On.room;
    r.locked = !r.locked;
    sysChat(r.locked ? "صاحب الغرفة قفل الغرفة 🔒 ما يقدر يدخل أحد جديد" : "صاحب الغرفة فتح الغرفة 🔓");
    commit();
  },
  skipRoles() { if (On.room.phase === "roles") { toQuestions(); commit(); } },
  reshuffle() { if (On.room.phase === "questions") { toQuestions(); commit(); } },
  toVote() { if (On.room.phase === "questions") { On.room.phase = "vote"; commit(); } },
  skipVotes() { if (On.room.phase === "vote") { tally(); commit(); } },
  toGuess() { if (On.room.phase === "result") { toGuess(); commit(); } },
  lobby() {
    const r = On.room;
    r.players.push(...r.waiting); r.waiting = [];
    r.phase = "lobby"; commit();
  },
  resetScores() { On.room.players.forEach(p => p.score = 0); commit(); },
  async close() {
    const code = On.room.code, ch = On.ch;
    try {
      const s = JSON.stringify({ code, closed: true, t: Date.now() });
      if (ch) await sendRealtimeBroadcast(ch, "closed", { s, sig: await Sec.sign(s) });
    } catch {}
    LS.del(HOST_PREFIX + code);
    leaveChannel();
    renderHome();
  }
};

/* ---------- الرسم ---------- */
function ensureLayout() {
  if (!document.getElementById("screen")) {
    app.innerHTML = `<div id="screen"></div>`;
    app.dataset.key = "online";
  }
  ensureChat();
}

/* ----- الدردشة العائمة (زر + لوحة تطلع من تحت) ----- */
function ensureChat() {
  if (document.getElementById("chatFab")) return;
  const fab = document.createElement("button");
  fab.id = "chatFab"; fab.className = "chat-fab"; fab.dataset.quiet = "1";
  fab.setAttribute("aria-label", "الدردشة");
  fab.innerHTML = `💬<span class="unread" id="chatUnread"></span>`;
  const sheet = document.createElement("div");
  sheet.id = "chatSheet"; sheet.className = "chat-sheet";
  sheet.innerHTML = `
    <div class="chat-head"><span>💬 الدردشة</span><button class="icon-btn" id="chatClose" data-quiet="1" aria-label="إغلاق">✕</button></div>
    <div class="chat-list" id="chatList"></div>
    <div class="row">
      <input id="chatInput" placeholder="اكتب سؤالك أو جوابك..." maxlength="200" autocomplete="off">
      <button id="chatSend" data-quiet="1">إرسال</button>
    </div>`;
  document.body.append(fab, sheet);
  document.body.classList.add("has-chat");
  Voice.ensureUi();
  fab.onclick = () => toggleChat(true);
  document.getElementById("chatClose").onclick = () => toggleChat(false);
  const input = document.getElementById("chatInput");
  const send = () => {
    const text = cleanText(input.value, 200);
    if (!text) return;
    input.value = "";
    SFX.message();
    sendAction({ type: "chat", text });
  };
  document.getElementById("chatSend").onclick = send;
  input.onkeydown = e => { if (e.key === "Enter") send(); };
}

function toggleChat(open) {
  const fab = document.getElementById("chatFab"), sheet = document.getElementById("chatSheet");
  if (!fab) return;
  On.chatOpen = open;
  sheet.classList.toggle("open", open);
  fab.classList.toggle("hidden", open);
  if (open) {
    markChatSeen();
    const list = document.getElementById("chatList");
    list.scrollTop = list.scrollHeight;
    setTimeout(() => document.getElementById("chatInput").focus(), 300);
    SFX.pop();
  } else SFX.hide();
}

function markChatSeen() {
  const r = On.room;
  On.chatSeenT = r && r.chat.length ? r.chat[r.chat.length - 1].t : Date.now();
  updateUnread();
}

function updateUnread() {
  const badge = document.getElementById("chatUnread");
  if (!badge || !On.room) return;
  const n = On.chatOpen ? 0 : On.room.chat.filter(m => m.t > (On.chatSeenT || 0) && m.id !== myId && m.id !== "sys").length;
  badge.textContent = n > 9 ? "9+" : n;
  badge.classList.toggle("show", n > 0);
}

function removeChat() {
  ["chatFab", "chatSheet"].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  Voice.removeUi();
  document.body.classList.remove("has-chat");
  On.chatOpen = false;
}

function renderChat() {
  const r = On.room, list = document.getElementById("chatList");
  if (!list) return;
  if (On.chatSeenT == null) On.chatSeenT = r.chat.length ? r.chat[r.chat.length - 1].t : 0;
  const sig = r.chat.length ? r.chat[r.chat.length - 1].t + ":" + r.chat.length : "0";
  if (list.dataset.sig === sig) return;
  const last = r.chat[r.chat.length - 1];
  if (list.dataset.sig && last) {
    if (last.id === "sys") { if (last.text.includes("دخل")) SFX.join(); }
    else if (last.id !== myId) {
      SFX.message();
      if (!On.chatOpen) { const fab = document.getElementById("chatFab"); fab.classList.remove("bump"); void fab.offsetWidth; fab.classList.add("bump"); }
    }
  }
  if (On.chatOpen) markChatSeen(); else updateUnread();
  list.dataset.sig = sig;
  list.innerHTML = r.chat.length
    ? r.chat.map(m => m.id === "sys"
        ? `<div class="msg sys">${esc(m.text)}</div>`
        : `<div class="msg ${m.id === myId ? "mine" : ""}">${avatar(m.id, "sm")}<div class="bubble"><b>${esc(m.name)}</b>${esc(m.text)}</div></div>`).join("")
    : `<div class="msg sys">ما فيه رسائل للحين</div>`;
  list.scrollTop = list.scrollHeight;
}

function playerOf(id) {
  return On.room.players.concat(On.room.waiting).find(x => x.id === id) || { id, name: "؟" };
}
function nameOf(id) { return playerOf(id).name; }
function myRoleNow() {
  const rd = On.room && On.room.round;
  if (!rd) return null;
  if (On.isHost) { const out = rd.outsiderId === myId; return { n: rd.n, out, word: out ? null : rd.word, emoji: out ? null : rd.emoji }; }
  return On.myRole && On.myRole.n === rd.n ? On.myRole : null;
}

function renderOnline() {
  const r = On.room;
  if (!r) return;
  setAvLooks(r.players.concat(r.waiting));
  // شاشة "شخصيتك" مفتوحة: ما نرسم فوقها (بس نحدّث الدردشة)، إلا إذا بدت الجولة
  if (On.editing) {
    if (r.phase === "lobby") { ensureChat(); renderChat(); return; }
    On.editing = false;
  }
  ensureLayout();
  renderChat();

  // الدردشة لها رسم منفصل، فما نعيد رسم الشاشة بسبب رسالة جديدة
  const sig = JSON.stringify([r.phase, [...On.online].sort(), [...Voice.members], On.myRole, On.myVote, On.fp, On.ui, r.players, r.waiting, r.categories, r.locked, r.round]);
  if (sig === On.lastSig) return;
  On.lastSig = sig;

  const screen = document.getElementById("screen");
  const rd = r.round;
  const phaseKey = r.phase + ":" + (rd ? rd.n + "." + rd.q : 0);
  if (phaseKey !== On.lastPhase) {
    if (On.lastPhase !== null) phaseSound(r.phase);
    On.lastPhase = phaseKey;
    On.ui.peek = false;
    if (r.phase === "roles") On.ui.shown = false;
    Music.setMood(r.phase === "questions" || r.phase === "vote" ? "tense" : "calm");
  }
  const me = r.players.find(p => p.id === myId);
  const role = myRoleNow();
  const isOut = !!(role && role.out);

  if (!me && r.phase !== "lobby") {
    setFloaters(["⏳", "🕵️", "🤫"]);
    paintEl(screen, "waiting", `
      <div class="card status-big" style="margin-top:30px">
        <div class="big-emoji float">⏳</div>
        <div class="title">الجولة شغالة</div>
        <p class="hint">بتدخل معهم الجولة الجاية</p>
      </div>
      ${leaveBtnHtml()}`);
    bindLeave();
    return;
  }

  if (rd && role && role.word) preloadPoster(rd.cat, role.word);
  if (rd) setFloaters([CATEGORIES[rd.cat].icon, "❓", "🤔", "🕵️"]);
  else setFloaters(HOME_FLOATERS);

  switch (r.phase) {
    case "lobby": return renderLobby(screen);
    case "roles": return renderRolesOnline(screen, isOut);
    case "questions": return renderQuestionsOnline(screen, isOut);
    case "vote": return renderVoteOnline(screen, isOut);
    case "result": return renderResultOnline(screen);
    case "guess": return renderGuessOnline(screen, isOut);
    case "finish": return renderFinishOnline(screen);
  }
}

function phaseSound(phase) {
  if (phase === "roles") SFX.start();
  else if (phase === "questions" || phase === "guess") SFX.whoosh();
  else if (phase === "vote") SFX.vote();
  else if (phase === "lobby") SFX.pop();
}

function leaveBtnHtml() { return `<button class="big ghost" id="leaveBtn">${On.isHost ? "🔒 اقفل الغرفة" : "🚪 اطلع من الغرفة"}</button>`; }
function bindLeave() {
  const b = document.getElementById("leaveBtn");
  if (!b) return;
  b.onclick = () => {
    if (On.isHost) { if (confirm("أكيد تبي تقفل الغرفة؟ بتطلع الكل.")) Host.close(); }
    else if (confirm("أكيد تبي تطلع من الغرفة؟")) {
      (async () => {
        try { await sendAction({ type: "leave" }); }
        finally { leaveChannel(); renderHome(); }
      })();
    }
  };
}

function catPillOnline(cat) { return `<div class="pill">${CATEGORIES[cat].icon} ${esc(cat)}</div>`; }

function roleCardFor(isOut) {
  const rd = On.room.round, role = myRoleNow();
  if (!role) return `<div class="card status-big"><div class="big-emoji spin">⏳</div><p class="hint">جاري استلام دورك...</p></div>`;
  return roleCardHtml(isOut, role.word, role.emoji, role.word ? posterFor(rd.cat, role.word) : "");
}
function peekHtml(isOut) {
  const rd = On.room.round;
  return `
    <button class="big ghost" id="peekBtn" data-quiet="1">${On.ui.peek ? "🙈 خبّ دوري" : "👁️ شوف دوري"}</button>
    ${On.ui.peek ? roleCardFor(isOut) : ""}`;
}
function bindPeek() {
  const b = document.getElementById("peekBtn");
  if (b) b.onclick = () => { On.ui.peek = !On.ui.peek; renderOnline(); On.ui.peek ? SFX.cardReveal() : SFX.hide(); };
}

function pendingHtml(doneMap, label) {
  const r = On.room;
  const done = r.players.filter(p => doneMap[p.id]).length;
  return `
    <div class="card center">
      <div class="card-title" style="justify-content:center">${label} ${done}/${r.players.length}</div>
      <div class="waitlist">
        ${r.players.map(p => `<div class="wait-item ${doneMap[p.id] ? "done" : ""}">${avatar(p.id, "md")}<span>${esc(p.name)}</span></div>`).join("")}
      </div>
    </div>`;
}

/* ----- اللوبي ----- */
function renderLobby(screen) {
  const r = On.room, H = On.isHost;
  const canShare = !!navigator.share;
  paintEl(screen, "lobby", `
    <div class="card center">
      <div class="muted">كود الغرفة</div>
      ${codeTiles(r.code)}
      <div class="share-row">
        <button class="ghost" id="copyBtn">📋 انسخ الرابط</button>
        ${canShare ? `<button class="ghost" id="shareBtn">📤 شارك</button>` : ""}
      </div>
    </div>
    <div class="card">
      <div class="card-title">👥 اللاعبين <span class="badge">${r.players.length}/${MAX_PLAYERS}</span></div>
      <ul class="players">
        ${r.players.map(p => `
          <li>
            <span class="status-dot ${On.online.has(p.id) ? "on" : ""}"></span>
            ${p.id === myId ? avatarBtn(p.id, 'data-myav="1"') : avatar(p.id)}
            <span class="pname">${esc(p.name)}</span>
            ${voiceTag(p.id)}
            ${p.id === r.hostId ? `<span class="tag">👑 صاحب الغرفة</span>` : ""}
            ${p.id === myId ? `<span class="tag">أنت</span>` : ""}
            ${p.score ? `<span class="pscore">${Number(p.score) || 0} ⭐</span>` : ""}
            ${H && p.id !== myId ? `<button class="x-btn" data-kick="${esc(p.id)}" data-quiet="1" aria-label="طلّع">✕</button>` : ""}
          </li>`).join("")}
      </ul>
      ${r.players.length < 3 ? `<p class="hint">لازم 3 لاعبين على الأقل، ارسل الرابط للشباب 👆</p>` : ""}
      ${H ? `<button class="big ghost" id="lockBtn">${r.locked ? "🔒 الغرفة مقفلة (اضغط عشان تفتحها)" : "🔓 الغرفة مفتوحة (اضغط عشان تقفلها)"}</button>`
          : r.locked ? `<p class="hint">🔒 صاحب الغرفة قفل الغرفة</p>` : ""}
      <div class="fp-box">
        <div>🔐 بصمة الغرفة</div>
        <div class="fp">${On.fp || "..."}</div>
        <div class="hint" style="margin:4px 0 0">لازم تكون نفسها بالضبط عند كل اللاعبين. الغرفة مشفرة، والدردشة والأدوار ما يشوفها إلا اللي داخلها.</div>
      </div>
      <p class="hint">اضغط على شخصيتك عشان تختار شكلها ✏️</p>
    </div>
    <div class="card">
      <div class="card-title">📂 التصنيف</div>
      ${chipsHtml(r.categories, !H)}
    </div>
    ${H
      ? `<button class="big" id="startBtn" ${r.players.length < 3 ? "disabled" : ""}>ابدأ الجولة 🎲</button>
         ${r.players.some(p => p.score) ? `<button class="big ghost" id="resetBtn">تصفير النقاط 🔄</button>` : ""}`
      : `<div class="card center"><span class="spin">⏳</span> استنى صاحب الغرفة يبدأ</div>`}
    ${leaveBtnHtml()}`);
  document.getElementById("copyBtn").onclick = () => copyText(shareLink(r.code), "تم نسخ الرابط ✅");
  const lb = document.getElementById("lockBtn");
  if (lb) lb.onclick = () => { SFX.pop(); Host.toggleLock(); };
  const mine = screen.querySelector("[data-myav]");
  if (mine) mine.onclick = () => {
    SFX.pop();
    On.editing = true;
    const close = () => { On.editing = false; On.lastSig = null; app.innerHTML = ""; renderOnline(); };
    openLookEditor(myName(), lookFor(myId), look => {
      LS.set(LOOK_KEY, look);
      sendAction({ type: "look", look });
      close();
    }, close);
  };
  const sh = document.getElementById("shareBtn");
  if (sh) sh.onclick = () => navigator.share({ title: "مين برا السالفة؟", text: `تعال العب معنا! كود الغرفة ${r.code}`, url: shareLink(r.code) }).catch(() => {});
  if (H) {
    screen.querySelectorAll("[data-cat]").forEach(b => b.onclick = () => { SFX.select(); Host.toggleCat(b.dataset.cat); });
    screen.querySelectorAll("[data-kick]").forEach(b => b.onclick = () => { if (confirm("تطلّع هذا اللاعب؟")) { SFX.remove(); Host.kick(b.dataset.kick); } });
    document.getElementById("startBtn").onclick = hostStart;
    const rs = document.getElementById("resetBtn");
    if (rs) rs.onclick = () => { if (confirm("أكيد تبي تصفر النقاط؟")) Host.resetScores(); };
  }
  bindLeave();
}

/* ----- كشف الأدوار ----- */
function renderRolesOnline(screen, isOut) {
  const rd = On.room.round, H = On.isHost;
  const ready = !!rd.ready[myId];
  let body;
  if (!On.ui.shown && !ready) {
    body = `
      <div class="card pass">
        ${avatar(myId, "xl")}
        <div class="pass-name">دورك جاهز</div>
        <div class="hint">تأكد ما أحد يشوف شاشتك 👀</div>
      </div>
      <button class="big" id="showBtn" data-quiet="1">اقلب الكرت 🃏</button>`;
  } else if (!ready) {
    body = `${roleCardFor(isOut)}
      <button class="big" id="readyBtn" data-quiet="1">شفت دوري ✔️</button>`;
  } else {
    body = `${pendingHtml(rd.ready, "جاهزين")}${peekHtml(isOut)}`;
  }
  paintEl(screen, "roles-" + rd.n + (ready ? "r" : On.ui.shown ? "s" : ""), `
    ${catPillOnline(rd.cat)}
    ${body}
    ${H && ready ? `<button class="big ghost" id="skipBtn">كمّل بدون الباقين ⏭️</button>` : ""}`);
  const s = document.getElementById("showBtn");
  if (s) s.onclick = () => { On.ui.shown = true; renderOnline(); SFX.cardReveal(); };
  const rb = document.getElementById("readyBtn");
  if (rb) rb.onclick = () => { SFX.hide(); rb.disabled = true; sendAction({ type: "ready" }); };
  const sk = document.getElementById("skipBtn");
  if (sk) sk.onclick = () => Host.skipRoles();
  bindPeek();
}

/* ----- الأسئلة: سؤال واحد كل مرة ----- */
function renderQuestionsOnline(screen, isOut) {
  const rd = On.room.round, H = On.isHost;
  const qi = rd.qi || 0;
  if (qi >= rd.pairs.length) {
    const key = "qdone-" + rd.n + "." + rd.q;
    if (On.lastQ !== key) { On.lastQ = key; SFX.pop(); }
    paintEl(screen, key, `
      ${qDoneHtml()}
      ${peekHtml(isOut)}
      ${H
        ? `<button class="big ghost" id="reshuffle">أسئلة جولة ثانية 🔄</button>
           <button class="big" id="voteBtn">يلا نصوّت 🗳️</button>`
        : `<p class="hint">صاحب الغرفة يقرر 👑</p>`}`);
    if (H) {
      document.getElementById("reshuffle").onclick = () => { SFX.whoosh(); Host.reshuffle(); };
      document.getElementById("voteBtn").onclick = Host.toVote;
    }
    bindPeek();
    return;
  }
  const [a, b] = rd.pairs[qi];
  const canNext = H || a === myId || b === myId;
  const key = "q-" + rd.n + "." + rd.q + "." + qi;
  if (On.lastQ !== key) { On.lastQ = key; SFX.whoosh(); setTimeout(SFX.pop, 450); if (a === myId) vibrate(150); }
  paintEl(screen, key, `
    ${questionHtml({ cat: rd.cat, round: rd.n, i: qi, total: rd.pairs.length, a: { key: a, name: nameOf(a) }, b: { key: b, name: nameOf(b) } })}
    ${a === myId ? `<p class="hint you">دورك تسأل! 🎤</p>` : b === myId ? `<p class="hint you">جهّز جوابك 🤔</p>` : ""}
    ${canNext
      ? `<button class="big" id="nextQ" data-quiet="1">خلصنا ✔️</button>`
      : `<p class="hint">بالدردشة أو بالصوت، ولما يخلصون يضغطون "خلصنا"</p>`}
    ${H ? `<button class="big ghost" id="voteNow">يلا نصوّت على طول 🗳️</button>` : ""}
    ${peekHtml(isOut)}`);
  const nb = document.getElementById("nextQ");
  if (nb) nb.onclick = () => { SFX.select(); nb.disabled = true; sendAction({ type: "next", qi }); };
  const vn = document.getElementById("voteNow");
  if (vn) vn.onclick = Host.toVote;
  bindPeek();
}

/* ----- التصويت ----- */
function renderVoteOnline(screen, isOut) {
  const r = On.room, rd = r.round, H = On.isHost;
  // صوتك نعرفه من جهازك، لأن الأصوات ما تنرسل للكل قبل النتيجة
  const voted = rd.votes[myId] ? (On.isHost ? rd.votes[myId] : (On.myVote && On.myVote.n === rd.n ? On.myVote.target : null)) : null;
  paintEl(screen, "vote-" + rd.n + (voted ? "v" : ""), voted
    ? `<div class="title">صوّتت على ${esc(nameOf(voted))} ✅</div>
       ${pendingHtml(rd.votes, "صوّتوا")}
       ${H ? `<button class="big ghost" id="skipBtn">اعرض النتيجة بدون الباقين ⏭️</button>` : ""}`
    : `<div class="title">مين برا السالفة؟ 🕵️</div>
       <p class="hint" style="margin:-6px 0 14px">صوتك سري 🤐</p>
       <div class="grid stagger">
         ${r.players.filter(p => p.id !== myId).map((p, i) => `<button class="pick" data-v="${esc(p.id)}" data-quiet="1" style="--i:${i}">${avatar(p.id)}<span>${esc(p.name)}</span></button>`).join("")}
       </div>
       ${peekHtml(isOut)}`);
  screen.querySelectorAll("[data-v]").forEach(b => b.onclick = () => {
    SFX.vote();
    screen.querySelectorAll("[data-v]").forEach(x => x.disabled = true);
    On.myVote = { n: rd.n, target: b.dataset.v };
    sendAction({ type: "vote", target: b.dataset.v });
  });
  const sk = document.getElementById("skipBtn");
  if (sk) sk.onclick = () => Host.skipVotes();
  bindPeek();
}

/* ----- النتيجة ----- */
function renderResultOnline(screen) {
  const r = On.room, rd = r.round, H = On.isHost;
  if (On.ui.resultShown !== rd.n) {
    if (On.ui.suspenseFor !== rd.n) {
      On.ui.suspenseFor = rd.n;
      paintEl(screen, "suspense-" + rd.n, suspenseHtml());
      SFX.drumroll();
      Music.duck(3.5);
      const n = rd.n;
      setTimeout(() => { if (On.room && On.room.round && On.room.round.n === n) { On.ui.resultShown = n; showResultFx(); renderOnline(); } }, 2300);
    }
    return;
  }
  const out = playerOf(rd.outsiderId);
  const iAmOut = rd.outsiderId === myId;
  paintEl(screen, "result-" + rd.n, `
    ${outsiderBoxHtml(rd.caught, out)}
    <div class="card">
      <div class="card-title">📊 الأصوات</div>
      ${voteBarsHtml(r.players, rd.counts || {}, rd.outsiderId, p => p.id)}
    </div>
    ${H
      ? `<button class="big" id="guessBtn">خلّ ${esc(out.name)} يخمّن السالفة 🤔</button>`
      : `<p class="hint">${iAmOut ? "جهّز نفسك، بتخمّن السالفة 🤔" : `بعدها ${esc(out.name)} بيخمّن السالفة`}</p>`}`);
  const g = document.getElementById("guessBtn");
  if (g) g.onclick = Host.toGuess;
}
function showResultFx() {
  const rd = On.room.round;
  if (rd.caught) { SFX.caught(); confetti(); vibrate([80, 40, 80, 40, 200]); }
  else { SFX.escaped(); confetti(50, ["😎", "💨", "🏃‍♂️"]); }
}

/* ----- التخمين ----- */
function renderGuessOnline(screen, isOut) {
  const rd = On.room.round;
  if (!isOut) {
    paintEl(screen, "guess-wait-" + rd.n, `
      <div class="card status-big" style="margin-top:20px">
        ${avatar(rd.outsiderId, "xl")}
        <div class="title" style="margin-top:12px">${esc(nameOf(rd.outsiderId))} يخمّن السالفة</div>
        <div class="dots"><span></span><span></span><span></span></div>
      </div>
      ${catPillOnline(rd.cat)}`);
    return;
  }
  paintEl(screen, "guess-" + rd.n, `
    <div class="title">وش السالفة؟ 🤔</div>
    ${catPillOnline(rd.cat)}
    ${optionsHtml(rd.options)}`);
  const buttons = screen.querySelectorAll("[data-g]");
  buttons.forEach(b => b.onclick = () => {
    buttons.forEach(x => x.disabled = true);
    SFX.select();
    sendAction({ type: "guess", word: rd.options[+b.dataset.g][0] });
  });
}

/* ----- نهاية الجولة ----- */
function renderFinishOnline(screen) {
  const r = On.room, rd = r.round, H = On.isHost;
  const right = rd.guess === rd.word;
  const firstTime = On.ui.finishShown !== rd.n;
  On.ui.finishShown = rd.n;
  const guessed = rd.guess ? (CATEGORIES[rd.cat].words.find(w => w[0] === rd.guess) || [rd.guess, "❔"]) : null;
  paintEl(screen, "finish-" + rd.n, `
    <div class="title ${right ? "pop" : "shake"}">${right ? "عرفها! 🔥" : "ما عرفها ❌"}</div>
    ${guessed ? `<p class="hint" style="margin:-6px 0 12px">${esc(nameOf(rd.outsiderId))} خمّن: ${esc(guessed[1])} ${esc(guessed[0])}</p>` : ""}
    ${wordRevealHtml(rd.word, rd.emoji, posterFor(rd.cat, rd.word))}
    <div class="card">
      <div class="card-title">🏆 الترتيب</div>
      ${rankingHtml(r.players)}
    </div>
    <div class="card">
      <div class="card-title">✨ نقاط الجولة</div>
      ${notesHtml(rd.notes)}
    </div>
    ${H
      ? `<button class="big" id="againBtn">جولة جديدة 🎲</button>
         <button class="big ghost" id="lobbyBtn">رجوع للغرفة 🏠</button>`
      : `<div class="card center"><span class="spin">⏳</span> استنى صاحب الغرفة</div>`}
    ${leaveBtnHtml()}`);
  if (firstTime) {
    if (right) { SFX.correct(); confetti(80, [String(rd.emoji), "✨"]); } else { SFX.wrong(); vibrate(300); setTimeout(SFX.win, 700); }
    playCoins(rd.notes.length);
    setTimeout(() => burstFrom(screen.querySelector(".p1 .av"), 50, ["👑", "⭐"]), 1000);
  }
  if (H) {
    document.getElementById("againBtn").onclick = hostStart;
    document.getElementById("lobbyBtn").onclick = Host.lobby;
  }
  bindLeave();
}

/* ---------- البداية ---------- */
(function init() {
  const params = new URLSearchParams(location.search);
  let code = (params.get("room") || "").replace(/\D/g, "").slice(0, CODE_LEN);
  let atCode = (params.get("atroom") || "").replace(/\D/g, "").slice(0, CODE_LEN);
  if (!code && !atCode) {
    const active = getActiveRoom();
    if (active) {
      if (active.game === "bara") {
        code = active.code;
        history.replaceState(null, "", location.pathname + "?room=" + code);
      } else {
        atCode = active.code;
        history.replaceState(null, "", location.pathname + "?atroom=" + atCode);
      }
    }
  }
  const k = new URLSearchParams(location.hash.slice(1)).get("k") || "";
  if (code.length === CODE_LEN && validPub(k) && !SS.get(pinKey(code))) SS.set(pinKey(code), k);
  if (code.length === CODE_LEN) {
    if (myName()) joinRoom(code); else renderNameForRoom(code);
  } else if (atCode.length !== CODE_LEN) renderHome();
})();
