/* ============================================================
   أدوات عامة
   ============================================================ */
const LS = {
  get(k) {
    try { const value = localStorage.getItem(k); if (value !== null) return value; } catch {}
    try { return sessionStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    let stored = false;
    try { localStorage.setItem(k, v); stored = true; } catch {}
    // Session storage survives a page refresh even where persistent storage is restricted.
    try { sessionStorage.setItem(k, v); stored = true; } catch {}
    return stored;
  },
  del(k) {
    try { localStorage.removeItem(k); } catch {}
    try { sessionStorage.removeItem(k); } catch {}
  }
};
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function rand(n) { return Math.floor(Math.random() * n); }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function cleanText(s, max) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, max); }
const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const app = document.getElementById("app");

// يرسم داخل عنصر، ويشغّل أنيميشن الدخول والعدّادات فقط لما تتغير الشاشة
function paintEl(el, key, html) {
  el.innerHTML = html;
  const changed = el.dataset.key !== key;
  // نفس الشاشة انرسمت من جديد (تحديث بيانات): لا نعيد أنيميشن الدخول
  el.classList.toggle("static", !changed);
  if (changed) {
    el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter");
    el.dataset.key = key;
    window.scrollTo(0, 0);
    // أمان: لو المتصفح وقّف الأنيميشن (جهاز بطيء أو تبويب بالخلفية) ما تبقى الشاشة مخفية
    clearTimeout(el._settle);
    el._settle = setTimeout(() => { if (el.dataset.key === key) { el.classList.remove("enter"); el.classList.add("static"); } }, 2500);
  }
  animateCounts(el, changed);
}
function paint(key, html) { paintEl(app, key, html); }

function animateCounts(root, animate) {
  root.querySelectorAll("[data-count]").forEach(el => {
    const to = Number(el.dataset.count) || 0;
    if (!animate || to === 0 || reduceMotion) { el.textContent = to; return; }
    el.textContent = 0;
    const t0 = performance.now(), d = 900 + Math.min(600, to * 60);
    const step = now => {
      const k = Math.min(1, (now - t0) / d);
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function shakeEl(el) { el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake"); }
function toast(msg, ms = 2600) {
  // رسالة وحدة بالمرة: لا تتراكم الرسائل فوق بعض
  document.querySelectorAll(".toast").forEach(x => x.remove());
  const t = document.createElement("div");
  const multi = String(msg).includes("\n");
  t.className = "toast" + (multi ? " long" : ""); t.textContent = msg;
  if (multi && ms === 2600) ms = 5500;   // رسائل الإرشاد الطويلة تحتاج وقت للقراءة
  if (ms !== 2600) t.style.animation = `toastIn .45s cubic-bezier(.2,1.5,.4,1) both, toastOut .4s ease-in ${Math.max(0, ms - 400) / 1000}s forwards`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function copyText(text, msg) {
  const fallback = () => window.prompt("انسخ:", text);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => { toast(msg); SFX.pop(); }, fallback);
  else fallback();
}
function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch {} }

/* ============================================================
   محرك الصوت: Web Audio مع ضاغط وصدى، بدون ملفات
   ============================================================ */
const SOUND_KEY = "bara_salfa_sound";
const MUSIC_KEY = "bara_salfa_music";

const AudioEngine = {
  ctx: null, master: null, sfxBus: null, musicBus: null, reverb: null,
  init() {
    if (this.ctx && this.ctx.state === "closed") {
      this.ctx = this.master = this.sfxBus = this.musicBus = this.reverb = null;
    }
    if (this.ctx) {
      // Safari can report "interrupted" after a call or app switch. Resume any
      // non-running context, and always consume the Promise rejection (autoplay
      // policy may legitimately require a later user gesture).
      if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const c = this.ctx = new AC();
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 20; comp.ratio.value = 4;
    comp.attack.value = 0.003; comp.release.value = 0.25;
    this.master = c.createGain(); this.master.gain.value = 0.9;
    this.master.connect(comp); comp.connect(c.destination);
    this.sfxBus = c.createGain(); this.sfxBus.connect(this.master);
    this.musicBus = c.createGain(); this.musicBus.gain.value = 0; this.musicBus.connect(this.master);
    // صدى صناعي (impulse response مولّد)
    const len = Math.floor(c.sampleRate * 2.4), ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    this.reverb = c.createConvolver(); this.reverb.buffer = ir;
    const wet = c.createGain(); wet.gain.value = 0.35;
    this.reverb.connect(wet); wet.connect(this.master);
    return c;
  }
};

const Sound = {
  on: LS.get(SOUND_KEY) !== "off",
  allowed(o) { return o.music ? Music.on : this.on; },
  route(c, node, o, t) {
    const dest = o.music ? AudioEngine.musicBus : AudioEngine.sfxBus;
    node.connect(dest);
    if (o.rev) {
      const s = c.createGain(); s.gain.value = o.rev;
      node.connect(s);
      if (o.music) { const g = c.createGain(); s.connect(g); g.connect(AudioEngine.reverb); }
      else s.connect(AudioEngine.reverb);
    }
  },
  // نغمة بمغلف صوتي، ممكن تكون عدة مذبذبات مع detune وفلتر واهتزاز
  voice(freq, dur, o = {}) {
    if (!this.allowed(o)) return;
    let c = null;
    try { c = AudioEngine.init(); } catch (e) { return; }
    if (!c) return;
    const { type = "sine", vol = 0.15, delay = 0, attack = 0.008, slide = 0, detune = 0, voices = 1, cutoff = 0, vibrato = 0 } = o;
    const t = o.at != null ? o.at : c.currentTime + delay;
    const rel = dur;
    const end = t + attack + rel + 0.05;
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vol, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + rel);
    let out = env;
    if (cutoff) {
      const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.setValueAtTime(cutoff, t); f.Q.value = 0.7;
      env.connect(f); out = f;
    }
    this.route(c, out, o, t);
    for (let i = 0; i < voices; i++) {
      const osc = c.createOscillator(); osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + attack + rel);
      if (voices > 1) osc.detune.value = (i - (voices - 1) / 2) * detune;
      if (vibrato) {
        const l = c.createOscillator(), lg = c.createGain();
        l.frequency.value = vibrato; lg.gain.value = freq * 0.025;
        l.connect(lg); lg.connect(osc.frequency); l.start(t); l.stop(end);
      }
      osc.connect(env); osc.start(t); osc.stop(end);
    }
  },
  // ضوضاء مفلترة (للووش، الطبول، الصنج...)
  noise(dur, o = {}) {
    if (!this.allowed(o)) return;
    let c = null;
    try { c = AudioEngine.init(); } catch (e) { return; }
    if (!c) return;
    const { vol = 0.15, delay = 0, freq = 1000, to = 0, q = 1, type = "bandpass", attack = 0.005 } = o;
    const t = o.at != null ? o.at : c.currentTime + delay;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g);
    this.route(c, g, o, t);
    src.start(t); src.stop(t + dur + 0.02);
  }
};

const N = m => 440 * Math.pow(2, (m - 69) / 12);   // رقم MIDI إلى تردد
function bell(m, delay, vol = 0.1) {
  Sound.voice(N(m), 1.1, { vol, delay, attack: 0.004, rev: 0.45 });
  Sound.voice(N(m + 12), 0.5, { vol: vol * 0.35, delay, attack: 0.004, rev: 0.45 });
}
function brass(chord, delay, dur, vol = 0.045) {
  chord.forEach(m => Sound.voice(N(m), dur, { type: "sawtooth", voices: 2, detune: 7, cutoff: 2400, vol, delay, attack: 0.03, rev: 0.3 }));
}
function snare(delay, vol) {
  Sound.noise(0.09, { type: "highpass", freq: 1400, vol, delay });
  Sound.voice(190, 0.05, { vol: vol * 0.6, delay, slide: -60 });
}
function crash(delay, vol = 0.2) { Sound.noise(1.8, { type: "highpass", freq: 5000, vol, delay, rev: 0.3 }); }

const SFX = {
  click:    () => Sound.voice(1500, 0.045, { slide: -500, vol: 0.06 }),
  pop:      () => Sound.voice(480, 0.11, { slide: 700, vol: 0.13, rev: 0.1 }),
  select:   () => SFX.pop(),
  add:      () => { Sound.voice(N(72), 0.14, { type: "triangle", vol: 0.12 }); Sound.voice(N(79), 0.25, { type: "triangle", vol: 0.12, delay: 0.08, rev: 0.3 }); },
  remove:   () => Sound.voice(520, 0.2, { type: "triangle", slide: -320, vol: 0.1 }),
  join:     () => { bell(76, 0, 0.09); bell(72, 0.18, 0.09); },
  message:  () => Sound.voice(N(86), 0.1, { vol: 0.06, slide: 250, rev: 0.2 }),
  coin:     () => { Sound.voice(N(83), 0.07, { type: "square", vol: 0.05, cutoff: 5000 }); Sound.voice(N(88), 0.32, { type: "square", vol: 0.05, delay: 0.07, cutoff: 5000, rev: 0.2 }); },
  start:    () => { [60, 64, 67, 72, 76, 79].forEach((m, i) => bell(m, i * 0.065, 0.09)); Sound.noise(0.8, { type: "highpass", freq: 7000, vol: 0.05, delay: 0.3, rev: 0.4 }); },
  whoosh:   () => Sound.noise(0.45, { freq: 300, to: 3500, q: 1.2, vol: 0.16 }),
  flip:     () => { Sound.noise(0.2, { freq: 2200, to: 500, q: 0.8, vol: 0.14 }); Sound.voice(150, 0.18, { slide: -90, vol: 0.25, delay: 0.13 }); },
  reveal:   () => { SFX.flip(); [84, 88, 91, 96].forEach((m, i) => bell(m, 0.22 + i * 0.08, 0.07)); },
  outsider: () => {
    SFX.flip();
    Sound.voice(N(45), 1.7, { type: "sawtooth", voices: 3, detune: 22, cutoff: 650, vol: 0.06, delay: 0.15, attack: 0.06, rev: 0.6 });
    Sound.voice(N(46), 1.7, { type: "sawtooth", voices: 2, detune: 18, cutoff: 600, vol: 0.045, delay: 0.15, attack: 0.06, rev: 0.6 });
    Sound.voice(85, 1.0, { slide: -45, vol: 0.32, delay: 0.15 });
  },
  hide:     () => Sound.noise(0.22, { freq: 3000, to: 450, vol: 0.1 }),
  tick:     () => Sound.noise(0.03, { freq: 3800, q: 5, vol: 0.14 }),
  heartbeat:() => { Sound.voice(72, 0.14, { vol: 0.35, slide: -20 }); Sound.voice(66, 0.14, { vol: 0.25, delay: 0.17, slide: -20 }); },
  timeUp:   () => { [88, 84, 88, 84, 88].forEach((m, i) => bell(m, i * 0.14, 0.09)); vibrate(400); },
  vote:     () => { Sound.voice(N(76), 0.11, { type: "triangle", vol: 0.12 }); Sound.voice(N(83), 0.3, { type: "triangle", vol: 0.12, delay: 0.09, rev: 0.3 }); },
  drumroll: () => {
    for (let i = 0; i < 30; i++) snare(i * 0.07, 0.04 + i * 0.006);
    crash(2.1, 0.22);
    Sound.voice(92, 0.9, { slide: -50, vol: 0.42, delay: 2.1 });
  },
  caught:   () => {
    brass([60, 64, 67], 0, 0.16); brass([60, 64, 67], 0.19, 0.16); brass([65, 69, 72], 0.38, 0.16);
    brass([67, 71, 74], 0.57, 0.3); brass([72, 76, 79], 0.92, 1.3, 0.05);
    crash(0.92, 0.16); [84, 88, 91].forEach((m, i) => bell(m, 1.0 + i * 0.07, 0.05));
  },
  escaped:  () => {
    [[58, 0, 0.32], [57, 0.36, 0.32], [56, 0.72, 0.32]].forEach(([m, d, l]) => Sound.voice(N(m), l, { type: "sawtooth", voices: 2, detune: 10, cutoff: 1000, vol: 0.08, delay: d, attack: 0.03 }));
    Sound.voice(N(55), 1.1, { type: "sawtooth", voices: 2, detune: 10, cutoff: 1000, vol: 0.08, delay: 1.08, attack: 0.03, vibrato: 6 });
  },
  // صوت كشف الكرت: واحد للكل، سواء أنت برا السالفة أو لا
  cardReveal: () => { SFX.flip(); [79, 84, 88].forEach((m, i) => bell(m, 0.2 + i * 0.08, 0.06)); },
  correct:  () => { [72, 76, 79, 84, 88].forEach((m, i) => bell(m, i * 0.06, 0.08)); setTimeout(SFX.coin, 380); },
  wrong:    () => { Sound.voice(110, 0.5, { type: "square", voices: 2, detune: 40, cutoff: 900, vol: 0.08 }); Sound.voice(104, 0.5, { type: "square", cutoff: 700, vol: 0.05, delay: 0.05 }); },
  win:      () => { brass([67, 71, 74], 0, 0.14); brass([72, 76, 79], 0.16, 0.9, 0.05); [91, 96].forEach((m, i) => bell(m, 0.2 + i * 0.1, 0.05)); }
};
// الصوت ما يوقف اللعبة أبداً: لو صار أي خطأ في الصوت نتجاهله
Object.keys(SFX).forEach(k => {
  const fn = SFX[k];
  SFX[k] = (...a) => { try { fn(...a); } catch (e) { console.warn("sfx", k, e); } };
});

/* ============================================================
   موسيقى خلفية مولّدة (هادئة / متوترة)
   ============================================================ */
const Music = {
  on: LS.get(MUSIC_KEY) !== "off",
  mood: "calm", timer: null, next: 0, step: 0, duckT: null,
  LEVEL: 0.5,
  start() {
    if (!this.on || this.timer) return;
    if (typeof Voice !== "undefined" && Voice.on) return;   // الموسيقى ساكتة وقت المكالمة
    let c = null;
    try { c = AudioEngine.init(); } catch (e) { console.warn("audio", e); }
    if (!c) return;
    this.fadeTo(this.LEVEL, 2);
    this.next = c.currentTime + 0.1; this.step = 0;
    this.timer = setInterval(() => this.schedule(), 100);
  },
  stop() { clearInterval(this.timer); this.timer = null; this.fadeTo(0, 0.4); },
  fadeTo(v, s) {
    const c = AudioEngine.ctx; if (!c) return;
    const g = AudioEngine.musicBus.gain, now = c.currentTime;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(v, now + s);
  },
  duck(sec) {
    if (!this.timer) return;
    this.fadeTo(0.06, 0.3);
    clearTimeout(this.duckT);
    this.duckT = setTimeout(() => { if (this.timer) this.fadeTo(this.LEVEL, 1.5); }, sec * 1000);
  },
  setMood(m) { this.mood = m; },
  schedule() {
    try { this.scheduleInner(); } catch (e) { console.warn("music", e); this.stop(); }
  },
  scheduleInner() {
    const c = AudioEngine.ctx; if (!c) return;
    const bpm = this.mood === "tense" ? 108 : 88;
    const eighth = 60 / bpm / 2;
    if (this.next < c.currentTime - 0.2) this.next = c.currentTime + 0.05;
    while (this.next < c.currentTime + 0.35) { this.play(this.step, this.next, eighth); this.next += eighth; this.step++; }
  },
  play(step, t, e) {
    const calm = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];   // Am F C G
    const tense = [[57, 60, 64], [50, 53, 57], [52, 56, 59], [57, 60, 63]];  // Am Dm E Adim
    const tenseMood = this.mood === "tense";
    const prog = tenseMood ? tense : calm;
    const s = step % 8, chord = prog[Math.floor(step / 8) % 4];
    const M = { music: true, at: t };
    if (s === 0) {
      chord.forEach(n => Sound.voice(N(n), e * 8, { ...M, type: "triangle", vol: 0.03, attack: 0.5, voices: 2, detune: 9, cutoff: 1100, rev: 0.6 }));
      Sound.voice(N(chord[0] - 24), e * 6, { ...M, vol: 0.08, attack: 0.02 });
    }
    const arp = [0, 1, 2, 1, 2, 0, 1, 2];
    if (tenseMood || s % 2 === 0 || Math.random() < 0.35)
      Sound.voice(N(chord[arp[s]] + 12 + (s >= 4 ? 12 : 0)), e * 1.6, { ...M, vol: 0.032, attack: 0.004, rev: 0.45 });
    if (s === 0 || s === 4) Sound.voice(140, 0.22, { ...M, slide: -95, vol: tenseMood ? 0.14 : 0.09 });
    if (s % 2 === 1) Sound.noise(0.035, { ...M, type: "highpass", freq: 8000, vol: tenseMood ? 0.03 : 0.018 });
    if (tenseMood) Sound.voice(N(chord[0] - 12), e * 0.8, { ...M, type: "sawtooth", cutoff: 400, vol: 0.035, attack: 0.005 });
  }
};
document.addEventListener("pointerdown", () => Music.start(), { once: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") Music.stop(); else if (AudioEngine.ctx) Music.start();
});

/* ============================================================
   قصاصات بفيزياء على canvas
   ============================================================ */
const FX = { cv: null, cx: null, parts: [], raf: 0, w: 0, h: 0 };
const FX_COLORS = ["#ff4d8d", "#ffb020", "#22d3ee", "#8b5cf6", "#2ee59d", "#ffffff", "#ffd43b"];
function fxCanvas() {
  if (FX.cv) return;
  FX.cv = document.createElement("canvas"); FX.cv.id = "fx";
  document.body.appendChild(FX.cv);
  FX.cx = FX.cv.getContext("2d");
  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    FX.w = innerWidth; FX.h = innerHeight;
    FX.cv.width = FX.w * dpr; FX.cv.height = FX.h * dpr;
    FX.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize(); addEventListener("resize", resize);
}
function addPart(p, emojis) {
  p.rot = Math.random() * Math.PI * 2; p.vr = (Math.random() - 0.5) * 0.3;
  p.wob = Math.random() * 10; p.vw = 0.05 + Math.random() * 0.1;
  if (emojis && Math.random() < 0.3) { p.emoji = emojis[rand(emojis.length)]; p.size = 20 + rand(14); }
  else { p.color = FX_COLORS[rand(FX_COLORS.length)]; p.w = 7 + rand(6); p.hh = 10 + rand(8); p.circle = Math.random() < 0.25; }
  FX.parts.push(p);
}
function confetti(n = 140, emojis = ["🎉", "✨", "🎊", "⭐"]) {
  if (reduceMotion) return;
  fxCanvas();
  for (let i = 0; i < n; i++) addPart({ x: Math.random() * FX.w, y: -20 - Math.random() * FX.h * 0.5, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3, g: 0.05, drag: 0.995 }, emojis);
  fxLoop();
}
function burst(x, y, n = 60, emojis) {
  if (reduceMotion) return;
  fxCanvas();
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 9;
    addPart({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 4, g: 0.25, drag: 0.97 }, emojis);
  }
  fxLoop();
}
function burstFrom(el, n, emojis) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, n, emojis);
}
function fxLoop() {
  if (FX.raf) return;
  const tick = () => {
    const { cx, w, h } = FX;
    cx.clearRect(0, 0, w, h);
    FX.parts = FX.parts.filter(p => p.y < h + 60 && p.x > -60 && p.x < w + 60);
    for (const p of FX.parts) {
      p.vx *= p.drag; p.vy = p.vy * p.drag + p.g;
      if (p.vy > 4.5 && p.g < 0.1) p.vy = 4.5;
      p.wob += p.vw; p.rot += p.vr;
      p.x += p.vx + Math.sin(p.wob) * 0.8; p.y += p.vy;
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
      if (p.emoji) { cx.font = p.size + "px serif"; cx.textAlign = "center"; cx.fillText(p.emoji, 0, 0); }
      else {
        cx.scale(1, Math.cos(p.wob * 2));
        cx.fillStyle = p.color;
        if (p.circle) { cx.beginPath(); cx.arc(0, 0, p.w / 2, 0, Math.PI * 2); cx.fill(); }
        else cx.fillRect(-p.w / 2, -p.hh / 2, p.w, p.hh);
      }
      cx.restore();
    }
    if (FX.parts.length) FX.raf = requestAnimationFrame(tick);
    else { FX.raf = 0; cx.clearRect(0, 0, w, h); }
  };
  FX.raf = requestAnimationFrame(tick);
}

/* ============================================================
   الخلفية: إيموجيات طايرة
   ============================================================ */
function setFloaters(emojis) {
  const layer = document.getElementById("bg");
  const sig = emojis.join("");
  if (layer.dataset.sig === sig) return;
  layer.dataset.sig = sig;
  layer.innerHTML = "";
  for (let i = 0; i < 12; i++) {
    const s = document.createElement("span");
    s.textContent = emojis[i % emojis.length];
    s.style.left = Math.random() * 92 + "vw";
    s.style.fontSize = 22 + rand(30) + "px";
    s.style.animationDuration = 16 + Math.random() * 14 + "s";
    s.style.animationDelay = -Math.random() * 24 + "s";
    layer.appendChild(s);
  }
}
const HOME_FLOATERS = Object.values(CATEGORIES).map(c => c.icon).concat(["🕵️", "🤫", "❓"]);

/* ============================================================
   مكونات الواجهة المشتركة
   ============================================================ */
function hashStr(s) { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) | 0; return Math.abs(h); }
// الشكل اللي اختاره كل لاعب (look)، والباقين نولّد لهم شكل ثابت من اسمهم
const AV_LOOKS = new Map();
function setAvLooks(players) {
  AV_LOOKS.clear();
  players.forEach(p => { if (decodeLook(p.look)) AV_LOOKS.set(pkey(p), p.look); });
}
function lookFor(key) { return decodeLook(AV_LOOKS.get(key)) || randomLook(key); }
// صورة اللاعب: شخصية كرتونية مضحكة (من js/chars.js)
function avatar(key, size = "") { return lookAvatar(lookFor(key), size).replace('<span class="av', `<span data-k="${esc(key)}" class="av`); }
// زر يفتح شاشة "شخصيتك"
function avatarBtn(key, attr) {
  return `<button class="av-btn" ${attr} data-quiet="1" aria-label="غيّر الشخصية">${avatar(key)}<span class="av-swap">✏️</span></button>`;
}
function pkey(p) { return p.id || p.name; }

/* ----- بوسترات الأفلام والمسلسلات (من TMDB) ----- */
const POSTER_BASE = "https://image.tmdb.org/t/p/w342";
const TMDB_NOTE = `<p class="tmdb-note"><span class="tmdb-credit" style="position:static">TMDB</span>This product uses the TMDB API but is not endorsed or certified by TMDB. صور الأفلام والمسلسلات والكرتون من <a href="https://www.themoviedb.org/" target="_blank" rel="noopener" style="color:inherit">themoviedb.org</a></p>`;
// لو البوستر ما تحمّل نعرض الإيموجي (بدون onerror داخل الـ HTML عشان سياسة الحماية CSP)
document.addEventListener("error", e => {
  const t = e.target;
  if (t && t.classList && t.classList.contains("poster") && t.parentNode) t.parentNode.classList.add("broken");
}, true);
// نجيب البوستر من بيانات الكلمات نفسها، مو من رسائل الغرفة
function posterFor(cat, word) {
  const w = CATEGORIES[cat] && CATEGORIES[cat].words.find(x => x[0] === word);
  return w && /^\/[A-Za-z0-9]+\.jpg$/.test(w[2] || "") ? POSTER_BASE + w[2] : "";
}
function preloadPoster(cat, word) {
  const url = posterFor(cat, word);
  if (url && preloadPoster.last !== url) { preloadPoster.last = url; const img = new Image(); img.referrerPolicy = "no-referrer"; img.src = url; }
}
function posterHtml(url, emoji, cls = "") {
  return `
    <div class="poster-wrap ${cls}">
      <img class="poster" src="${esc(url)}" alt="" referrerpolicy="no-referrer">
      <div class="big-emoji poster-fallback">${esc(emoji)}</div>
      <span class="tmdb-credit">TMDB</span>
    </div>`;
}

// كرت الدور: وجه واحد يلف ويطلع (بدون حيل الوجهين، عشان يشتغل على كل المتصفحات).
// نفس اللون للكل، عشان اللي جنبك ما يعرف من لون الشاشة إنك برا السالفة.
function roleCardHtml(isOut, word, emoji, poster = "") {
  const withPoster = !isOut && poster;
  return `
    <div class="flip-card">
      <div class="flip-inner ${withPoster ? "has-poster" : ""}">
        <div class="face front-face">
          ${isOut
            ? `<div class="big-emoji wiggle">🕵️</div>
               <div class="role-title">أنت برا السالفة</div>
               <div class="role-sub">حاول تعرف السالفة وما تنكشف 🤫</div>`
            : `<div class="role-sub">السالفة هي</div>
               ${withPoster ? posterHtml(poster, emoji) : `<div class="big-emoji float">${esc(emoji)}</div>`}
               <div class="role-title">${esc(word)}</div>`}
        </div>
      </div>
    </div>`;
}

/* ----- اختيار أكثر من تصنيف (قائمة فاضية = عشوائي من الكل) ----- */
function validCats(list) { return Array.isArray(list) ? list.filter(c => CATEGORIES[c]) : []; }
function toggleCat(list, c) {
  if (c === RANDOM || !CATEGORIES[c]) return [];
  const next = list.includes(c) ? list.filter(x => x !== c) : list.concat(c);
  return next.length === Object.keys(CATEGORIES).length ? [] : next;
}
function pickCat(list) {
  const pool = validCats(list).length ? validCats(list) : Object.keys(CATEGORIES);
  return pool[rand(pool.length)];
}
function catsLabel(list) {
  return list.length ? `${list.length} تصنيفات، واللعبة تختار منها كل جولة` : "اللعبة تختار تصنيف عشوائي كل جولة";
}
function chipsHtml(selected, readOnly = false) {
  const all = [RANDOM, ...Object.keys(CATEGORIES)];
  const isOn = c => c === RANDOM ? selected.length === 0 : selected.includes(c);
  const shown = readOnly ? all.filter(isOn) : all;
  return `
    <div class="chips">${shown.map(c => readOnly
      ? `<span class="chip active">${catIcon(c)} ${esc(c)}</span>`
      : `<button class="chip ${isOn(c) ? "active" : ""}" data-cat="${esc(c)}" data-quiet="1">${isOn(c) && c !== RANDOM ? "✓ " : ""}${catIcon(c)} ${esc(c)}</button>`).join("")}</div>
    <p class="hint" style="text-align:right">${selected.length === 1 ? "تصنيف واحد" : catsLabel(selected)}</p>`;
}

/* ----- شاشة السؤال: سؤال واحد كل مرة ----- */
function questionHtml({ cat, round, i, total, a, b }) {
  return `
    <div class="q-head">
      <span class="pill">${CATEGORIES[cat].icon} ${esc(cat)}</span>
      <span class="pill">الجولة ${Number(round) || 1}</span>
    </div>
    <div class="q-stage">
      <div class="q-count">السؤال ${(Number(i) || 0) + 1} من ${Number(total) || 1}</div>
      <div class="q-person asker">${avatar(a.key, "xxl")}<span class="name-tag">${esc(a.name)}</span></div>
      <div class="q-asks">يسأل</div>
      <svg class="q-arrow" viewBox="0 0 24 44" aria-hidden="true"><path d="M12 3v34M4 28l8 10 8-10"/></svg>
      <div class="q-person target">${avatar(b.key, "xxl")}<span class="name-tag">${esc(b.name)}</span></div>
    </div>
    <div class="q-progress"><div style="--w:${((i + 1) / total) * 100}%"></div></div>`;
}
function qDoneHtml() {
  return `
    <div class="card status-big">
      <div class="big-emoji float">✅</div>
      <div class="title">خلصت الأسئلة</div>
      <p class="hint">تبون جولة أسئلة ثانية ولا نصوّت؟</p>
    </div>`;
}

function suspenseHtml() {
  return `
    <div class="suspense">
      <div class="spot"></div>
      <div class="big-emoji drum">🥁</div>
      <h2 class="suspense-title">واللي برا السالفة هو</h2>
      <div class="dots"><span></span><span></span><span></span></div>
    </div>`;
}

function voteBarsHtml(players, counts, outsiderKey, keyOf) {
  const n = players.length;
  return players.map((x, i) => {
    const k = keyOf(x, i);
    const c = Number(counts[k]) || 0;
    const isOut = k === outsiderKey;
    return `
      <div class="vote-row ${isOut ? "is-out" : ""}" style="--i:${i}">
        ${avatar(pkey(x), "sm")}
        <div class="vote-main">
          <div class="vote-top"><span>${esc(x.name)}${isOut ? " 🕵️" : ""}</span><span><b data-count="${c}">${c}</b> صوت</span></div>
          <div class="bar-wrap"><div class="bar" style="--w:${(c / Math.max(1, n - 1)) * 100}%"></div></div>
        </div>
      </div>`;
  }).join("");
}

function outsiderBoxHtml(caught, player) {
  return `
    <div class="reveal-box ${caught ? "caught" : "escaped"}">
      <div class="rays"></div>
      <div class="reveal-label">اللي برا السالفة هو</div>
      <div class="reveal-av">${avatar(pkey(player), "xl")}</div>
      <div class="reveal-name">${esc(player.name)}</div>
      <div class="status-pill">${caught ? "انكشف! 🎯" : "فلت منكم! 😎💨"}</div>
    </div>`;
}

function makeGuessOptions(cat, word, emoji) {
  const others = shuffle(CATEGORIES[cat].words.filter(w => w[0] !== word)).slice(0, 7);
  return shuffle([[word, emoji], ...others]);
}
function optionsHtml(options) {
  return `<div class="grid opts stagger">
    ${options.map(([w, e], i) => `<button class="opt" data-g="${i}" data-quiet="1" style="--i:${i}"><span class="opt-emoji">${esc(e)}</span><span>${esc(w)}</span></button>`).join("")}
  </div>`;
}

function wordRevealHtml(word, emoji, poster = "") {
  return `
    <div class="word-reveal pop">
      <div class="role-sub">السالفة كانت</div>
      ${poster ? posterHtml(poster, emoji, "small") : `<div class="big-emoji float">${esc(emoji)}</div>`}
      <div class="role-title">${esc(word)}</div>
    </div>`;
}

// منصة التتويج + باقي الترتيب
function rankingHtml(players) {
  const r = players.slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const top = r.slice(0, 3), rest = r.slice(3);
  const pod = i => {
    const p = top[i]; if (!p) return "";
    const sc = Number(p.score) || 0;
    return `
      <div class="pod p${i + 1}" style="--d:${[1, 0, 2][i]}">
        ${i === 0 ? `<div class="crown">👑</div>` : ""}
        ${avatar(pkey(p), i === 0 ? "lg" : "md")}
        <div class="pod-name">${esc(p.name)}</div>
        <div class="pod-score"><b data-count="${sc}">${sc}</b> ⭐</div>
        <div class="pod-block">${i + 1}</div>
      </div>`;
  };
  return `
    <div class="podium">${pod(1)}${pod(0)}${pod(2)}</div>
    ${rest.length ? `<div class="rest stagger">${rest.map((p, i) => `
      <div class="rest-row" style="--i:${i}"><span class="rank">${i + 4}</span>${avatar(pkey(p), "sm")}<span class="pname">${esc(p.name)}</span><span><b data-count="${Number(p.score) || 0}">${Number(p.score) || 0}</b> ⭐</span></div>`).join("")}</div>` : ""}`;
}

function notesHtml(notes) {
  return notes.length
    ? notes.map((n, i) => `<div class="note" style="--i:${i}">${esc(n)}</div>`).join("")
    : `<div class="note muted">ما أحد أخذ نقاط 🤷</div>`;
}
function playCoins(n) { for (let i = 0; i < Math.min(n, 6); i++) setTimeout(SFX.coin, 700 + i * 260); }

/* ============================================================
   الأزرار: صوت، تموّج، وأزرار الصوت والموسيقى
   ============================================================ */
document.addEventListener("click", e => {
  const b = e.target.closest("button");
  if (b && !b.disabled && !b.dataset.quiet) SFX.click();
}, true);

document.addEventListener("pointerdown", e => {
  const b = e.target.closest("button");
  if (!b || b.disabled || reduceMotion) return;
  const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height) * 2;
  const rp = document.createElement("span");
  rp.className = "ripple";
  rp.style.width = rp.style.height = s + "px";
  rp.style.left = (e.clientX - r.left - s / 2) + "px";
  rp.style.top = (e.clientY - r.top - s / 2) + "px";
  b.appendChild(rp);
  setTimeout(() => rp.remove(), 650);
});

const muteBtn = document.getElementById("muteBtn");
const musicBtn = document.getElementById("musicBtn");
function updateAudioBtns() {
  muteBtn.textContent = Sound.on ? "🔊" : "🔇";
  musicBtn.classList.toggle("off", !Music.on);
}
muteBtn.onclick = () => {
  Sound.on = !Sound.on;
  LS.set(SOUND_KEY, Sound.on ? "on" : "off");
  updateAudioBtns();
  if (Sound.on) SFX.pop();
};
musicBtn.onclick = () => {
  Music.on = !Music.on;
  LS.set(MUSIC_KEY, Music.on ? "on" : "off");
  updateAudioBtns();
  if (Music.on) Music.start(); else Music.stop();
  toast(Music.on ? "الموسيقى شغالة 🎵" : "الموسيقى طافية");
};
updateAudioBtns();

/* ============================================================
   اختيار برا السالفة: عشوائي موزون يقلل التكرار
   ============================================================ */
function pickOutsider(players, history) {
  const n = players.length;
  const weights = players.map((_, i) => {
    const key = typeof players[i] === "object" ? (players[i].id != null ? players[i].id : players[i].name != null ? players[i].name : i) : i;
    const pos = history.lastIndexOf(key);
    if (pos === -1) return 1.0;
    const ago = history.length - pos;
    if (ago === 1) return 0.15;
    if (ago === 2) return 0.4;
    if (ago === 3) return 0.7;
    return 1.0;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < n; i++) { r -= weights[i]; if (r <= 0) return i; }
  return n - 1;
}
function updateOutsiderHistory(history, key, maxLen) {
  history.push(key);
  if (history.length > maxLen) history.shift();
}

/* ----- الوضع الليلي / العادي ----- */
const THEME_KEY = "bara_theme";
const themeBtn = document.getElementById("themeBtn");
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  themeBtn.textContent = t === "light" ? "🌙" : "☀️";
  themeBtn.setAttribute("aria-label", t === "light" ? "الوضع الليلي" : "الوضع العادي");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "light" ? "#f3eeff" : "#0b0820");
}
applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
themeBtn.onclick = () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  LS.set(THEME_KEY, next);
  applyTheme(next);
  SFX.pop();
  toast(next === "light" ? "الوضع العادي ☀️" : "الوضع الليلي 🌙");
};
