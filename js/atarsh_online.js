/* ============================================================
   لعبة "مين الأطرش بالزفة؟" — اللعب أونلاين
   كل لاعب على جواله، أسئلة سرية مشفرة، تصويت، ونتائج.
   يعتمد على Supabase Realtime (On.sb من online.js) + Sec + Voice
   ============================================================ */

// ===== ثوابت =====
const AT_ROOM_VERSION = 17;
const AT_HOST_PREFIX  = "atarsh_host_";
const AT_NAME_KEY     = "atarsh_name";
const AT_LOOK_KEY     = "atarsh_look";
const AT_PIN_KEY_PRE  = "atarsh_pin_";
const AT_CODE_LEN     = 6;
const AT_MAX_PLAYERS  = 12;
const AT_PHASES       = ["lobby", "answers", "discussion", "vote", "result", "finish"];

// ===== الحالة العامة =====
const AtOn = {
  sb: null, ch: null, code: null, isHost: false,
  room: null, online: new Set(),
  wasIn: false, joinTimer: null, lastJoinSent: 0, joinRetry: null,
  stateRetryTimer: null, stateRetryCount: 0,
  lastSig: null, lastPhase: null,
  hostPk: null, myRole: null, myAnswer: null, myVote: null,
  envSeq: 0, sawRoom: false, locked: false,
  fp: "", fpFor: "",
  hq: Promise.resolve(), cq: Promise.resolve(),
  rate: new Map(), lastChat: new Map(),
  sendC: 0, sending: false, dirty: false,
  chatOpen: false, chatSeenT: null,
  ui: {}
};
function freshAtUi() { return { resultShown: 0, suspenseFor: 0, finishShown: 0 }; }
AtOn.ui = freshAtUi();

// ===== مساعدات أساسية =====
function atMyName() { return cleanText(LS.get(AT_NAME_KEY), 20); }
function atMyLook() { const l = LS.get(AT_LOOK_KEY); return decodeLook(l) ? l : ""; }
function atShareLink(code) {
  const k = AtOn.isHost && Sec.pubDsa ? "#k=" + encodeURIComponent(Sec.pubDsa) : "";
  return location.origin + location.pathname + "?atroom=" + code + k;
}

function atPkOf(id) {
  const r = AtOn.room;
  if (!r) return null;
  const p = r.players.concat(r.waiting).find(x => x.id === id);
  return p && validPub(p.pk) ? p.pk : null;
}

function atSaveHost() {
  if (AtOn.room) LS.set(AT_HOST_PREFIX + AtOn.room.code, JSON.stringify(AtOn.room));
}

function atSysChat(text) {
  const r = AtOn.room;
  if (!r) return;
  r.chat.push({ id: "sys", name: "", text, t: Date.now() });
  if (r.chat.length > 40) r.chat.splice(0, r.chat.length - 40);
}

function atUniqueName(name, r) {
  const taken = new Set(r.players.concat(r.waiting).map(p => p.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
}

function atRateOk(id, limit = 30) {
  const now = Date.now();
  const list = (AtOn.rate.get(id) || []).filter(t => now - t < 10000);
  const allowed = list.length < limit;
  if (allowed) list.push(now);
  AtOn.rate.delete(id);
  AtOn.rate.set(id, list);
  if (AtOn.rate.size > 256) AtOn.rate.delete(AtOn.rate.keys().next().value);
  return allowed;
}

function atCodifiedError(msg, sub) {
  clearActiveRoom("atarsh");
  history.replaceState(null, "", location.pathname);
  paint("at-error-" + Math.random(), `
    <div class="card status-big" style="margin-top:60px">
      <div class="big-emoji wiggle">🙈</div>
      <div class="title">${msg}</div>
      ${sub ? `<p class="hint">${esc(sub)}</p>` : ""}
    </div>
    <button class="big" id="atErrHomeBtn">الرئيسية 🏠</button>`);
  SFX.wrong();
  document.getElementById("atErrHomeBtn").onclick = renderGame2Home;
}

async function atSetFingerprint(pub) {
  if (!validPub(pub) || AtOn.fpFor === pub) return;
  const channel = AtOn.ch, code = AtOn.code;
  AtOn.fpFor = pub;
  let h;
  try { h = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64(pub))); }
  catch (e) { console.warn("at:fingerprint", e); return; }
  if (AtOn.ch !== channel || AtOn.code !== code || AtOn.fpFor !== pub) return;
  const FP_EMOJI = ["🍕","🐪","⚽","🚀","🌵","🎸","🦁","🍉","🎈","🐢","🌙","🔥","🍩","🦊","🎯","🐳","🌈","🍔","🦄","⭐","🍋","🐙","🎲","🌻",
    "🍿","🦉","🚗","🍎","🐝","🎁","🌊","🍪","🦒","⛄","🎻","🍇","🐧","🚲","🌴","🍓","🦋","🎮","🍦","🐬","⚡","🌍","🍄","🦜",
    "🎺","🍒","🐘","🛸","🌸","🍫","🦀","🎨","🍍","🐼","🚁","🌋","🍭","🦈","🎳","🥥"];
  AtOn.fp = [0,1,2,3].map(i => FP_EMOJI[h[i] % 64]).join(" ");
  atRenderOnline();
}

function atPinKey(code) { return AT_PIN_KEY_PRE + code; }

// ===== إنشاء الغرفة والانضمام =====
async function atCreateRoom() {
  try { await Sec.init(); } catch { atCodifiedError("متصفحك ما يدعم التشفير 😕", "استخدم متصفح حديث على رابط https."); return; }
  const code = String(100000 + secureInt(900000));
  AtOn.isHost = true;
  AtOn.room = {
    v: AT_ROOM_VERSION, code, hostId: myId, phase: "lobby",
    cats: atLoadCats(),
    players: [{ id: myId, name: atMyName() || "لاعب", score: 0, look: atMyLook(), pk: Sec.pubEcdh }],
    waiting: [], round: null, chat: [], seq: 1, locked: false,
    outsiderHistory: [],
    gk: Sec.newGroupRaw(), ctr: {}
  };
  atSysChat(`${atMyName() || "اللاعب"} سوّى الغرفة 🎉`);
  atSaveHost();
  atConnect(code);
}

async function atJoinRoom(code) {
  try { await Sec.init(); } catch { atCodifiedError("متصفحك ما يدعم التشفير 😕", "استخدم متصفح حديث على رابط https."); return; }
  let saved = null;
  try { saved = JSON.parse(LS.get(AT_HOST_PREFIX + code)); } catch {}
  if (saved && saved.hostId === myId) {
    saved.cats = atValidCats(saved.cats);
    saved.v = AT_ROOM_VERSION;
    if (typeof saved.gk !== "string" || saved.gk.length !== 44) saved.gk = Sec.newGroupRaw();
    if (!saved.ctr || typeof saved.ctr !== "object") saved.ctr = {};
    if (!Array.isArray(saved.outsiderHistory)) saved.outsiderHistory = [];
    const me = saved.players.concat(saved.waiting || []).find(x => x.id === myId);
    if (me) me.pk = Sec.pubEcdh;
    AtOn.isHost = true;
    AtOn.room = saved;
  } else {
    AtOn.isHost = false;
    AtOn.room = null;
  }
  atConnect(code);
}

function atConnect(code) {
  leaveAtChannel();
  if (!window.supabase) { atCodifiedError("ما قدرنا نحمّل مكتبة الاتصال.", "تأكد من الإنترنت وجرب مرة ثانية."); return; }
  On.sb = On.sb || window.supabase.createClient(SB_URL, SB_KEY);
  AtOn.sb = On.sb;
  AtOn.code = code;
  setActiveRoom("atarsh", code);
  AtOn.wasIn = false; AtOn.lastSig = null; AtOn.lastPhase = null; AtOn.lastJoinSent = 0;
  clearTimeout(AtOn.stateRetryTimer); AtOn.stateRetryTimer = null; AtOn.stateRetryCount = 0;
  AtOn.hq = Promise.resolve(); AtOn.cq = Promise.resolve(); AtOn.rate.clear(); AtOn.lastChat.clear();
  AtOn.online = new Set(); AtOn.sending = false; AtOn.dirty = false;
  AtOn.hostPk = null; AtOn.myRole = null; AtOn.myAnswer = null; AtOn.myVote = null;
  AtOn.envSeq = 0; AtOn.sawRoom = false; AtOn.locked = false;
  AtOn.fp = ""; AtOn.fpFor = "";
  if (AtOn.isHost) atSetFingerprint(Sec.pubDsa);
  AtOn.ui = freshAtUi();
  history.replaceState(null, "", "?atroom=" + code);

  const ch = AtOn.sb.channel("atarsh:" + code, {
    config: { broadcast: { self: false, ack: true }, presence: { key: myId } }
  });
  AtOn.ch = ch;

  ch.on("broadcast", { event: "state" }, ({ payload }) => {
    if (ch !== AtOn.ch || AtOn.isHost) return;
    AtOn.cq = AtOn.cq.then(() => ch === AtOn.ch ? atReceiveEnvelope(payload, ch) : undefined).catch(e => console.warn("at:state", e));
  });
  ch.on("broadcast", { event: "action" }, ({ payload }) => {
    if (ch !== AtOn.ch || !AtOn.isHost) return;
    AtOn.hq = AtOn.hq.then(() => ch === AtOn.ch ? atHostReceive(payload, ch) : undefined).catch(e => console.warn("at:action", e));
  });
  ch.on("broadcast", { event: "rtc" }, ({ payload }) => { if (ch === AtOn.ch) Voice.onSignal(payload); });
  ch.on("broadcast", { event: "closed" }, async ({ payload }) => {
    if (ch !== AtOn.ch || AtOn.isHost || !payload || typeof payload.s !== "string") return;
    const pin = SS.get(atPinKey(code));
    let msg = null;
    try { msg = JSON.parse(payload.s); } catch { return; }
    if (!pin || !msg || msg.code !== code || !(await Sec.verify(pin, payload.s, payload.sig)) || ch !== AtOn.ch) return;
    leaveAtChannel();
    atCodifiedError("صاحب الغرفة قفل الغرفة 🚪");
  });
  ch.on("presence", { event: "sync" }, () => {
    if (ch !== AtOn.ch) return;
    AtOn.online = new Set(Object.keys(ch.presenceState()));
    Voice.onPresence(ch.presenceState());
    if (AtOn.isHost) atCommit(); else atRenderOnline();
  });
  ch.subscribe(async status => {
    if (ch !== AtOn.ch) return;
    Voice.onChannelStatus(ch, status);
    if (status === "SUBSCRIBED") {
      await Voice._track();
      if (ch !== AtOn.ch) return;
      if (AtOn.isHost) atCommit(); else atSendJoin();
    }
  });

  if (AtOn.isHost) {
    atRenderOnline();
  } else {
    paint("at-connecting", `
      <div class="card status-big" style="margin-top:60px">
        <div class="big-emoji spin">🌀</div>
        <div class="title">جاري الدخول للغرفة</div>
        ${codeTiles(code)}
      </div>
      <button class="big ghost" id="atCancelBtn">إلغاء</button>`);
    document.getElementById("atCancelBtn").onclick = renderGame2Home;
    clearInterval(AtOn.joinRetry);
    AtOn.joinRetry = setInterval(() => {
      if (ch !== AtOn.ch || AtOn.room) { clearInterval(AtOn.joinRetry); return; }
      if (!AtOn.locked) atSendJoin();
    }, 2000);
    AtOn.joinTimer = setTimeout(() => {
      if (AtOn.room || ch !== AtOn.ch) return;
      leaveAtChannel();
      if (AtOn.sawRoom && AtOn.locked) atCodifiedError("الغرفة مقفلة 🔒", "صاحب الغرفة قفل الغرفة.");
      else if (AtOn.sawRoom) atCodifiedError("صاحب الغرفة ما قبل دخولك 😕", "جرب مرة ثانية.");
      else atCodifiedError(`ما لقينا الغرفة ${esc(code)} 😕`, "تأكد من الكود.");
    }, 30000);
  }
}

function leaveAtChannel() {
  if (AtOn.ch && AtOn.sb) {
    try { Promise.resolve(AtOn.sb.removeChannel(AtOn.ch)).catch(e => console.warn("at:remove channel", e)); }
    catch (e) { console.warn("at:remove channel", e); }
  }
  AtOn.ch = null;
  Voice.resetRoom();
  clearTimeout(AtOn.stateRetryTimer); AtOn.stateRetryTimer = null; AtOn.stateRetryCount = 0;
  clearTimeout(AtOn.joinTimer);
  clearInterval(AtOn.joinRetry);
  removeAtChat();
  AtOn.chatSeenT = null;
}

// ===== إرسال الحركات =====
function atSendAction(a) {
  if (AtOn.isHost) { atHostHandle({ ...a, from: myId }); return Promise.resolve(); }
  if (!AtOn.ch) return Promise.resolve();
  if (a.type === "hello") {
    return sendRealtimeBroadcast(AtOn.ch, "action", { type: "hello", from: myId })
      .catch(e => { console.warn("at:hello", e); return false; });
  }
  if (!AtOn.hostPk) return Promise.resolve();
  AtOn.sendC = nextActionCounter("atarsh", AtOn.sendC);
  const body = { ...a, c: AtOn.sendC };
  const ch = AtOn.ch;
  return Sec.pairKey(AtOn.hostPk).then(k => Sec.seal(k, body)).then(box => {
    if (ch === AtOn.ch) return sendRealtimeBroadcast(ch, "action", { from: myId, box });
  }).catch(e => { console.warn("at:send", e); });
}

async function atSendJoin() {
  const ch = AtOn.ch;
  if (!ch) return false;
  const now = Date.now();
  if (now - AtOn.lastJoinSent < 1200) return false;
  AtOn.lastJoinSent = now;

  try {
    if (!AtOn.hostPk) {
      await atSendAction({ type: "hello" });
      return true;
    }
    AtOn.sendC = nextActionCounter("atarsh", AtOn.sendC);
    const body = { type: "join", name: atMyName(), look: atMyLook(), c: AtOn.sendC };
    const key = await Sec.pairKey(AtOn.hostPk);
    const box = await Sec.seal(key, body);
    if (ch !== AtOn.ch) return false;
    await sendRealtimeBroadcast(ch, "action", { from: myId, pk: Sec.pubEcdh, box });
    return true;
  } catch (e) {
    console.warn("at:join", e);
    return false;
  }
}


document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && AtOn.ch && !AtOn.isHost) atSendAction({ type: "hello" });
});

// ===== مرحلة الإرسال: جهة الهوست =====

// الحالة العامة التي يراها الكل (بدون بيانات سرية في مراحل معينة)
function atPublicRoom(r) {
  const c = JSON.parse(JSON.stringify(r));
  delete c.gk; delete c.ctr;
  if (c.round) {
    const phase = c.phase;
    if (phase === "answers") {
      // مرحلة الإجابات: لا نكشف هوية الأطرش ولا الأسئلة ولا الإجابات
      delete c.round.deafPlayerId;
      delete c.round.majorityQ;
      delete c.round.deafQ;
      delete c.round.answers;
    } else if (phase === "discussion" || phase === "vote") {
      // مرحلة النقاش والتصويت: الإجابات ظاهرة لكن لا نكشف هوية الأطرش ولا الأسئلة
      delete c.round.deafPlayerId;
      delete c.round.majorityQ;
      delete c.round.deafQ;
      // الأصوات نخفيها حتى النتيجة (نعرض boolean فقط)
      c.round.votes = Object.fromEntries(Object.keys(c.round.votes || {}).map(k => [k, true]));
    } else if (phase === "result" || phase === "finish") {
      // نكشف كل شيء في مرحلة النتيجة والنهاية
    }
  }
  return c;
}

// السؤال السري لكل لاعب
function atRoleFor(r, id) {
  const rd = r.round;
  if (!rd) return null;
  return { q: id === rd.deafPlayerId ? rd.deafQ : rd.majorityQ };
}

// إرسال الحالة بشكل متسلسل
async function atBroadcastState(isRetry = false) {
  if (AtOn.sending) { AtOn.dirty = true; return; }
  if (!isRetry) AtOn.stateRetryCount = 0;
  AtOn.sending = true;
  try {
    do { AtOn.dirty = false; await atSendStateNow(); } while (AtOn.dirty);
    AtOn.stateRetryCount = 0;
    clearTimeout(AtOn.stateRetryTimer); AtOn.stateRetryTimer = null;
  } catch (e) {
    console.warn("at:broadcast", e);
    if (AtOn.ch && AtOn.isHost && AtOn.stateRetryCount < 3) {
      const delay = 1000 * (AtOn.stateRetryCount + 1);
      AtOn.stateRetryCount++;
      clearTimeout(AtOn.stateRetryTimer);
      AtOn.stateRetryTimer = setTimeout(() => { if (AtOn.ch && AtOn.isHost) atBroadcastState(true); }, delay);
    }
  } finally { AtOn.sending = false; }
}

async function atSendStateNow() {
  const r = AtOn.room, ch = AtOn.ch;
  if (!r || !ch || !AtOn.isHost) return;
  const keys = {};
  for (const p of r.players.concat(r.waiting)) {
    if (p.id === myId || !validPub(p.pk)) continue;
    try {
      const role = r.round ? atRoleFor(r, p.id) : null;
      keys[p.id] = await Sec.seal(await Sec.pairKey(p.pk), { g: r.gk, role });
    } catch { /* مفتاح خربان: نتجاوزه */ }
  }
  const env = {
    v: AT_ROOM_VERSION, code: r.code, hostId: r.hostId, seq: r.seq, locked: !!r.locked,
    ts: Date.now(), // إضافة timestamp لمنع replay attacks
    hpk: Sec.pubDsa, hek: Sec.pubEcdh, keys,
    enc: await Sec.seal(await Sec.groupKey(r.gk), atPublicRoom(r))
  };
  const s = JSON.stringify(env);
  const sig = await Sec.sign(s);
  if (ch === AtOn.ch && r === AtOn.room) await sendRealtimeBroadcast(ch, "state", { s, sig });
}

function atCommit() {
  const r = AtOn.room; if (!r) return;
  setActiveRoom("atarsh", r.code);
  r.seq++;
  atSaveHost();
  atBroadcastState();
  atRenderOnline();
}

// ===== مرحلة الاستقبال: جهة اللاعب =====

async function atReceiveEnvelope(payload, sourceChannel = AtOn.ch) {
  const channel = sourceChannel;
  const roomCode = AtOn.code;
  if (!channel || channel !== AtOn.ch || !payload || typeof payload.s !== "string" || payload.s.length > 500000 || typeof payload.sig !== "string") return;
  let env;
  try { env = JSON.parse(payload.s); } catch { return; }
  if (!env || typeof env !== "object" || env.code !== roomCode) return;
  if (env.v !== AT_ROOM_VERSION) {
    if (channel !== AtOn.ch) return;
    leaveAtChannel();
    atCodifiedError("نسخة اللعبة مختلفة 🔄", "كلكم سوّوا تحديث للصفحة وادخلوا مرة ثانية.");
    return;
  }
  if (!validPub(env.hpk) || !validPub(env.hek) || typeof env.hostId !== "string" || !env.hostId.length || env.hostId.length > 64 || !Number.isSafeInteger(env.seq) || env.seq < 0) return;
  if (!Number.isSafeInteger(env.ts)) return;

  const age = Date.now() - env.ts;
  if (age > 60000 || age < -10000) {
    console.warn("[AtOnline] Rejecting envelope: invalid timestamp", age);
    return;
  }

  const pin = SS.get(atPinKey(roomCode));
  if (pin && pin !== env.hpk) return;
  if (!(await Sec.verify(env.hpk, payload.s, payload.sig))) return;
  if (channel !== AtOn.ch || AtOn.code !== roomCode) return;
  if (!pin) SS.set(atPinKey(roomCode), env.hpk);
  atSetFingerprint(env.hpk);

  if (env.seq <= AtOn.envSeq) {
    console.warn("[AtOnline] Rejecting envelope: old sequence", env.seq, "<=", AtOn.envSeq);
    return;
  }

  const mine = env.keys && env.keys[myId];
  if (!mine) {
    AtOn.envSeq = env.seq;
    AtOn.hostPk = env.hek; AtOn.locked = !!env.locked; AtOn.sawRoom = true;
    if (AtOn.wasIn) { leaveAtChannel(); atCodifiedError("صاحب الغرفة طلّعك من الغرفة 👋"); return; }
    if (!env.locked && Date.now() - AtOn.lastJoinSent > 1500) atSendJoin();
    return;
  }

  let room, role;
  try {
    const k = await Sec.open(await Sec.pairKey(env.hek), mine);
    room = await Sec.open(await Sec.groupKey(k.g), env.enc);
    role = k.role && typeof k.role === "object" ? k.role : null;
  } catch { return; }
  if (channel !== AtOn.ch || AtOn.code !== roomCode) return;
  if (!room || room.hostId !== env.hostId || room.seq !== env.seq) return;

  AtOn.envSeq = env.seq;
  AtOn.hostPk = env.hek; AtOn.locked = !!env.locked; AtOn.sawRoom = true;
  AtOn.myRole = role && typeof role.q === "string" ? { q: role.q } : null;
  atReceiveState(room);
}

function atSanitizeRoom(r) {
  const okId = x => typeof x === "string" && x.length > 0 && x.length <= 64;
  const okInt = x => Number.isInteger(x) && x >= 0 && x < 1e6;
  if (typeof r.code !== "string" || !/^\d{6}$/.test(r.code) || !okId(r.hostId) || !okInt(r.seq) || !AT_PHASES.includes(r.phase)) return false;
  if (r.players.length > AT_MAX_PLAYERS || r.waiting.length > AT_MAX_PLAYERS || r.chat.length > 60) return false;
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
    if (!okInt(rd.n)) return false;
    if (rd.answered && typeof rd.answered !== "object") return false;
    if (rd.votes && typeof rd.votes !== "object") return false;
    if (rd.notes && !Array.isArray(rd.notes)) return false;
    rd.caught = rd.caught === true;
  }
  r.locked = r.locked === true;
  return true;
}

function atReceiveState(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.players) || !Array.isArray(r.waiting) || !Array.isArray(r.chat) || r.code !== AtOn.code) return;
  if (!Array.isArray(r.cats)) r.cats = [];
  if (!atSanitizeRoom(r)) return;
  if (AtOn.room && (r.hostId !== AtOn.room.hostId || r.seq < AtOn.room.seq)) return;
  clearTimeout(AtOn.joinTimer);
  clearInterval(AtOn.joinRetry);
  // احفظ رقم الراوند السابق قبل استبدال حالة الغرفة.
  const prevRound = AtOn.room && AtOn.room.round && AtOn.room.round.n;
  const newRound = r.round && r.round.n;
  AtOn.room = r;
  setActiveRoom("atarsh", r.code);
  // امسح الإجابة المحلية لو تغيّر رقم الراوند
  if (newRound && newRound !== prevRound) AtOn.myAnswer = null;
  const inRoom = r.players.some(p => p.id === myId) || r.waiting.some(p => p.id === myId);
  if (inRoom) AtOn.wasIn = true;
  else if (AtOn.wasIn) { leaveAtChannel(); atCodifiedError("صاحب الغرفة طلّعك من الغرفة 👋"); return; }
  else if (Date.now() - AtOn.lastJoinSent > 1500) atSendJoin();
  atRenderOnline();
}

// ===== جهة الهوست: استقبال الحركات =====

async function atHostReceive(p, sourceChannel = AtOn.ch) {
  const r = AtOn.room;
  const channel = sourceChannel;
  if (!r || !p || typeof p !== "object" || typeof p.from !== "string" || !p.from.length || p.from.length > 64 || p.from === myId) return;
  if (p.box) {
    let pk = atPkOf(p.from);
    const newcomer = !pk;
    if (newcomer) {
      // Limit join retries per sender; one impatient player must not block all newcomers.
      if (!validPub(p.pk) || !atRateOk("*newcomers*", 96) || !atRateOk(p.from, 6)) return;
      pk = p.pk;
    } else if (!atRateOk(p.from)) return;
    let a;
    try { a = await Sec.open(await Sec.pairKey(pk), p.box); } catch { return; }
    if (channel !== AtOn.ch || r !== AtOn.room) return;
    if (!a || typeof a !== "object" || !Number.isSafeInteger(a.c) || a.c < 0 || typeof a.type !== "string") return;
    if (newcomer && a.type !== "join") return;
    if (a.c <= (r.ctr[p.from] || 0)) return;
    r.ctr[p.from] = a.c;
    a.from = p.from;
    if (a.type === "join") a.pk = pk;
    atHostHandle(a);
  } else if (p.type === "hello") {
    if (!atRateOk(p.from) || !atRateOk("*open*")) return;
    atHostHandle({ type: "hello", from: p.from });
  }
}

function atHostHandle(a) {
  const r = AtOn.room;
  if (!r || !a || typeof a.from !== "string") return;
  const from = a.from;
  const p = r.players.find(x => x.id === from);
  const w = r.waiting.find(x => x.id === from);
  const rd = r.round;
  switch (a.type) {
    case "hello": break;
    case "look": {
      const who = p || w;
      if (!who || !decodeLook(a.look)) return;
      who.look = a.look;
      break;
    }
    case "join": {
      if (!validPub(a.pk)) return;
      const ex = p || w;
      if (ex) {
        if (ex.pk && ex.pk !== a.pk) return;
        ex.pk = a.pk;
        break;
      }
      if (r.locked) return;
      if (r.players.length + r.waiting.length >= AT_MAX_PLAYERS) return;
      const entry = {
        id: from,
        name: atUniqueName(cleanText(a.name, 20) || "لاعب", r),
        score: 0,
        look: decodeLook(a.look) ? a.look : "",
        pk: a.pk
      };
      if (r.phase === "lobby") r.players.push(entry); else r.waiting.push(entry);
      atSysChat(`${entry.name} دخل الغرفة 👋`);
      break;
    }
    case "leave": {
      const who = p || w;
      if (!who) return;
      if (w) r.waiting = r.waiting.filter(x => x.id !== from);
      else if (p && r.phase === "lobby") r.players = r.players.filter(x => x.id !== from);
      else return;
      atSysChat(`${who.name} طلع من الغرفة 🚶`);
      r.gk = Sec.newGroupRaw();
      break;
    }
    case "answer": {
      if (r.phase !== "answers") return;
      if (!rd) return;
      const text = cleanText(a.text, 100);
      if (!text) return;
      if (!p) return;
      rd.answers = rd.answers || {};
      rd.answered = rd.answered || {};
      // منع تغيير الإجابة بعد إرسالها
      if (rd.answered[from]) return;
      rd.answers[from] = text;
      rd.answered[from] = true;
      // هل كل اللاعبين أجابوا؟
      if (r.players.every(x => rd.answered[x.id])) {
        atToDiscussion();
        return;
      }
      break;
    }
    case "vote": {
      if (r.phase !== "vote") return;
      if (!rd || !p || a.target === from) return;
      if (!r.players.some(x => x.id === a.target)) return;
      rd.votes = rd.votes || {};
      if (rd.votes[from]) return;   // صوت مسبق: نرفض التغيير
      rd.votes[from] = a.target;
      if (r.players.every(x => rd.votes[x.id])) {
        atTally();
        return;
      }
      break;
    }
    case "toVote": {
      if (r.phase !== "discussion" || from !== r.hostId) return;
      r.phase = "vote";
      break;
    }
    case "chat": {
      const text = cleanText(a.text, 200);
      const who = p || w;
      if (!text || !who) return;
      if (from !== myId && Date.now() - (AtOn.lastChat.get(from) || 0) < 500) return;
      AtOn.lastChat.delete(from);
      AtOn.lastChat.set(from, Date.now());
      if (AtOn.lastChat.size > 256) AtOn.lastChat.delete(AtOn.lastChat.keys().next().value);
      r.chat.push({ id: from, name: who.name, text, t: Date.now() });
      if (r.chat.length > 40) r.chat.splice(0, r.chat.length - 40);
      break;
    }
    default: return;
  }
  atCommit();
}

// ===== منطق اللعبة: جهة الهوست =====

function atHostStart() {
  const r = AtOn.room;
  r.players.push(...r.waiting); r.waiting = [];
  if (r.players.length < 3) { toast("لازم 3 لاعبين على الأقل"); atCommit(); return; }
  const cat = atPickCat(r.cats);
  const pairs = ATARSH_CATS[cat].pairs;
  const pairIdx = rand(pairs.length);
  const [majorityQ, deafQ] = pairs[pairIdx];
  const deafIdx = pickOutsider(r.players, r.outsiderHistory);
  const maxHistory = Math.min(5, r.players.length - 1);
  updateOutsiderHistory(r.outsiderHistory, r.players[deafIdx].id, maxHistory);
  r.round = {
    n: ((r.round && r.round.n) || 0) + 1,
    cat, majorityQ, deafQ,
    deafPlayerId: r.players[deafIdx].id,
    answers: {}, answered: {}, votes: {}, caught: false, notes: []
  };
  r.phase = "answers";
  atCommit();
}

function atToDiscussion() {
  AtOn.room.phase = "discussion";
  atCommit();
}

function atTally() {
  const r = AtOn.room, rd = r.round;
  const counts = {};
  Object.values(rd.votes).forEach(t => counts[t] = (counts[t] || 0) + 1);
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter(k => counts[k] === max);
  rd.caught = max > 0 && top.length === 1 && top[0] === rd.deafPlayerId;
  rd.counts = counts;
  r.phase = "result";
  atCommit();
}

function atFinishRound() {
  const r = AtOn.room, rd = r.round;
  const notes = [];
  if (rd.caught) {
    r.players.forEach(p => {
      if (p.id !== rd.deafPlayerId && rd.votes[p.id] === rd.deafPlayerId) {
        p.score = (Number(p.score) || 0) + 1;
        notes.push(`✅ ${p.name} +1 (صوّت صح)`);
      }
    });
  } else {
    const out = r.players.find(p => p.id === rd.deafPlayerId);
    if (out) {
      out.score = (Number(out.score) || 0) + 2;
      notes.push(`😎 ${out.name} +2 (ما انكشف)`);
    }
  }
  rd.notes = notes;
  r.phase = "finish";
  atCommit();
}

// ===== كائن AtHost للتحكم من الواجهة =====
const AtHost = {
  start() { atHostStart(); },
  kick(id) {
    const r = AtOn.room;
    const p = r.players.concat(r.waiting).find(x => x.id === id);
    if (!p || id === myId) return;
    r.players = r.players.filter(x => x.id !== id);
    r.waiting = r.waiting.filter(x => x.id !== id);
    atSysChat(`${p.name} طلع من الغرفة 🚶`);
    r.gk = Sec.newGroupRaw();
    atCommit();
  },
  toggleLock() {
    const r = AtOn.room;
    r.locked = !r.locked;
    atSysChat(r.locked ? "صاحب الغرفة قفل الغرفة 🔒 ما يقدر يدخل أحد جديد" : "صاحب الغرفة فتح الغرفة 🔓");
    atCommit();
  },
  toggleCat(c) {
    const r = AtOn.room;
    r.cats = atToggleCat(r.cats, c);
    atSaveCats(r.cats);
    atCommit();
  },
  lobby() {
    const r = AtOn.room;
    r.players.push(...r.waiting); r.waiting = [];
    r.phase = "lobby";
    atCommit();
  },
  resetScores() { AtOn.room.players.forEach(p => p.score = 0); atCommit(); },
  skipAnswers() { if (AtOn.room.phase === "answers") atToDiscussion(); },
  skipVotes() { if (AtOn.room.phase === "vote") atTally(); },
  toVote() { if (AtOn.room.phase === "discussion") { AtOn.room.phase = "vote"; atCommit(); } },
  finish() { if (AtOn.room.phase === "result") atFinishRound(); },
  async close() {
    const code = AtOn.room.code, ch = AtOn.ch;
    try {
      const s = JSON.stringify({ code, closed: true, t: Date.now() });
      if (ch) await sendRealtimeBroadcast(ch, "closed", { s, sig: await Sec.sign(s) });
    } catch {}
    LS.del(AT_HOST_PREFIX + code);
    leaveAtChannel();
    renderGame2Home();
  }
};

// ===== الواجهة: مساعدات =====

function atEnsureLayout() {
  if (!document.getElementById("at-screen")) {
    app.innerHTML = `<div id="at-screen"></div>`;
    app.dataset.key = "atarsh-online";
  }
  atEnsureChat();
}

function atEnsureChat() {
  if (document.getElementById("atChatFab")) return;
  const fab = document.createElement("button");
  fab.id = "atChatFab"; fab.className = "chat-fab"; fab.dataset.quiet = "1";
  fab.setAttribute("aria-label", "الدردشة");
  fab.innerHTML = `💬<span class="unread" id="atChatUnread"></span>`;
  const sheet = document.createElement("div");
  sheet.id = "atChatSheet"; sheet.className = "chat-sheet";
  sheet.innerHTML = `
    <div class="chat-head"><span>💬 الدردشة</span><button class="icon-btn" id="atChatClose" data-quiet="1" aria-label="إغلاق">✕</button></div>
    <div class="chat-list" id="atChatList"></div>
    <div class="row">
      <input id="atChatInput" placeholder="اكتب رسالتك..." maxlength="200" autocomplete="off">
      <button id="atChatSend" data-quiet="1">إرسال</button>
    </div>`;
  document.body.append(fab, sheet);
  document.body.classList.add("has-chat");
  Voice.ensureUi();
  fab.onclick = () => atToggleChat(true);
  document.getElementById("atChatClose").onclick = () => atToggleChat(false);
  const input = document.getElementById("atChatInput");
  const send = () => {
    const text = cleanText(input.value, 200);
    if (!text) return;
    input.value = "";
    SFX.message();
    atSendAction({ type: "chat", text });
  };
  document.getElementById("atChatSend").onclick = send;
  input.onkeydown = e => { if (e.key === "Enter") send(); };
}

function removeAtChat() {
  ["atChatFab", "atChatSheet"].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
  Voice.removeUi();
  document.body.classList.remove("has-chat");
  AtOn.chatOpen = false;
}

function atToggleChat(open) {
  const fab = document.getElementById("atChatFab"), sheet = document.getElementById("atChatSheet");
  if (!fab) return;
  AtOn.chatOpen = open;
  sheet.classList.toggle("open", open);
  fab.classList.toggle("hidden", open);
  if (open) {
    atMarkChatSeen();
    const list = document.getElementById("atChatList");
    list.scrollTop = list.scrollHeight;
    setTimeout(() => document.getElementById("atChatInput").focus(), 300);
    SFX.pop();
  } else SFX.hide();
}

function atMarkChatSeen() {
  const r = AtOn.room;
  AtOn.chatSeenT = r && r.chat.length ? r.chat[r.chat.length - 1].t : Date.now();
  atUpdateUnread();
}

function atUpdateUnread() {
  const badge = document.getElementById("atChatUnread");
  if (!badge || !AtOn.room) return;
  const n = AtOn.chatOpen ? 0 : AtOn.room.chat.filter(m => m.t > (AtOn.chatSeenT || 0) && m.id !== myId && m.id !== "sys").length;
  badge.textContent = n > 9 ? "9+" : n;
  badge.classList.toggle("show", n > 0);
}

function atRenderChat() {
  const r = AtOn.room, list = document.getElementById("atChatList");
  if (!list) return;
  if (AtOn.chatSeenT == null) AtOn.chatSeenT = r.chat.length ? r.chat[r.chat.length - 1].t : 0;
  const sig = r.chat.length ? r.chat[r.chat.length - 1].t + ":" + r.chat.length : "0";
  if (list.dataset.sig === sig) return;
  const last = r.chat[r.chat.length - 1];
  if (list.dataset.sig && last) {
    if (last.id === "sys") { if (last.text.includes("دخل")) SFX.join(); }
    else if (last.id !== myId) {
      SFX.message();
      if (!AtOn.chatOpen) { const fab = document.getElementById("atChatFab"); if (fab) { fab.classList.remove("bump"); void fab.offsetWidth; fab.classList.add("bump"); } }
    }
  }
  if (AtOn.chatOpen) atMarkChatSeen(); else atUpdateUnread();
  list.dataset.sig = sig;
  list.innerHTML = r.chat.length
    ? r.chat.map(m => m.id === "sys"
        ? `<div class="msg sys">${esc(m.text)}</div>`
        : `<div class="msg ${m.id === myId ? "mine" : ""}">${avatar(m.id, "sm")}<div class="bubble"><b>${esc(m.name)}</b>${esc(m.text)}</div></div>`).join("")
    : `<div class="msg sys">ما فيه رسائل للحين</div>`;
  list.scrollTop = list.scrollHeight;
}

function atPlayerOf(id) {
  return AtOn.room.players.concat(AtOn.room.waiting).find(x => x.id === id) || { id, name: "؟" };
}
function atNameOf(id) { return atPlayerOf(id).name; }

function atLeaveBtnHtml() {
  return `<button class="big ghost" id="atLeaveBtn">${AtOn.isHost ? "🔒 اقفل الغرفة" : "🚪 اطلع من الغرفة"}</button>`;
}
function atBindLeave() {
  const b = document.getElementById("atLeaveBtn");
  if (!b) return;
  b.onclick = () => {
    if (AtOn.isHost) {
      if (confirm("أكيد تبي تقفل الغرفة؟ بتطلع الكل.")) AtHost.close();
    } else if (confirm("أكيد تبي تطلع من الغرفة؟")) {
      (async () => {
        try { await atSendAction({ type: "leave" }); }
        finally { leaveAtChannel(); renderGame2Home(); }
      })();
    }
  };
}

function atPendingHtml(doneMap, label) {
  const r = AtOn.room;
  const done = r.players.filter(p => doneMap && doneMap[p.id]).length;
  return `
    <div class="card center">
      <div class="card-title" style="justify-content:center">${label} ${done}/${r.players.length}</div>
      <div class="waitlist">
        ${r.players.map(p => `<div class="wait-item ${doneMap && doneMap[p.id] ? "done" : ""}">${avatar(p.id, "md")}<span>${esc(p.name)}</span></div>`).join("")}
      </div>
    </div>`;
}

// ===== الرسم الرئيسي =====

function atRenderOnline() {
  const r = AtOn.room;
  if (!r) return;
  setAvLooks(r.players.concat(r.waiting));
  atEnsureLayout();
  atRenderChat();

  const sig = JSON.stringify([r.phase, [...AtOn.online].sort(), [...Voice.members], AtOn.myRole, AtOn.myVote, AtOn.myAnswer, AtOn.fp, AtOn.ui, r.players, r.waiting, r.cats, r.locked, r.round]);
  if (sig === AtOn.lastSig) return;
  AtOn.lastSig = sig;

  const screen = document.getElementById("at-screen");
  const rd = r.round;
  const phaseKey = r.phase + ":" + (rd ? rd.n : 0);
  if (phaseKey !== AtOn.lastPhase) {
    if (AtOn.lastPhase !== null) {
      if (r.phase === "answers") SFX.start();
      else if (r.phase === "vote") SFX.vote();
      else if (r.phase === "result") SFX.drumroll();
      else SFX.pop();
    }
    AtOn.lastPhase = phaseKey;
    Music.setMood(r.phase === "answers" || r.phase === "vote" ? "tense" : "calm");
  }

  setFloaters(["🥁", "🎺", "🎵", "🎶", "👂", "🔇"]);

  // لاعب في الانتظار خارج الجولة الحالية
  const me = r.players.find(p => p.id === myId);
  if (!me && r.phase !== "lobby") {
    paintEl(screen, "at-waiting", `
      <div class="card status-big" style="margin-top:30px">
        <div class="big-emoji float">⏳</div>
        <div class="title">الجولة شغالة</div>
        <p class="hint">بتدخل معهم الجولة الجاية</p>
      </div>
      ${atLeaveBtnHtml()}`);
    atBindLeave();
    return;
  }

  switch (r.phase) {
    case "lobby":      return atRenderLobby(screen);
    case "answers":    return atRenderAnswers(screen);
    case "discussion": return atRenderDiscussion(screen);
    case "vote":       return atRenderVote(screen);
    case "result":     return atRenderResult(screen);
    case "finish":     return atRenderFinish(screen);
  }
}

// ===== شاشة اللوبي =====
function atRenderLobby(screen) {
  const r = AtOn.room, H = AtOn.isHost;
  const canShare = !!navigator.share;
  paintEl(screen, "at-lobby", `
    <div class="card center">
      <div class="muted">كود الغرفة</div>
      ${codeTiles(r.code)}
      <div class="share-row">
        <button class="ghost" id="atCopyBtn">📋 انسخ الرابط</button>
        ${canShare ? `<button class="ghost" id="atShareBtn">📤 شارك</button>` : ""}
      </div>
    </div>
    <div class="card">
      <div class="card-title">👥 اللاعبين <span class="badge">${r.players.length}/${AT_MAX_PLAYERS}</span></div>
      <ul class="players">
        ${r.players.map(p => `
          <li>
            <span class="status-dot ${AtOn.online.has(p.id) ? "on" : ""}"></span>
            ${p.id === myId ? avatarBtn(p.id, 'data-atav-me="1"') : avatar(p.id)}
            <span class="pname">${esc(p.name)}</span>
            ${voiceTag(p.id)}
            ${p.id === r.hostId ? `<span class="tag">👑 صاحب الغرفة</span>` : ""}
            ${p.id === myId ? `<span class="tag">أنت</span>` : ""}
            ${p.score ? `<span class="pscore">${Number(p.score) || 0} ⭐</span>` : ""}
            ${H && p.id !== myId ? `<button class="x-btn" data-atkick="${esc(p.id)}" data-quiet="1" aria-label="طلّع">✕</button>` : ""}
          </li>`).join("")}
        ${r.waiting.map(p => `
          <li style="opacity:.6">
            <span class="status-dot ${AtOn.online.has(p.id) ? "on" : ""}"></span>
            ${avatar(p.id)}
            <span class="pname">${esc(p.name)}</span>
            <span class="tag muted">انتظار</span>
            ${H ? `<button class="x-btn" data-atkick="${esc(p.id)}" data-quiet="1" aria-label="طلّع">✕</button>` : ""}
          </li>`).join("")}
      </ul>
      ${r.players.length < 3 ? `<p class="hint">لازم 3 لاعبين على الأقل، ارسل الرابط للشباب 👆</p>` : ""}
      ${H ? `<button class="big ghost" id="atLockBtn">${r.locked ? "🔒 الغرفة مقفلة (اضغط عشان تفتحها)" : "🔓 الغرفة مفتوحة (اضغط عشان تقفلها)"}</button>`
          : r.locked ? `<p class="hint">🔒 صاحب الغرفة قفل الغرفة</p>` : ""}
      <div class="fp-box">
        <div>🔐 بصمة الغرفة</div>
        <div class="fp">${AtOn.fp || "..."}</div>
        <div class="hint" style="margin:4px 0 0">لازم تكون نفسها عند كل اللاعبين.</div>
      </div>
      <p class="hint">اضغط على شخصيتك عشان تختار شكلها ✏️</p>
    </div>
    <div class="card">
      <div class="card-title">📂 التصنيفات</div>
      ${atChipsHtml(r.cats, !H)}
    </div>
    ${H
      ? `<button class="big" id="atStartBtn" ${r.players.length < 3 ? "disabled" : ""} style="background:linear-gradient(135deg,var(--gold),var(--orange))">ابدأ الجولة 🎲</button>
         ${r.players.some(p => p.score) ? `<button class="big ghost" id="atResetBtn">تصفير النقاط 🔄</button>` : ""}`
      : `<div class="card center"><span class="spin">⏳</span> استنى صاحب الغرفة يبدأ</div>`}
    ${atLeaveBtnHtml()}`);

  document.getElementById("atCopyBtn").onclick = () => copyText(atShareLink(r.code), "تم نسخ الرابط ✅");
  const lb = document.getElementById("atLockBtn");
  if (lb) lb.onclick = () => { SFX.pop(); AtHost.toggleLock(); };
  const mine = screen.querySelector("[data-atav-me]");
  if (mine) mine.onclick = () => {
    SFX.pop();
    const close = () => { AtOn.lastSig = null; atRenderOnline(); };
    openLookEditor(atMyName(), lookFor(myId), look => {
      LS.set(AT_LOOK_KEY, look);
      atSendAction({ type: "look", look });
      close();
    }, close);
  };
  const sh = document.getElementById("atShareBtn");
  if (sh) sh.onclick = () => navigator.share({ title: "مين الأطرش بالزفة؟", text: `تعال العب معنا! كود الغرفة ${r.code}`, url: atShareLink(r.code) }).catch(() => {});
  
  if (H) {
    // معالج واحد قابل للاستبدال حتى لا تتكرر الاستجابة مع كل إعادة رسم
    screen.onclick = e => {
      const chip = e.target.closest('.chip[data-atcat]');
      if (!chip) return;
      e.preventDefault();
      e.stopPropagation();
      SFX.select();
      AtHost.toggleCat(chip.dataset.atcat);
    };
    
    screen.querySelectorAll("[data-atkick]").forEach(b => b.onclick = () => { if (confirm("تطلّع هذا اللاعب؟")) { SFX.remove(); AtHost.kick(b.dataset.atkick); } });
    const sb = document.getElementById("atStartBtn");
    if (sb) sb.onclick = AtHost.start;
    const rb = document.getElementById("atResetBtn");
    if (rb) rb.onclick = () => { if (confirm("أكيد تبي تصفر النقاط؟")) AtHost.resetScores(); };
  } else {
    screen.onclick = null;
  }
  atBindLeave();
}

// ===== شاشة الإجابات =====
function atRenderAnswers(screen) {
  const r = AtOn.room, rd = r.round, H = AtOn.isHost;
  const me = r.players.find(p => p.id === myId);
  const answered = rd.answered && rd.answered[myId];
  // سؤالي: من myRole إذا لاعب، من round مباشرة إذا هوست
  const myQ = H
    ? (myId === rd.deafPlayerId ? rd.deafQ : rd.majorityQ)
    : (AtOn.myRole && AtOn.myRole.q ? AtOn.myRole.q : null);

  if (!answered) {
    // لو المستخدم شغال يكتب إجابته، ما نعيد رسم الشاشة
    if (document.getElementById("atAnswerInput")) return;
    paintEl(screen, "at-answers-" + rd.n, `
      <div class="card center"><div class="muted">🥁 الجولة ${rd.n} — ${esc(rd.cat)}</div></div>
      ${myQ
        ? `<div class="atarsh-q-card">
             <div class="atarsh-q-label">سؤالك الخاص 🔒</div>
             <div class="atarsh-q-text">${esc(myQ)}</div>
           </div>`
        : `<div class="card center"><span class="spin">⏳</span><p class="hint">جاري استلام سؤالك...</p></div>`}
      ${myQ ? `
        <textarea id="atAnswerInput" class="answer-input" placeholder="اكتب إجابتك هنا..." maxlength="100" rows="3" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
        <button class="big" id="atSubmitAnswer" data-quiet="1" style="background:linear-gradient(135deg,var(--gold),var(--orange))">تمام، أرسل إجابتك ✔️</button>
        <p class="hint">إجابتك ستُعرض للكل بعد ما يكمل الجميع</p>
      ` : ""}
      ${H ? `<button class="big ghost" id="atSkipAnswers" style="margin-top:8px">كمّل بدون الباقين ⏭️</button>` : ""}
    `);
    if (myQ) {
      const input = document.getElementById("atAnswerInput");
      document.getElementById("atSubmitAnswer").onclick = () => {
        const text = cleanText(input.value, 100);
        if (!text) { shakeEl(input); SFX.wrong(); toast("اكتب إجابتك أول 📝"); return; }
        AtOn.myAnswer = text;
        SFX.hide();
        atSendAction({ type: "answer", text });
        AtOn.lastSig = null; atRenderOnline();
      };
    }
    const sk = document.getElementById("atSkipAnswers");
    if (sk) sk.onclick = AtHost.skipAnswers;
  } else {
    paintEl(screen, "at-answers-done-" + rd.n, `
      <div class="card center"><div class="muted">🥁 الجولة ${rd.n}</div></div>
      <div class="card center"><div class="big-emoji">✅</div><div class="title">أرسلت إجابتك</div></div>
      ${atPendingHtml(rd.answered, "أجابوا")}
      ${H ? `<button class="big ghost" id="atSkipAnswers2">كمّل بدون الباقين ⏭️</button>` : ""}
    `);
    const sk2 = document.getElementById("atSkipAnswers2");
    if (sk2) sk2.onclick = AtHost.skipAnswers;
  }
}

// ===== شاشة النقاش =====
function atRenderDiscussion(screen) {
  const r = AtOn.room, rd = r.round, H = AtOn.isHost;
  paintEl(screen, "at-discussion-" + rd.n, `
    <div class="title">🗣️ شوفوا الإجابات</div>
    <div class="card">
      <div class="card-title">📝 إجابات اللاعبين</div>
      <p class="hint" style="margin-bottom:8px">ناقشوا مع بعض، مين الإجابة تبدو مختلفة؟ 🤔</p>
      <div class="discussion-list">
        ${r.players.map(p => `
          <div class="discussion-row">
            ${avatar(p.id, "sm")}
            <div class="discussion-answer">
              <span class="pname">${esc(p.name)}</span>
              <div class="ans-text">${esc(rd.answers && rd.answers[p.id] ? rd.answers[p.id] : "—")}</div>
            </div>
          </div>`).join("")}
      </div>
    </div>
    ${H
      ? `<button class="big" id="atToVoteBtn" style="background:linear-gradient(135deg,var(--violet),var(--pink))">يلا نصوّت 🗳️</button>`
      : `<div class="card center"><span class="spin">⏳</span> صاحب الغرفة يقرر متى نصوّت</div>`}
    ${atLeaveBtnHtml()}`);
  const vb = document.getElementById("atToVoteBtn");
  if (vb) vb.onclick = () => { SFX.vote(); AtHost.toVote(); };
  atBindLeave();
}

// ===== شاشة التصويت =====
function atRenderVote(screen) {
  const r = AtOn.room, rd = r.round, H = AtOn.isHost;
  const ssVoteKey = "atarsh_vote_" + AtOn.code + "_" + rd.n;
  // استعادة الصوت من sessionStorage عند إعادة الاتصال
  if (!AtOn.myVote && SS.get(ssVoteKey)) AtOn.myVote = { n: rd.n, target: SS.get(ssVoteKey) };
  const voted = rd.votes && rd.votes[myId]
    ? (H ? rd.votes[myId] : (AtOn.myVote && AtOn.myVote.n === rd.n ? AtOn.myVote.target : null))
    : null;

  if (voted) {
    paintEl(screen, "at-vote-done-" + rd.n, `
      <div class="title">صوّتت على ${esc(atNameOf(voted))} ✅</div>
      ${atPendingHtml(rd.votes, "صوّتوا")}
      ${H ? `<button class="big ghost" id="atSkipVotes">اعرض النتيجة بدون الباقين ⏭️</button>` : ""}
      ${atLeaveBtnHtml()}`);
    const sk = document.getElementById("atSkipVotes");
    if (sk) sk.onclick = AtHost.skipVotes;
    atBindLeave();
  } else {
    paintEl(screen, "at-vote-" + rd.n, `
      <div class="title">مين الأطرش بالزفة؟ 🎺</div>
      <p class="hint" style="margin:-6px 0 14px">صوتك سري 🤐</p>
      <div class="grid stagger">
        ${r.players.filter(p => p.id !== myId).map((p, i) => `
          <button class="pick" data-atv="${esc(p.id)}" data-quiet="1" style="--i:${i}">
            ${avatar(p.id)}<span>${esc(p.name)}</span>
          </button>`).join("")}
      </div>
      ${atLeaveBtnHtml()}`);
    screen.querySelectorAll("[data-atv]").forEach(b => b.onclick = () => {
      SFX.vote();
      screen.querySelectorAll("[data-atv]").forEach(x => x.disabled = true);
      AtOn.myVote = { n: rd.n, target: b.dataset.atv };
      SS.set(ssVoteKey, b.dataset.atv);
      atSendAction({ type: "vote", target: b.dataset.atv });
    });
    atBindLeave();
  }
}

// ===== شاشة النتيجة =====
function atRenderResult(screen) {
  const r = AtOn.room, rd = r.round, H = AtOn.isHost;
  if (AtOn.ui.resultShown !== rd.n) {
    if (AtOn.ui.suspenseFor !== rd.n) {
      AtOn.ui.suspenseFor = rd.n;
      paintEl(screen, "at-suspense-" + rd.n, suspenseHtml());
      SFX.drumroll();
      Music.duck(3.5);
      const n = rd.n;
      setTimeout(() => {
        if (AtOn.room && AtOn.room.round && AtOn.room.round.n === n) {
          AtOn.ui.resultShown = n;
          if (rd.caught) { SFX.caught(); confetti(); vibrate([80, 40, 80, 40, 200]); }
          else { SFX.escaped(); confetti(50, ["😎", "💨", "🏃‍♂️"]); }
          atRenderOnline();
        }
      }, 2300);
    }
    return;
  }
  const out = atPlayerOf(rd.deafPlayerId);
  paintEl(screen, "at-result-" + rd.n, `
    ${outsiderBoxHtml(rd.caught, out)}
    <div class="card">
      <div class="card-title">📊 الأصوات</div>
      ${voteBarsHtml(r.players, rd.counts || {}, rd.deafPlayerId, p => p.id)}
    </div>
    <div class="card q-compare">
      <div class="q-compare-row">
        <div class="q-compare-label">سؤال الأغلبية 👥</div>
        <div class="q-compare-text">${esc(rd.majorityQ || "")}</div>
      </div>
      <div class="q-compare-row">
        <div class="q-compare-label">سؤال الأطرش 🔇 — ${esc(out.name)}</div>
        <div class="q-compare-text">${esc(rd.deafQ || "")}</div>
      </div>
    </div>
    <div class="deaf-answer-box">
      <div class="q-compare-label">إجابة الأطرش (${esc(out.name)})</div>
      <div class="q-compare-text" style="margin-top:4px">${esc(rd.answers && rd.answers[rd.deafPlayerId] ? rd.answers[rd.deafPlayerId] : "—")}</div>
    </div>
    ${H ? `<button class="big" id="atFinishBtn" style="background:linear-gradient(135deg,var(--gold),var(--orange))">شوف النقاط 🏆</button>` : `<div class="card center"><span class="spin">⏳</span> استنى صاحب الغرفة</div>`}
    ${atLeaveBtnHtml()}`);
  const fb = document.getElementById("atFinishBtn");
  if (fb) fb.onclick = () => { SFX.win(); AtHost.finish(); };
  atBindLeave();
}

// ===== شاشة النهاية =====
function atRenderFinish(screen) {
  const r = AtOn.room, rd = r.round, H = AtOn.isHost;
  const firstTime = AtOn.ui.finishShown !== rd.n;
  AtOn.ui.finishShown = rd.n;
  paintEl(screen, "at-finish-" + rd.n, `
    <div class="card">
      <div class="card-title">🏆 الترتيب</div>
      ${rankingHtml(r.players)}
    </div>
    <div class="card">
      <div class="card-title">✨ نقاط الجولة</div>
      ${notesHtml(rd.notes || [])}
    </div>
    ${H
      ? `<button class="big" id="atAgainBtn" style="background:linear-gradient(135deg,var(--gold),var(--orange))">جولة جديدة 🎲</button>
         <button class="big ghost" id="atLobbyBtn">رجوع للغرفة 🏠</button>`
      : `<div class="card center"><span class="spin">⏳</span> استنى صاحب الغرفة</div>`}
    ${atLeaveBtnHtml()}`);
  if (firstTime) {
    SFX.win();
    playCoins(rd.notes ? rd.notes.length : 0);
    setTimeout(() => burstFrom(screen.querySelector(".p1 .av"), 50, ["👑", "⭐"]), 900);
  }
  if (H) {
    document.getElementById("atAgainBtn").onclick = AtHost.start;
    document.getElementById("atLobbyBtn").onclick = AtHost.lobby;
  }
  atBindLeave();
}

// ===== نقطة الدخول الرئيسية =====
function renderAtarshOnlineHome() {
  Music.setMood("calm");
  history.replaceState(null, "", location.pathname);
  setFloaters(["🥁", "🎺", "🎵", "🎶", "👂", "🔇"]);
  paint("atarsh-online-home", `
    <div class="hero">
      <div class="logo-badge" style="background: linear-gradient(145deg, var(--gold), var(--orange))">
        <span class="logo-emoji">🥁</span>
      </div>
      <h1 class="logo">مين الأطرش<br><span>بالزفة؟</span></h1>
      <p class="tagline">كل لاعب على جواله 🌐</p>
    </div>
    <div class="card">
      <div class="card-title">👤 اسمك</div>
      <input id="atOnlineName" placeholder="اكتب اسمك" maxlength="20" autocomplete="off" value="${esc(atMyName())}">
    </div>
    <div class="card">
      <div class="card-title">🌐 العب أونلاين</div>
      <button class="big" id="atCreateBtn" data-quiet="1" style="margin-top:0; background:linear-gradient(135deg,var(--gold),var(--orange))">سوّي غرفة جديدة ➕</button>
      <div class="divider">أو ادخل غرفة بالكود</div>
      <div class="row">
        <input id="atCodeInput" class="code-input" placeholder="000000" maxlength="6" inputmode="numeric" autocomplete="off">
        <button id="atJoinBtn" data-quiet="1">ادخل</button>
      </div>
    </div>
    <button class="big ghost" id="atBackBtn">رجوع ↩️</button>
  `);
  const nameEl = document.getElementById("atOnlineName");
  const codeEl = document.getElementById("atCodeInput");
  const needName = () => {
    const n = cleanText(nameEl.value, 20);
    if (!n) { shakeEl(nameEl); SFX.wrong(); nameEl.focus(); toast("اكتب اسمك أول ✍️"); return null; }
    LS.set(AT_NAME_KEY, n);
    return n;
  };
  document.getElementById("atCreateBtn").onclick = () => { if (needName()) { SFX.start(); atCreateRoom(); } };
  const join = () => {
    const code = codeEl.value.replace(/\D/g, "");
    if (code.length !== AT_CODE_LEN) { shakeEl(codeEl); SFX.wrong(); return; }
    if (needName()) { SFX.select(); atJoinRoom(code); }
  };
  document.getElementById("atJoinBtn").onclick = join;
  codeEl.oninput = () => { codeEl.value = codeEl.value.replace(/\D/g, "").slice(0, AT_CODE_LEN); };
  codeEl.onkeydown = e => { if (e.key === "Enter") join(); };
  document.getElementById("atBackBtn").onclick = renderGame2Home;
  nameEl.focus();
}

function renderAtarshNameForRoom(code) {
  setFloaters(["🥁", "🎺", "🎵", "🎶", "👂", "🔇"]);
  paint("at-name-" + code, `
    <div class="hero">
      <div class="logo-badge" style="background: linear-gradient(145deg, var(--gold), var(--orange))">
        <span class="logo-emoji">🥁</span>
      </div>
      <h1 class="logo">مين الأطرش<br><span>بالزفة؟</span></h1>
    </div>
    <div class="card center">
      <div class="muted">عزموك على الغرفة 🎉</div>
      ${codeTiles(code)}
    </div>
    <div class="card">
      <div class="card-title">👤 اسمك</div>
      <input id="atRoomName" placeholder="اكتب اسمك" maxlength="20" autocomplete="off">
    </div>
    <button class="big" id="atGoBtn" data-quiet="1" style="background:linear-gradient(135deg,var(--gold),var(--orange))">ادخل الغرفة 🚪</button>
    <button class="big ghost" id="atRoomBackBtn">الرئيسية 🏠</button>`);
  const el = document.getElementById("atRoomName");
  const go = () => {
    const n = cleanText(el.value, 20);
    if (!n) { shakeEl(el); SFX.wrong(); return; }
    LS.set(AT_NAME_KEY, n); SFX.select(); atJoinRoom(code);
  };
  document.getElementById("atGoBtn").onclick = go;
  el.onkeydown = e => { if (e.key === "Enter") go(); };
  document.getElementById("atRoomBackBtn").onclick = renderHome;
  el.focus();
}

// ===== مُهيئ تلقائي: رابط مباشر ?atroom=NNNNNN =====
(function atInit() {
  let code = (new URLSearchParams(location.search).get("atroom") || "").replace(/\D/g, "").slice(0, AT_CODE_LEN);
  if (!code) {
    const active = getActiveRoom();
    if (active && active.game === "atarsh") {
      code = active.code;
      history.replaceState(null, "", location.pathname + "?atroom=" + code);
    }
  }
  const k = new URLSearchParams(location.hash.slice(1)).get("k") || "";
  if (code.length === AT_CODE_LEN && validPub(k) && !SS.get(atPinKey(code))) SS.set(atPinKey(code), k);
  if (code.length === AT_CODE_LEN) {
    if (atMyName()) atJoinRoom(code); else renderAtarshNameForRoom(code);
  }
})();
