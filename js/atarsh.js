/* ============================================================
   لعبة "مين الأطرش بالزفة؟" - جوال واحد
   ============================================================ */

const AT_STORE_KEY = "atarsh_players";
const AT_CATS_KEY  = "atarsh_cats";

let atState = {
  players: atLoadPlayers(),
  cats: atLoadCats(),
  roundCat: null, majorityQ: null, deafQ: null, deafIdx: -1, roundNo: 0,
  turn: 0, shown: false, answers: [], votes: [], caught: false,
  outsiderHistory: [], lastNew: -1
};

// Global event listener للفئات - يشتغل مع أي شاشة فيها chips
document.addEventListener('click', function(e) {
  const chip = e.target.closest('.chip[data-atcat]');
  if (!chip) return;
  // التأكد إننا في شاشة الإعداد
  if (app.dataset.key !== "atarsh-setup") return;
  e.preventDefault();
  e.stopPropagation();
  SFX.select();
  atState.cats = atToggleCat(atState.cats, chip.dataset.atcat);
  atSaveCats(atState.cats);
  renderAtarshSetup();
});

/* ---------- مساعدات البيانات ---------- */
function atLoadPlayers() {
  try {
    const saved = JSON.parse(LS.get(AT_STORE_KEY));
    if (!Array.isArray(saved)) return [];
    return saved.filter(p => p && typeof p === "object" && typeof p.name === "string" && p.name.trim())
      .map(p => ({ ...p, name: cleanText(p.name, 20), score: Number.isFinite(Number(p.score)) && Number(p.score) >= 0 ? Math.floor(Number(p.score)) : 0 }));
  } catch { return []; }
}
function atSavePlayers() {
  LS.set(AT_STORE_KEY, JSON.stringify(atState.players));
}
function atLoadCats() {
  try { return atValidCats(JSON.parse(LS.get(AT_CATS_KEY))); } catch { return []; }
}
function atSaveCats(list) {
  LS.set(AT_CATS_KEY, JSON.stringify(list));
}
function atValidCats(list) {
  return Array.isArray(list) ? list.filter(c => ATARSH_CATS[c]) : [];
}
function atPickCat(list) {
  const pool = atValidCats(list).length ? atValidCats(list) : Object.keys(ATARSH_CATS);
  return pool[rand(pool.length)];
}
function atToggleCat(list, c) {
  if (c === ATARSH_RANDOM || !ATARSH_CATS[c]) return [];
  const next = list.includes(c) ? list.filter(x => x !== c) : list.concat(c);
  return next.length === Object.keys(ATARSH_CATS).length ? [] : next;
}
function atCatsLabel(list) {
  return list.length
    ? list.length + " تصنيفات، واللعبة تختار منها كل جولة"
    : "اللعبة تختار تصنيف عشوائي كل جولة";
}
function atChipsHtml(selected, readOnly) {
  const all = [ATARSH_RANDOM, ...Object.keys(ATARSH_CATS)];
  const isOn = c => c === ATARSH_RANDOM ? selected.length === 0 : selected.includes(c);
  const shown = readOnly ? all.filter(isOn) : all;
  const chipsHtml = shown.map(c => {
    if (readOnly) {
      return `<span class="chip active">${ATARSH_CATS[c] ? ATARSH_CATS[c].icon : "🎲"} ${esc(c)}</span>`;
    }
    const icon = ATARSH_CATS[c] ? ATARSH_CATS[c].icon : "🎲";
    const checkmark = isOn(c) && c !== ATARSH_RANDOM ? "✓ " : "";
    const activeClass = isOn(c) ? " active" : "";
    return `<button type="button" class="chip${activeClass}" data-atcat="${esc(c)}" data-quiet="1">${checkmark}${icon} ${esc(c)}</button>`;
  }).join("");
  return `<div class="chips">${chipsHtml}</div><p class="hint" style="text-align:right">${selected.length === 1 ? "تصنيف واحد" : atCatsLabel(selected)}</p>`;
}

/* ============================================================
   الشاشة الرئيسية للعبة 2
   ============================================================ */
function renderGame2Home() {
  if (typeof clearActiveRoom === "function") clearActiveRoom();
  if (typeof leaveAtChannel !== "undefined") leaveAtChannel();
  if (typeof leaveChannel !== "undefined") leaveChannel();
  Music.setMood("calm");
  history.replaceState(null, "", location.pathname);
  setFloaters(["🥁", "🎺", "🎵", "🎶", "👂", "🔇"]);
  paint("atarsh-home", `
    <div class="logo-badge" style="background: linear-gradient(145deg, var(--gold), var(--orange))">
      <div class="big-emoji wiggle">🥁</div>
    </div>
    <h1 class="logo">مين الأطرش<br><span>بالزفة؟</span></h1>
    <p class="tagline">لعبة الأسئلة المزدوجة 🎺</p>
    <button class="big" id="at-startBtn">العب على جوال واحد 📱</button>
    <button class="big" id="at-onlineBtn" data-quiet="1" style="background: linear-gradient(135deg, var(--gold), var(--orange))">العب أونلاين 🌐</button>
    <button class="big ghost" id="at-homeBtn">الرئيسية 🏠</button>
    <details class="card how">
      <summary style="cursor:pointer; font-weight:700; font-size:1.05rem; padding:4px 0">كيف تلعب؟ 📖</summary>
      <div style="margin-top:10px; line-height:1.8; text-align:right; color:var(--muted); font-size:.97rem">
        <p>🎯 <b>الفكرة:</b> كل لاعب يقرأ سؤاله سراً ويكتب إجابته، لكن لاعب واحد "الأطرش" يحصل على سؤال مختلف!</p>
        <p>📱 <b>الجولة:</b> يتداول الجوال بين اللاعبين، كل واحد يقرأ سؤاله ويكتب إجابته بسرية.</p>
        <p>🗣️ <b>النقاش:</b> تُعرض كل الإجابات مع الأسماء (بدون الأسئلة)، كلكم تناقشون وتحاولون تكشفون الأطرش.</p>
        <p>🗳️ <b>التصويت:</b> كل لاعب يصوّت على من يعتقد أنه "الأطرش بالزفة".</p>
        <p>🏆 <b>النقاط:</b><br>
        — المجموعة تكشفه ← كل صوت صحيح = نقطة<br>
        — ينجو دون أن يُكشف ← الأطرش يحصل على نقطتين</p>
      </div>
    </details>
  `);
  document.getElementById("at-startBtn").onclick = renderAtarshSetup;
  document.getElementById("at-onlineBtn").onclick = function () {
    if (typeof renderAtarshOnlineHome !== "undefined") { SFX.select(); renderAtarshOnlineHome(); }
    else { toast("جاري التحميل..."); }
  };
  document.getElementById("at-homeBtn").onclick = function () {
    if (typeof leaveAtChannel !== "undefined") leaveAtChannel();
    if (typeof leaveChannel !== "undefined") leaveChannel();
    renderHome();
  };
}

/* ============================================================
   شاشة الإعداد
   ============================================================ */
function renderAtarshSetup(spun) {
  Music.setMood("calm");
  setFloaters(["🥁", "🎺", "🎵", "🎶", "👂", "🔇"]);
  const p = atState.players;
  setAvLooks(p);
  const hasScores = p.some(x => x.score > 0);
  paint("atarsh-setup", `
    <div class="topbar">
      <button class="icon-btn" id="at-back" aria-label="رجوع">➜</button>
      <div class="title">🥁 الأطرش بالزفة</div>
    </div>
    <div class="card">
      <div class="card-title">👥 اللاعبين <span class="badge">${p.length}</span></div>
      <div class="row">
        <input id="at-nameInput" placeholder="اكتب اسم اللاعب" maxlength="20" autocomplete="off">
        <button id="at-addBtn" data-quiet="1">إضافة</button>
      </div>
      <ul class="players">
        ${p.map((x, i) => `
          <li class="${i === atState.lastNew ? "new" : ""}">
            ${avatarBtn(x.name, `data-atav="${i}"`)}<span class="pname">${esc(x.name)}</span>
            ${x.score ? `<span class="pscore">${Number(x.score) || 0} ⭐</span>` : ""}
            <button class="x-btn" data-atdel="${i}" data-quiet="1" aria-label="حذف">✕</button>
          </li>`).join("")}
      </ul>
      ${p.length < 3 ? `<p class="hint">لازم 3 لاعبين على الأقل</p>` : p.length ? `<p class="hint">اضغط على الشخصية عشان تختار شكلها ✏️</p>` : ""}
    </div>
    <div class="card">
      <div class="card-title">📂 التصنيفات <span class="badge">اختار واحد أو أكثر</span></div>
      ${atChipsHtml(atState.cats)}
    </div>
    <button class="big" id="at-startRound" data-quiet="1" ${p.length < 3 ? "disabled" : ""}>ابدأ الجولة 🎲</button>
    ${hasScores ? `<button class="big ghost" id="at-resetBtn">تصفير النقاط 🔄</button>` : ""}
  `);
  atState.lastNew = -1;
  const input = document.getElementById("at-nameInput");
  const add = () => {
    const name = cleanText(input.value, 20);
    if (!name) { shakeEl(input); SFX.wrong(); return; }
    if (p.some(x => x.name === name)) { shakeEl(input); SFX.wrong(); toast("الاسم موجود"); return; }
    p.push({ name, score: 0 }); atSavePlayers(); SFX.add();
    atState.lastNew = p.length - 1;
    renderAtarshSetup();
    document.getElementById("at-nameInput").focus();
  };
  document.getElementById("at-addBtn").onclick = add;
  input.onkeydown = e => { if (e.key === "Enter") add(); };
  app.querySelectorAll("[data-atdel]").forEach(b => b.onclick = () => {
    SFX.remove(); p.splice(+b.dataset.atdel, 1); atSavePlayers(); renderAtarshSetup();
  });
  app.querySelectorAll("[data-atav]").forEach(b => b.onclick = () => {
    const i = +b.dataset.atav, pl = p[i];
    SFX.pop();
    openLookEditor(pl.name, lookFor(pl.name),
      look => { pl.look = look; delete pl.av; atSavePlayers(); renderAtarshSetup(i); },
      () => renderAtarshSetup());
  });
  if (spun >= 0) { const b = app.querySelector(`[data-atav="${spun}"]`); if (b) b.classList.add("spin-once"); }
  
  document.getElementById("at-startRound").onclick = startAtarshRound;
  document.getElementById("at-back").onclick = renderGame2Home;
  const r = document.getElementById("at-resetBtn");
  if (r) r.onclick = () => {
    if (confirm("أكيد تبي تصفر النقاط؟")) { p.forEach(x => x.score = 0); atSavePlayers(); renderAtarshSetup(); }
  };
}

/* ============================================================
   بداية الجولة
   ============================================================ */
function startAtarshRound() {
  setAvLooks(atState.players);
  SFX.start();
  atState.roundCat = atPickCat(atState.cats);
  const pairs = ATARSH_CATS[atState.roundCat].pairs;
  const pairIdx = rand(pairs.length);
  const [mq, dq] = pairs[pairIdx];
  atState.majorityQ = mq;
  atState.deafQ = dq;
  atState.deafIdx = pickOutsider(atState.players, atState.outsiderHistory);
  updateOutsiderHistory(atState.outsiderHistory, atState.players[atState.deafIdx].name, Math.min(5, atState.players.length - 1));
  atState.roundNo++;
  atState.turn = 0;
  atState.shown = false;
  atState.answers = new Array(atState.players.length).fill("");
  atState.votes = [];
  atState.caught = false;
  setFloaters(["🥁", "🎺", "🎵", "🎶", "👂", "🔇"]);
  renderAtarshReveal();
}

/* ============================================================
   مرحلة التمرير والكشف (كل لاعب يقرأ سؤاله ويكتب إجابته)
   ============================================================ */
function renderAtarshReveal() {
  const pl = atState.players[atState.turn];
  if (!atState.shown) {
    // شاشة التمرير
    paint("atarsh-pass-" + atState.turn, `
      <div class="card pass">
        <div class="muted">عطِ الجوال لـ</div>
        ${avatar(pl.name, "xl")}
        <div class="pass-name">${esc(pl.name)}</div>
        <div class="hint">لا تخلي أحد يشوف الشاشة 👀</div>
      </div>
      <button class="big" id="at-showBtn" data-quiet="1">اقرأ سؤالك 🔒</button>
      <p class="hint">${atState.turn + 1} من ${atState.players.length}</p>
    `);
    document.getElementById("at-showBtn").onclick = () => {
      atState.shown = true;
      renderAtarshReveal();
      SFX.cardReveal();
    };
  } else {
    // شاشة السؤال والإجابة
    Music.setMood("tense");
    const q = atState.turn === atState.deafIdx ? atState.deafQ : atState.majorityQ;
    paint("atarsh-q-" + atState.turn, `
      <div class="title">${esc(pl.name)}</div>
      <div class="atarsh-q-card">
        <div class="atarsh-q-label">سؤالك الخاص 🔒</div>
        <div class="atarsh-q-text">${esc(q)}</div>
      </div>
      <textarea id="answerInput" class="answer-input" placeholder="اكتب إجابتك هنا..." maxlength="100" rows="3" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
      <button class="big" id="at-saveBtn" data-quiet="1">تمام، خبّيها ✔️</button>
      <p class="hint">إجابتك ستُعرض للكل بعد ما يكمل الجميع</p>
    `);
    // استعادة الإجابة إذا كانت موجودة
    const input = document.getElementById("answerInput");
    if (atState.answers[atState.turn]) input.value = atState.answers[atState.turn];
    document.getElementById("at-saveBtn").onclick = () => {
      const ans = cleanText(input.value, 100);
      if (!ans) { shakeEl(input); SFX.wrong(); toast("اكتب إجابتك أول 📝"); return; }
      SFX.hide();
      atState.answers[atState.turn] = ans;
      atState.shown = false;
      atState.turn++;
      if (atState.turn >= atState.players.length) {
        renderAtarshDiscussion();
      } else {
        renderAtarshReveal();
      }
    };
  }
}

/* ============================================================
   مرحلة النقاش (عرض كل الإجابات بدون الأسئلة)
   ============================================================ */
function renderAtarshDiscussion() {
  Music.setMood("calm");
  setFloaters(["🥁", "🎺", "🎵", "🎶", "👂", "🔇"]);
  paint("atarsh-discussion", `
    <div class="title">🗣️ شوفوا الإجابات</div>
    <div class="card">
      <div class="card-title">📝 إجابات اللاعبين</div>
      <p class="hint" style="margin-bottom:8px">ناقشوا مع بعض، مين الإجابة تبدو مختلفة؟ 🤔</p>
      <div class="discussion-list">
        ${atState.players.map((pl, i) => `
          <div class="discussion-row">
            ${avatar(pl.name, "sm")}
            <div class="discussion-answer">
              <span class="pname">${esc(pl.name)}</span>
              <div class="ans-text">${esc(atState.answers[i] || "—")}</div>
            </div>
          </div>`).join("")}
      </div>
    </div>
    <button class="big" id="at-voteBtn">يلا نصوّت 🗳️</button>
  `);
  document.getElementById("at-voteBtn").onclick = () => {
    SFX.vote();
    atState.turn = 0;
    atState.shown = false;
    renderAtarshVote();
  };
}

/* ============================================================
   مرحلة التصويت
   ============================================================ */
function renderAtarshVote() {
  const voter = atState.players[atState.turn];
  if (!atState.shown) {
    paint("atarsh-votepass-" + atState.turn, `
      <div class="title">🗳️ التصويت</div>
      <div class="card pass">
        <div class="muted">دور</div>
        ${avatar(voter.name, "xl")}
        <div class="pass-name">${esc(voter.name)}</div>
        <div class="hint">صوّت بسرية 🤐</div>
      </div>
      <button class="big" id="at-readyBtn">جاهز</button>
    `);
    document.getElementById("at-readyBtn").onclick = () => {
      atState.shown = true;
      renderAtarshVote();
    };
    return;
  }
  paint("atarsh-vote-" + atState.turn, `
    <div class="title">${esc(voter.name)}، مين الأطرش بالزفة؟ 🎺</div>
    <div class="grid stagger">
      ${atState.players.map((x, i) => i === atState.turn ? "" : `
        <button class="pick" data-atv="${i}" data-quiet="1" style="--i:${i}">
          ${avatar(x.name)}<span>${esc(x.name)}</span>
        </button>`).join("")}
    </div>
  `);
  app.querySelectorAll("[data-atv]").forEach(b => b.onclick = () => {
    SFX.vote();
    atState.votes[atState.turn] = +b.dataset.atv;
    atState.turn++;
    atState.shown = false;
    if (atState.turn >= atState.players.length) {
      renderAtarshSuspense();
    } else {
      renderAtarshVote();
    }
  });
}

/* ============================================================
   مرحلة التشويق
   ============================================================ */
function renderAtarshSuspense() {
  paint("atarsh-suspense", suspenseHtml());
  SFX.drumroll();
  Music.duck(3.5);
  setTimeout(renderAtarshVoteResult, 2300);
}

/* ============================================================
   نتيجة التصويت وكشف الأطرش
   ============================================================ */
function renderAtarshVoteResult() {
  Music.setMood("calm");
  const counts = atState.players.map(() => 0);
  atState.votes.forEach(v => { if (v !== undefined && v >= 0) counts[v]++; });
  const max = Math.max(...counts);
  const uniqueTop = counts.map((c, i) => c === max ? i : -1).filter(i => i >= 0);
  atState.caught = max > 0 && uniqueTop.length === 1 && uniqueTop[0] === atState.deafIdx;
  const out = atState.players[atState.deafIdx];
  paint("atarsh-result", `
    ${outsiderBoxHtml(atState.caught, out)}
    <div class="card">
      <div class="card-title">📊 الأصوات</div>
      ${voteBarsHtml(atState.players, counts, atState.deafIdx, (_, i) => i)}
    </div>
    <div class="card q-compare">
      <div class="q-compare-row">
        <div class="q-compare-label">سؤال الأغلبية 👥</div>
        <div class="q-compare-text">${esc(atState.majorityQ)}</div>
      </div>
      <div class="q-compare-row">
        <div class="q-compare-label">سؤال الأطرش 🔇 — ${esc(out.name)}</div>
        <div class="q-compare-text">${esc(atState.deafQ)}</div>
      </div>
    </div>
    <div class="deaf-answer-box">
      <div class="q-compare-label">إجابة الأطرش (${esc(out.name)})</div>
      <div class="q-compare-text" style="margin-top:4px">${esc(atState.answers[atState.deafIdx] || "—")}</div>
    </div>
    <button class="big" id="at-finishBtn">شوف النقاط 🏆</button>
  `);
  if (atState.caught) {
    SFX.caught(); confetti(); vibrate([80, 40, 80, 40, 200]);
  } else {
    SFX.escaped(); confetti(50, ["😎", "💨", "🏃‍♂️"]);
  }
  document.getElementById("at-finishBtn").onclick = finishAtarshRound;
}

/* ============================================================
   النقاط ونهاية الجولة
   ============================================================ */
function finishAtarshRound() {
  const notes = [];
  if (atState.caught) {
    atState.players.forEach((pl, i) => {
      if (i !== atState.deafIdx && atState.votes[i] === atState.deafIdx) {
        pl.score = (Number(pl.score) || 0) + 1;
        notes.push("✅ " + pl.name + " +1 (صوّت صح)");
      }
    });
  } else {
    const out = atState.players[atState.deafIdx];
    out.score = (Number(out.score) || 0) + 2;
    notes.push("😎 " + out.name + " +2 (ما انكشف)");
  }
  atSavePlayers();
  paint("atarsh-finish", `
    <div class="card">
      <div class="card-title">🏆 الترتيب</div>
      ${rankingHtml(atState.players)}
    </div>
    <div class="card">
      <div class="card-title">✨ نقاط الجولة</div>
      ${notesHtml(notes)}
    </div>
    <button class="big" id="at-againBtn" data-quiet="1">جولة جديدة 🎲</button>
    <button class="big ghost" id="at-setupBtn">الإعدادات ⚙️</button>
    <button class="big ghost" id="at-homeBtn2">الرئيسية 🏠</button>
  `);
  SFX.win();
  playCoins(notes.length);
  setTimeout(() => burstFrom(document.querySelector(".p1 .av"), 50, ["👑", "⭐"]), 900);
  document.getElementById("at-againBtn").onclick = startAtarshRound;
  document.getElementById("at-setupBtn").onclick = renderAtarshSetup;
  document.getElementById("at-homeBtn2").onclick = renderHome;
}
