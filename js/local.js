/* ============================================================
   اللعب على جوال واحد
   ============================================================ */
const STORE_KEY = "bara_salfa_players";
const CATS_KEY = "bara_cats";

let state = {
  players: loadPlayers(),
  cats: loadCats(),
  roundCat: null, word: null, emoji: null, outsider: -1, roundNo: 0,
  turn: 0, shown: false, votes: [], caught: false, guessOptions: [],
  pairs: [], qi: 0, qset: 0, lastNew: -1,
  outsiderHistory: []
};

function loadPlayers() {
  try {
    const saved = JSON.parse(LS.get(STORE_KEY));
    if (!Array.isArray(saved)) return [];
    return saved.filter(p => p && typeof p === "object" && typeof p.name === "string" && p.name.trim())
      .map(p => ({ ...p, name: cleanText(p.name, 20), score: Number.isFinite(Number(p.score)) && Number(p.score) >= 0 ? Math.floor(Number(p.score)) : 0 }));
  } catch { return []; }
}
function savePlayers() { LS.set(STORE_KEY, JSON.stringify(state.players)); }
function loadCats() { try { return validCats(JSON.parse(LS.get(CATS_KEY))); } catch { return []; } }
function saveCats(list) { LS.set(CATS_KEY, JSON.stringify(list)); }
function catPill(cat) { return `<div class="pill">${CATEGORIES[cat].icon} ${esc(cat)}</div>`; }

/* ---------- الإعداد ---------- */
function renderSetup(spun = -1) {
  Music.setMood("calm");
  setFloaters(HOME_FLOATERS);
  const p = state.players;
  setAvLooks(p);
  const hasScores = p.some(x => x.score > 0);
  paint("setup", `
    <div class="topbar">
      <button class="icon-btn" id="homeBack" aria-label="رجوع">➜</button>
      <div class="title">📱 جوال واحد</div>
    </div>
    <div class="card">
      <div class="card-title">👥 اللاعبين <span class="badge">${p.length}</span></div>
      <div class="row">
        <input id="nameInput" placeholder="اكتب اسم اللاعب" maxlength="20" autocomplete="off">
        <button id="addBtn" data-quiet="1">إضافة</button>
      </div>
      <ul class="players">
        ${p.map((x, i) => `
          <li class="${i === state.lastNew ? "new" : ""}">
            ${avatarBtn(x.name, `data-av="${i}"`)}<span class="pname">${esc(x.name)}</span>
            ${x.score ? `<span class="pscore">${Number(x.score) || 0} ⭐</span>` : ""}
            <button class="x-btn" data-del="${i}" data-quiet="1" aria-label="حذف">✕</button>
          </li>`).join("")}
      </ul>
      ${p.length < 3 ? `<p class="hint">لازم 3 لاعبين على الأقل</p>` : p.length ? `<p class="hint">اضغط على الشخصية عشان تختار شكلها ✏️</p>` : ""}
    </div>
    <div class="card">
      <div class="card-title">📂 التصنيفات <span class="badge">اختار واحد أو أكثر</span></div>
      ${chipsHtml(state.cats)}
    </div>
    <button class="big" id="startBtn" data-quiet="1" ${p.length < 3 ? "disabled" : ""}>ابدأ الجولة 🎲</button>
    ${hasScores ? `<button class="big ghost" id="resetBtn">تصفير النقاط 🔄</button>` : ""}
  `);
  state.lastNew = -1;
  const input = document.getElementById("nameInput");
  const add = () => {
    const name = cleanText(input.value, 20);
    if (!name) { shakeEl(input); SFX.wrong(); return; }
    if (p.some(x => x.name === name)) { shakeEl(input); SFX.wrong(); toast("الاسم موجود"); return; }
    p.push({ name, score: 0 }); savePlayers(); SFX.add();
    state.lastNew = p.length - 1;
    renderSetup();
    document.getElementById("nameInput").focus();
  };
  document.getElementById("addBtn").onclick = add;
  input.onkeydown = e => { if (e.key === "Enter") add(); };
  app.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { SFX.remove(); p.splice(+b.dataset.del, 1); savePlayers(); renderSetup(); });
  app.querySelectorAll("[data-av]").forEach(b => b.onclick = () => {
    const i = +b.dataset.av, pl = p[i];
    SFX.pop();
    openLookEditor(pl.name, lookFor(pl.name),
      look => { pl.look = look; delete pl.av; savePlayers(); renderSetup(i); },
      () => renderSetup());
  });
  if (spun >= 0) { const b = app.querySelector(`[data-av="${spun}"]`); if (b) b.classList.add("spin-once"); }
  app.querySelectorAll("[data-cat]").forEach(b => b.onclick = () => { SFX.select(); state.cats = toggleCat(state.cats, b.dataset.cat); saveCats(state.cats); renderSetup(); });
  document.getElementById("startBtn").onclick = startRound;
  document.getElementById("homeBack").onclick = renderGame1Home;
  const r = document.getElementById("resetBtn");
  if (r) r.onclick = () => { if (confirm("أكيد تبي تصفر النقاط؟")) { p.forEach(x => x.score = 0); savePlayers(); renderSetup(); } };
}

/* ---------- بداية الجولة ---------- */
function startRound() {
  setAvLooks(state.players);
  SFX.start();
  Music.setMood("calm");
  state.roundCat = pickCat(state.cats);
  state.roundNo++;
  const words = CATEGORIES[state.roundCat].words;
  [state.word, state.emoji] = words[rand(words.length)];
  preloadPoster(state.roundCat, state.word);
  state.outsider = pickOutsider(state.players, state.outsiderHistory);
  const maxHistory = Math.min(5, state.players.length - 1);
  updateOutsiderHistory(state.outsiderHistory, state.players[state.outsider].name, maxHistory);
  state.turn = 0; state.shown = false; state.votes = [];
  setFloaters([CATEGORIES[state.roundCat].icon, "❓", "🤔", "🕵️"]);
  renderReveal();
}

/* ---------- كشف الأدوار ---------- */
function renderReveal() {
  const pl = state.players[state.turn];
  const isOut = state.turn === state.outsider;
  if (!state.shown) {
    paint("pass-" + state.turn, `
      ${catPill(state.roundCat)}
      <div class="card pass">
        <div class="muted">عطِ الجوال لـ</div>
        ${avatar(pl.name, "xl")}
        <div class="pass-name">${esc(pl.name)}</div>
        <div class="hint">لا تخلي أحد يشوف الشاشة 👀</div>
      </div>
      <button class="big" id="showBtn" data-quiet="1">اقلب الكرت 🃏</button>
      <p class="hint">${state.turn + 1} من ${state.players.length}</p>`);
    document.getElementById("showBtn").onclick = () => {
      state.shown = true;
      renderReveal();          // نرسم الكرت أول، وبعدين الصوت
      SFX.cardReveal();        // نفس الصوت للكل
    };
  } else {
    paint("role-" + state.turn, `
      <div class="title">${esc(pl.name)}</div>
      ${roleCardHtml(isOut, state.word, state.emoji, posterFor(state.roundCat, state.word))}
      <button class="big" id="nextBtn" data-quiet="1">تمام، خبّيها ✔️</button>`);
    document.getElementById("nextBtn").onclick = () => {
      SFX.hide();
      state.shown = false; state.turn++;
      if (state.turn >= state.players.length) renderQuestions(); else renderReveal();
    };
  }
}

/* ---------- الأسئلة: سؤال واحد كل مرة ---------- */
// كل لاعب يسأل مرة وينسأل مرة، بترتيب عشوائي
function makePairs(keys) {
  const order = shuffle(keys);
  return order.map((a, k) => [a, order[(k + 1) % order.length]]);
}

function renderQuestions(newSet = true) {
  Music.setMood("tense");
  if (newSet) { state.pairs = makePairs(state.players.map(p => p.name)); state.qi = 0; state.qset++; }
  if (state.qi >= state.pairs.length) {
    paint("qdone-" + state.qset, `
      ${qDoneHtml()}
      <button class="big ghost" id="reshuffle">أسئلة جولة ثانية 🔄</button>
      <button class="big" id="voteBtn">يلا نصوّت 🗳️</button>`);
    SFX.pop();
    document.getElementById("reshuffle").onclick = () => { SFX.whoosh(); renderQuestions(true); };
    document.getElementById("voteBtn").onclick = () => { SFX.vote(); state.turn = 0; state.shown = false; renderVote(); };
    return;
  }
  const [a, b] = state.pairs[state.qi];
  paint("q-" + state.qset + "-" + state.qi, `
    ${questionHtml({ cat: state.roundCat, round: state.roundNo, i: state.qi, total: state.pairs.length, a: { key: a, name: a }, b: { key: b, name: b } })}
    <button class="big" id="nextQ" data-quiet="1">خلصنا ✔️</button>
    <button class="big ghost" id="skipQ">يلا نصوّت على طول 🗳️</button>`);
  SFX.whoosh();
  setTimeout(SFX.pop, 450);
  document.getElementById("nextQ").onclick = () => { SFX.select(); state.qi++; renderQuestions(false); };
  document.getElementById("skipQ").onclick = () => { SFX.vote(); state.turn = 0; state.shown = false; renderVote(); };
}

/* ---------- التصويت ---------- */
function renderVote() {
  const voter = state.players[state.turn];
  if (!state.shown) {
    paint("votepass-" + state.turn, `
      <div class="title">🗳️ التصويت</div>
      <div class="card pass">
        <div class="muted">دور</div>
        ${avatar(voter.name, "xl")}
        <div class="pass-name">${esc(voter.name)}</div>
        <div class="hint">صوّت بسرية 🤐</div>
      </div>
      <button class="big" id="readyBtn">جاهز</button>`);
    document.getElementById("readyBtn").onclick = () => { state.shown = true; renderVote(); };
    return;
  }
  paint("vote-" + state.turn, `
    <div class="title">${esc(voter.name)}، مين برا السالفة؟ 🕵️</div>
    <div class="grid stagger">
      ${state.players.map((x, i) => i === state.turn ? "" : `<button class="pick" data-v="${i}" data-quiet="1" style="--i:${i}">${avatar(x.name)}<span>${esc(x.name)}</span></button>`).join("")}
    </div>`);
  app.querySelectorAll("[data-v]").forEach(b => b.onclick = () => {
    SFX.vote();
    state.votes[state.turn] = +b.dataset.v;
    state.turn++; state.shown = false;
    if (state.turn >= state.players.length) renderSuspense(); else renderVote();
  });
}

function renderSuspense() {
  paint("suspense", suspenseHtml());
  SFX.drumroll();
  Music.duck(3.5);
  setTimeout(renderVoteResult, 2300);
}

function renderVoteResult() {
  Music.setMood("calm");
  const counts = state.players.map(() => 0);
  state.votes.forEach(v => counts[v]++);
  const max = Math.max(...counts);
  const top = counts.map((c, i) => c === max ? i : -1).filter(i => i >= 0);
  const caught = top.length === 1 && top[0] === state.outsider;
  state.caught = caught;
  const out = state.players[state.outsider];
  paint("result", `
    ${outsiderBoxHtml(caught, out)}
    <div class="card">
      <div class="card-title">📊 الأصوات</div>
      ${voteBarsHtml(state.players, counts, state.outsider, (_, i) => i)}
    </div>
    <button class="big" id="guessBtn">خلّ ${esc(out.name)} يخمّن السالفة 🤔</button>`);
  if (caught) { SFX.caught(); confetti(); vibrate([80, 40, 80, 40, 200]); }
  else { SFX.escaped(); confetti(50, ["😎", "💨", "🏃‍♂️"]); }
  document.getElementById("guessBtn").onclick = renderGuess;
}

/* ---------- تخمين برا السالفة ---------- */
function renderGuess() {
  state.guessOptions = makeGuessOptions(state.roundCat, state.word, state.emoji);
  paint("guess", `
    <div class="title">${esc(state.players[state.outsider].name)}، وش السالفة؟ 🤔</div>
    ${catPill(state.roundCat)}
    ${optionsHtml(state.guessOptions)}`);
  const buttons = app.querySelectorAll("[data-g]");
  buttons.forEach(b => b.onclick = () => {
    buttons.forEach(x => x.disabled = true);
    const guess = state.guessOptions[+b.dataset.g][0];
    const right = guess === state.word;
    buttons.forEach(x => { if (state.guessOptions[+x.dataset.g][0] === state.word) x.classList.add("right"); });
    if (right) { SFX.correct(); burstFrom(b, 70, [state.emoji, "✨"]); }
    else { b.classList.add("wrong", "shake"); SFX.wrong(); vibrate(300); }
    setTimeout(() => finishRound(guess), 1600);
  });
}

/* ---------- النقاط ونهاية الجولة ---------- */
function finishRound(guess) {
  const guessedRight = guess === state.word;
  const notes = [];
  state.players.forEach((p, i) => {
    if (i !== state.outsider && state.votes[i] === state.outsider) { p.score += 1; notes.push(`✅ ${p.name} +1 (صوّت صح)`); }
  });
  const out = state.players[state.outsider];
  if (!state.caught) { out.score += 2; notes.push(`😎 ${out.name} +2 (ما انكشف)`); }
  if (guessedRight) { out.score += 2; notes.push(`🧠 ${out.name} +2 (عرف السالفة)`); }
  savePlayers();

  paint("finish", `
    <div class="title ${guessedRight ? "pop" : "shake"}">${guessedRight ? "عرفها! 🔥" : "ما عرفها ❌"}</div>
    ${wordRevealHtml(state.word, state.emoji, posterFor(state.roundCat, state.word))}
    <div class="card">
      <div class="card-title">🏆 الترتيب</div>
      ${rankingHtml(state.players)}
    </div>
    <div class="card">
      <div class="card-title">✨ نقاط الجولة</div>
      ${notesHtml(notes)}
    </div>
    <button class="big" id="againBtn" data-quiet="1">جولة جديدة 🎲</button>
    <button class="big ghost" id="homeBtn">الإعدادات ⚙️</button>`);
  SFX.win();
  playCoins(notes.length);
  setTimeout(() => burstFrom(document.querySelector(".p1 .av"), 50, ["👑", "⭐"]), 900);
  document.getElementById("againBtn").onclick = startRound;
  document.getElementById("homeBtn").onclick = renderSetup;
}
