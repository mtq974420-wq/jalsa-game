/* ============================================================
   مكالمة صوتية داخل الغرفة (WebRTC)
   - متوافق مع: iOS Safari, Android Chrome, Firefox, Edge, Desktop Chrome
   - STUN مجاني + TURN احتياطي عبر Metered (يُعاد تحميله لو فشل)
   - كل اتصال بين لاعبين له رقم جلسة (sid): الرسائل القديمة تُتجاهل،
     والاتصال المعطّل يُعاد بناؤه من الطرفين بدون تعليق
   - المبادر دائماً اللاعب صاحب الـ id الأصغر، والثاني يطلب منه (ready)
   - مرشحات ICE تُرسل دفعات (رسالة وحدة بدل 10) عشان حد الرسائل في Supabase
   ============================================================ */

const METERED_TURN_DOMAIN   = "aljalsa.metered.live";
const METERED_TURN_API_KEY  = "1797aa7c66e844529ee95d27d4f7d4220b60";
const VOICE_MAX = 12;

const TURN_REFRESH_MS = 30 * 60 * 1000; // نجدد بيانات TURN كل نص ساعة
const TURN_RETRY_MS   = 15000;          // لو فشل تحميل TURN نعيد بعد 15 ثانية
const NEGOTIATE_MS    = 15000;          // اتصال ما اكتمل بهالمدة نعيد بناءه
const DISCONNECT_MS   = 5000;           // انقطاع مؤقت: ننتظر قبل ما نعيد البناء
const FRESH_MS        = 3500;           // اتصال جديد ما نلمسه (تفادي عروض مكررة)
const TURN_WAIT_MS    = 3000;           // أقصى انتظار لـ TURN عند الدخول (يكمل بالخلفية لو تأخر)
const MIC_RECOVER_TRIES = 3;            // محاولات استرجاع المايك لو انقطع (سماعة، بلوتوث...)
const SILENT_MIC_MS   = 12000;          // مايك صامت تماماً بهالمدة = غالباً مكتوم من النظام
const AUDIO_BITRATE   = 40000;          // سقف جودة الصوت (كافي للكلام، يخفف الضغط على الشبكة)

/* STUN: ثلاثة كفاية، أكثر من كذا يبطّئ جمع المرشحات ويزيد الرسائل */
const DEFAULT_ICE = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.relay.metered.ca:80" },
];

const Voice = {
  on: false, muted: false, joining: false, micLost: false,
  session: null, selectedMic: "", outputDevice: "",
  _recoverPromise: null, _recoverToken: null, _recoverAt: 0,
  _presenceChain: Promise.resolve(), _presenceDirty: false, _presenceAt: 0, _presenceRetry: null,
  _channel: null, _channelStatus: "",
  stream: null, joinToken: 0, joinStart: 0,
  playbackBlocked: false,   // المتصفح منع تشغيل صوت الآخرين (ينتظر ضغطة)
  acAllowed: false,
  lastError: "",
  peers: new Map(),      // id -> { pc, sid, audio, pending, outIce, ... }
  members: new Map(),    // id -> { muted }  من Presence
  iceServers: [...DEFAULT_ICE],
  turnOk: false, turnAt: 0, turnTry: 0, icePromise: null,
  attempts: new Map(),   // id -> { t, n }  تهدئة محاولات الاتصال
  earlyIce: new Map(),   // id -> [{ sid, cands, t }]  مرشحات وصلت قبل العرض
  signalQueues: new Map(),
  watchTimer: null,
  meterCtx: null, meters: new Map(), meterTimer: null,
  _resumePending: false, _hintTimer: null, _hintCount: 0, _lostAt: 0,
  _recovering: false, _dcT: null, _netT: null, _wl: null,
  _deadSince: 0, _deadWarned: false,

  /* ---- دعم المتصفح ---- */
  supported() {
    return !!(
      window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      (window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection)
    );
  },

  _ua() { return navigator.userAgent || ""; },
  _isIOS() {
    return /iPad|iPhone|iPod/.test(this._ua()) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  },
  _isAndroid() { return /Android/i.test(this._ua()); },
  _isStandalone() {
    try { return !!navigator.standalone || (window.matchMedia && matchMedia("(display-mode: standalone)").matches); }
    catch { return false; }
  },

  // متصفحات التطبيقات (انستغرام، سناب، فيسبوك، واتساب...) غالباً ما تسمح بالمايك
  _inApp() {
    const ua = this._ua();
    if (/FBAN|FBAV|FB_IAB|Instagram|Snapchat|Line\/|MicroMessenger|TikTok|musical_ly|BytedanceWebview|Twitter|Telegram|GSA\/|Pinterest|LinkedInApp|WhatsApp/i.test(ua)) return true;
    if (this._isAndroid() && /; wv\)/.test(ua)) return true;                       // Android WebView
    if (/iPhone|iPad|iPod/.test(ua) && !/Safari|CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) && !this._isStandalone()) return true; // iOS WKWebView
    return false;
  },

  _RTCPeer(cfg) {
    const PC = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
    return new PC(cfg);
  },

  _rtcConfig() {
    return { iceServers: this.iceServers, iceTransportPolicy: "all", bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" };
  },

  // حالة الاتصال (بعض المتصفحات القديمة ما فيها connectionState)
  _st(pc) {
    if (pc.connectionState) return pc.connectionState;
    const s = pc.iceConnectionState;
    return s === "completed" ? "connected" : s === "checking" ? "connecting" : s;
  },

  _newSid() { return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); },

  /* ---- ICE / TURN ---- */
  async loadIce() {
    const now = Date.now();
    if (this.icePromise) return this.icePromise;
    if (this.turnOk && now - this.turnAt < TURN_REFRESH_MS) return;
    if (this.turnTry && now - this.turnTry < TURN_RETRY_MS) return; // فشل/جرّبنا قبل شوي
    this.turnTry = now;
    this.icePromise = this._fetchTurn().finally(() => { this.icePromise = null; });
    return this.icePromise;
  },

  async _fetchTurn() {
    try {
      // Optional same-origin endpoint should return short-lived RTCIceServer[] credentials.
      const cfg = window.JALSAH_VOICE_CONFIG || {};
      const url = cfg.turnEndpoint || `https://${METERED_TURN_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_TURN_API_KEY)}`;
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 6000);
      let res;
      try { res = await fetch(url, { signal: ctrl.signal, cache: "no-store", credentials: "same-origin" }); }
      finally { clearTimeout(tid); }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) throw new Error("empty list");
      const valid = list.filter(s => {
        if (!s || !s.urls) return false;
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        if (!urls.length) return false;
        const hasTurn = urls.some(u => /^turns?:/i.test(u));
        return !hasTurn || (s.username && s.credential);
      });
      if (!valid.some(s => (Array.isArray(s.urls) ? s.urls : [s.urls]).some(u => /^turns?:/i.test(u))))
        throw new Error("no authenticated TURN relay in response");
      this.iceServers = [...DEFAULT_ICE, ...valid];
      this.turnOk = true;
      this.turnAt = Date.now();
      console.info("[Voice] TURN ready:", valid.length, "servers");
      // الاتصالات الحالية: حدّث الإعدادات، وأعد بناء اللي ما اتصل لأنه غالباً يحتاج TURN
      const now = Date.now();
      [...this.peers].forEach(([id, e]) => {
        try { e.pc.setConfiguration(this._rtcConfig()); } catch {}
        if (this.on && this._st(e.pc) !== "connected" && now - e.createdAt > 3000) this._rebuild(id, true);
      });
    } catch (e) {
      // نكمل بـ STUN، والـ watchdog يعيد المحاولة كل 15 ثانية
      if (Date.now() - this.turnAt >= TURN_REFRESH_MS) this.turnOk = false;
      console.warn("[Voice] TURN credentials unavailable:", e.message);
    }
  },

  // استدعه مسبقاً فور دخول الغرفة
  preload() { this.loadIce(); },

  /* ---- AudioContext (للمؤشر فقط) - يُنشأ من داخل ضغطة مستخدم ---- */
  _getAC() {
    if (!this.acAllowed) return null;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!this.meterCtx || this.meterCtx.state === "closed") this.meterCtx = new AC();
      return this.meterCtx;
    } catch (e) { return null; }
  },

  _resumeAC() {
    const ctx = this._getAC();
    if (ctx && ctx.state !== "running" && ctx.state !== "closed") ctx.resume().catch(() => {});
    return ctx;
  },

  /* ---- رسائل خطأ المايك ---- */
  _micError(e) {
    const n = e && e.name || "";
    if (!window.isSecureContext)
      return "المايك يحتاج رابط HTTPS.\nتأكد أن الرابط يبدأ بـ https://";
    if (n === "NotAllowedError" || n === "PermissionDeniedError" || n === "SecurityError") {
      if (this._inApp())
        return "متصفح التطبيق منع المايك.\nافتح الرابط في Safari أو Chrome وحاول مجدداً.";
      if (this._isIOS())
        return "المايك ممنوع.\n1. اضغط (aA) أو 🔒 في شريط العنوان\n2. إعدادات الموقع ← الميكروفون ← سماح\n3. حدّث الصفحة وحاول مجدداً\n(وتأكد من: الإعدادات ← Safari ← الميكروفون)";
      if (this._isAndroid())
        return "المايك ممنوع.\n1. اضغط القفل 🔒 بجنب الرابط ← الأذونات\n2. الميكروفون ← سماح\n3. حدّث الصفحة وحاول مجدداً\n(وتأكد أن المتصفح مسموح له بالمايك من إعدادات الجهاز)";
      return "المتصفح منع المايك.\n1. اضغط على القفل 🔒 بجنب الرابط\n2. غيّر الميكروفون إلى (سماح)\n3. حدّث الصفحة وحاول مجدداً\n(لو ما زبطت: تأكد من خصوصية الميكروفون في إعدادات النظام)";
    }
    if (n === "NotFoundError" || n === "DevicesNotFoundError")
      return "ما لقينا ميكروفون.\nتأكد أن الجهاز فيه مايك وغير معطّل (وسماعة الرأس موصّلة زين).";
    if (n === "NotReadableError" || n === "TrackStartError" || n === "AbortError")
      return "الميكروفون مشغول.\nأغلق التطبيقات الثانية اللي تستخدم المايك (مكالمة، تسجيل...) وحاول مجدداً.";
    return "تعذّر تشغيل المايك.\nتأكد من الصلاحيات وحاول مجدداً.";
  },

  _fail(code, msg, ms = 6000) {
    this.lastError = code;
    this.updateUi();
    toast(msg, ms);
  },

  /* ---- التقاط المايك: نبدأ بإعدادات محسّنة ونبسّطها لو المتصفح/الجهاز رفضها ---- */
  async _getMic(deviceId = this.selectedMic) {
    const md = navigator.mediaDevices;
    // iOS Safari يفضل إعدادات أبسط، خصوصاً عند استرجاع المايك
    const isIOS = this._isIOS();
    const tries = isIOS ? [
      { echoCancellation: true, noiseSuppression: true },
      { echoCancellation: true },
      true,
    ] : [
      { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
      { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      { echoCancellation: true, noiseSuppression: true },
      true,
    ];
    let last, busyRetried = false;
    for (let i = 0; i < tries.length; i++) {
      try {
        let audio = tries[i];
        if (deviceId) audio = { ...(typeof audio === "object" ? audio : {}), deviceId: { exact: deviceId } };
        const st = await md.getUserMedia({ audio, video: false });
        const track = st.getAudioTracks()[0];
        if (!track || track.readyState === "ended") {
          st.getTracks().forEach(t => t.stop());
          throw Object.assign(new Error("No live microphone track"), { name: "NotReadableError" });
        }
        return st;
      } catch (e) {
        last = e;
        const n = e && e.name;
        if (deviceId && ["OverconstrainedError", "NotFoundError", "DevicesNotFoundError"].includes(n)) {
          if (this.selectedMic === deviceId) this.selectedMic = "";
          return this._getMic("");
        }
        // رفض المستخدم أو ما في جهاز: إعادة المحاولة ما تفيد
        if (["NotAllowedError", "PermissionDeniedError", "SecurityError", "NotFoundError", "DevicesNotFoundError"].includes(n)) throw e;
        // المايك لسا ما تحرر من استخدام سابق (شائع بأندرويد وiOS بعد الخروج/الدخول): ننتظر ونعيد نفس المحاولة مرة
        if (!busyRetried && ["NotReadableError", "TrackStartError", "AbortError"].includes(n)) {
          busyRetried = true; i--;
          // iOS يحتاج وقت أطول أحياناً
          await new Promise(r => setTimeout(r, isIOS ? 1200 : 700));
          continue;
        }
        console.warn("[Voice] getUserMedia failed (", n, ") - retry with simpler constraints");
      }
    }
    throw last;
  },

  // تحسين المسار الصوتي: تلميح "كلام" للمتصفح (يضبط المعالجة)
  _hintTrack(t) {
    try { if (t && "contentHint" in t) t.contentHint = "speech"; } catch {}
  },

  // سقف الجودة للإرسال (بعد اكتمال الاتصال، لأن Safari ما يقبل قبلها)
  _tuneSenders(pc) {
    try {
      pc.getSenders().forEach(s => {
        if (!s.track || s.track.kind !== "audio" || typeof s.getParameters !== "function") return;
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = AUDIO_BITRATE;
        s.setParameters(p).catch(() => {});
      });
    } catch {}
  },

  /* ---- منع الشاشة من الانطفاء (إغلاق الشاشة يوقف المايك بالجوال) ---- */
  async _wakeLock(on) {
    try {
      if (on) {
        if (this._wl || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
        const wl = await navigator.wakeLock.request("screen");
        if (!this.on) { wl.release().catch(() => {}); return; }
        this._wl = wl;
        wl.addEventListener("release", () => { if (this._wl === wl) this._wl = null; });
      } else if (this._wl) {
        const wl = this._wl; this._wl = null;
        await wl.release();
      }
    } catch {}
  },

  /* ---- مراقبة المايك: انقطاع (سماعة انسحبت، مكالمة، إذن انسحب) ---- */
  _watchTrack(stream) {
    stream.getAudioTracks().forEach(t => {
      this._hintTrack(t);
      t.onended = () => this._micEnded(stream);
      t.onmute = () => {
        if (this.stream !== stream) return;
        this.micLost = true; this._lostAt = Date.now(); this.updateUi();
        if (document.visibilityState === "visible") toast("المايك توقف مؤقتاً 🎙️ (مكالمة أو تطبيق ثاني؟)");
      };
      t.onunmute = () => {
        if (this.stream !== stream) return;
        const was = this.micLost;
        this.micLost = false; this.updateUi();
        if (was && Date.now() - this._lostAt > 1500) toast("رجع المايك 🎤");
      };
    });
  },

  _micEnded(stream) {
    if (this.stream !== stream || !this.on) return;
    this.micLost = true; this._lostAt = Date.now(); this.updateUi();
    this._recoverMic();
  },

  // One recovery per voice generation. Old promises cannot replace a newer mic,
  // clear a newer recovery lock, or disconnect a subsequent call.
  _recoverMic(deviceId = this.selectedMic) {
    if (!this.on) return Promise.resolve(false);
    if (this._recoverPromise && this._recoverToken === this.joinToken) return this._recoverPromise;
    const token = this.joinToken, channel = this._ch();
    this._recovering = true; this._recoverToken = token; this._recoverAt = Date.now();
    const active = () => this.on && token === this.joinToken && channel === this._ch();
    const run = async () => {
      for (let i = 0; i < MIC_RECOVER_TRIES && active(); i++) {
        let fresh = null;
        try {
          fresh = await this._getMic(deviceId);
          if (!active()) { fresh.getTracks().forEach(t => t.stop()); return false; }
          const nt = fresh.getAudioTracks()[0], old = this.stream;
          nt.enabled = !this.muted; this._hintTrack(nt);
          this.stream = fresh;
          this._watchTrack(fresh);
          const rebuild = [];
          const replacements = Promise.all([...this.peers.values()].map(async e => {
            try {
              // Never pick an unrelated sender with a null track.
              const snd = e.sender || e.pc.getSenders().find(x => x.track && x.track.kind === "audio");
              if (!snd) throw new Error("Missing audio sender");
              await snd.replaceTrack(nt);
            } catch (err) { if (this.peers.get(e.id) === e) rebuild.push(e.id); }
          }));
          if (old && old !== fresh) {
            old.getAudioTracks().forEach(t => { t.onended = t.onmute = t.onunmute = null; });
            old.getTracks().forEach(t => t.stop());
          }
          await replacements;
          if (!active() || this.stream !== fresh) {
            fresh.getTracks().forEach(t => t.stop()); return false;
          }
          // The mute button might have changed while replaceTrack was pending.
          nt.enabled = !this.muted;
          this.micLost = nt.muted || nt.readyState !== "live";
          this._deadSince = 0; this._deadWarned = false;
          this._addMeter(this._myId(), fresh);
          rebuild.forEach(id => this._rebuild(id, true));
          this.updateUi();
          if (!this.micLost) toast("رجع المايك 🎤");
          return !this.micLost;
        } catch (err) {
          if (fresh) fresh.getTracks().forEach(t => t.stop());
          if (!active()) return false;
          console.warn("[Voice] mic recovery:", err && err.name);
          if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(err && err.name)) break;
          if (i < MIC_RECOVER_TRIES - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
      }
      if (active()) {
        const t = this.stream && this.stream.getAudioTracks()[0];
        this.micLost = !t || t.readyState !== "live" || t.muted;
        this.lastError = "mic-recovery"; this.updateUi();
        toast("تعذّر استرجاع المايك. تقدر تسمع الآخرين. اضغط 🔍 لاختيار المايك أو إعادة المحاولة.", 7000);
      }
      return false;
    };
    const promise = run().finally(() => {
      if (this._recoverPromise === promise) {
        this._recoverPromise = null; this._recoverToken = null; this._recovering = false;
      }
    });
    this._recoverPromise = promise;
    return promise;
  },

  // تغيّر الأجهزة (سحب/توصيل سماعة): لو مسار المايك انتهى نسترجعه
  _onDeviceChange() {
    if (!this.on || !this.stream) return;
    clearTimeout(this._dcT);
    this._dcT = setTimeout(() => {
      const t = this.stream && this.stream.getAudioTracks()[0];
      if (t && t.readyState === "ended") this._micEnded(this.stream);
    }, 600);
  },

  // رجع النت أو تغيّرت الشبكة (واي فاي ↔ بيانات): نعيد بناء الاتصالات غير الشغّالة بسرعة
  onNetBack() {
    if (!this.on) return;
    clearTimeout(this._netT);
    this._netT = setTimeout(() => {
      if (!this.on) return;
      this.turnTry = 0; this.loadIce();
      this._resumeAC();
      [...this.peers].forEach(([id, e]) => { if (this._st(e.pc) !== "connected") this._rebuild(id, true); });
    }, 1200);
  },

  /* ---- فتح صوت الآخرين (ضغطة المستخدم) ---- */
  unlockAudio() {
    this._resumeAC();
    let any = false;
    this.peers.forEach(e => {
      if (e.audio && e.audio.srcObject) {
        any = true;
        e.playBlocked = false;
        e.audio.muted = false;
        e.audio.volume = 1;
        this._play(e);
        // محاولة ثانية بعد لحظة
        setTimeout(() => {
          if (this.peers.get(e.id) === e && e.audio) {
            e.audio.muted = false;
            e.audio.volume = 1;
            if (e.audio.paused) this._play(e);
          }
        }, 500);
      }
    });
    if (!any) this.playbackBlocked = false;
    toast(any ? "🔊 تم تفعيل السماعة" : "🔊 السماعة جاهزة (ما فيه أحد بالصوت بعد)");
    this.updateUi();
  },

  // نعيد محاولة التشغيل (من أي ضغطة بالصفحة / رجوع للتبويب)
  retryPlayback(userGesture = false) {
    if (!this.on) return;
    this._resumeAC();
    this.peers.forEach(e => {
      if (!e.audio || !e.audio.srcObject) return;
      if (userGesture) e.playBlocked = false;
      if (!e.playBlocked && e.audio.paused) this._play(e);
    });
  },

  _play(entry) {
    const a = entry && entry.audio;
    if (!a || !a.srcObject || this.peers.get(entry.id) !== entry || entry.playBlocked) return;
    a.muted = false; a.volume = 1;
    if (!a.paused && !a.ended) { entry.playBlocked = false; this._markPlaying(); return; }
    if (entry.playPending) return;
    const fail = err => {
      if (this.peers.get(entry.id) !== entry) return;
      if (err && err.name === "NotAllowedError") { entry.playBlocked = true; this._markBlocked(); }
    };
    let p;
    try { p = a.play(); } catch (err) { fail(err); return; }
    if (p && p.then) {
      entry.playPending = true;
      Promise.resolve(p).then(() => {
        if (this.peers.get(entry.id) !== entry) return;
        entry.playBlocked = false; this._markPlaying();
      }, fail).finally(() => { entry.playPending = false; });
    }
  },

  _markPlaying() {
    // A playing participant must not hide another participant's autoplay error.
    const blocked = [...this.peers.values()].some(e => e.playBlocked);
    if (blocked) return;
    if (!this.playbackBlocked) return;
    this.playbackBlocked = false;
    clearInterval(this._hintTimer); this._hintTimer = null;
    this.updateUi();
  },

  _markBlocked() {
    if (this.playbackBlocked || !this.on) return;
    this.playbackBlocked = true;
    this._hintCount = 0;
    this.updateUi();
    const hint = () => {
      if (!this.on || !this.playbackBlocked || ++this._hintCount > 3) { clearInterval(this._hintTimer); this._hintTimer = null; return; }
      toast("🔊 اضغط أي مكان أو زر السماعة عشان تسمع الأصوات");
    };
    hint();
    clearInterval(this._hintTimer);
    this._hintTimer = setInterval(hint, 12000);
  },

  /* ---- helpers ---- */
  _myId() {
    // myId معرّف في online.js الذي يُحمَّل بعد voice.js
    if (typeof myId !== "undefined") return myId;
    try { return localStorage.getItem("bara_pid") || null; } catch { return null; }
  },
  _ch() {
    if (typeof AtOn !== "undefined" && AtOn.ch) return AtOn.ch;
    if (typeof On  !== "undefined" && On.ch)  return On.ch;
    return null;
  },
  _room() {
    if (typeof AtOn !== "undefined" && AtOn.ch) return AtOn.room;
    if (typeof On  !== "undefined" && On.ch)  return On.room;
    return null;
  },
  _pkOf(id) {
    const room = this._room();
    if (!room) return null;
    const all = (room.players || []).concat(room.waiting || []);
    const p = all.find(x => x && x.id === id);
    return (p && p.pk) ? p.pk : null;
  },
  _nameOf(id) {
    const room = this._room();
    if (room) {
      const all = (room.players || []).concat(room.waiting || []);
      const p = all.find(x => x && x.id === id);
      if (p && p.name) return p.name;
    }
    return "لاعب";
  },
  // مفتاح اللاعب ممكن يتأخر شوي (حالة الغرفة لسا ما وصلت): ننتظر بدل ما نرمي الرسالة
  _waitPk(id, ms) {
    const t0 = Date.now();
    return new Promise(res => {
      const tick = () => {
        const pk = this._pkOf(id);
        if (pk) return res(pk);
        if (Date.now() - t0 >= ms || !this._ch()) return res(null);
        setTimeout(tick, 150);
      };
      tick();
    });
  },

  meta() { return { voice: this.on, muted: this.muted, voiceSession: this.on ? this.session : null }; },
  _track() {
    const ch = this._ch();
    if (!ch) return Promise.resolve(false);
    this._presenceDirty = true;
    // Serialize metadata writes: an old unmute must never arrive after leave/mute.
    const task = this._presenceChain.catch(() => {}).then(async () => {
      if (ch !== this._ch() || !this._presenceDirty) return false;
      this._presenceDirty = false;
      clearTimeout(this._presenceRetry); this._presenceRetry = null;
      const meta = this.meta();
      try {
        const result = await ch.track(meta);
        if (ch !== this._ch()) return false;
        const ok = result === "ok" || result === undefined;
        this._presenceDirty = !ok || JSON.stringify(meta) !== JSON.stringify(this.meta());
        if (ok) this._presenceAt = Date.now();
        return ok;
      } catch { if (ch === this._ch()) this._presenceDirty = true; return false; }
      finally {
        // Leave metadata must retry even after the active-call watchdog stops.
        if (ch === this._ch() && this._presenceDirty && !this._presenceRetry) {
          this._presenceRetry = setTimeout(() => {
            this._presenceRetry = null;
            if (ch === this._ch()) this._track();
          }, 2000);
        }
      }
    });
    this._presenceChain = task;
    return task;
  },

  onChannelStatus(ch, status) {
    if (ch !== this._ch()) return;
    this._channel = ch; this._channelStatus = status;
    if (status === "SUBSCRIBED") {
      this.preload(); this._track();
      if (this.on) { this._send({ type: "join" }); this.onNetBack(); }
    }
  },

  resetRoom() {
    this.leave(true);
    this.members.clear(); this.signalQueues.clear();
    this._channel = null; this._channelStatus = "";
    this._presenceDirty = false; this._presenceChain = Promise.resolve();
    clearTimeout(this._presenceRetry); this._presenceRetry = null;
    this.updateUi();
  },

  /* ---- إرسال رسائل WebRTC ---- */
  async _send(msg, to = null) {
    const ch = this._ch(), token = this.joinToken;
    if (!ch) return false;
    const session = this.session;
    // Capture the target generation before any asynchronous encryption or key lookup.
    const targetSession = (this.members.get(to) || {}).session || null;
    if (!to) {
      if (msg.type !== "join") return false;
      try { return await ch.send({ type: "broadcast", event: "rtc", payload: { type: "join", from: this._myId() } }); }
      catch { return false; }
    }
    const pk = await this._waitPk(to, 2500);
    if (!pk) { console.warn("[Voice] _send: no pk for", String(to).substring(0, 8)); return false; }
    const live = () => ch === this._ch() && (msg.type === "leave" ||
      (this.on && token === this.joinToken && (!msg.sid || (this.peers.get(to) || {}).sid === msg.sid)));
    if (!live()) return false;
    try {
      const key = await Sec.pairKey(pk);
      const box = await Sec.seal(key, { ...msg, session, targetSession });
      if (!live()) return false;
      return await ch.send({ type: "broadcast", event: "rtc", payload: { from: this._myId(), to, box } });
    } catch (e) {
      console.warn("[Voice] send error", e);
      return false;
    }
  },

  // رسائل كل اتصال تنرسل بالترتيب، ولو فشل الإرسال نعيد مرة وحدة
  _queueOut(entry, msg) {
    entry.outChain = (entry.outChain || Promise.resolve())
      .then(async () => {
        if (!this.on || this.peers.get(entry.id) !== entry) return;
        let r = await this._send(msg, entry.id);
        if (r !== "ok" && r !== undefined) {
          await new Promise(res => setTimeout(res, 400));
          if (!this.on || this.peers.get(entry.id) !== entry) return;
          r = await this._send(msg, entry.id);
        }
      })
      .catch(e => console.warn("[Voice] queue send", e));
    return entry.outChain;
  },

  async _publishDesc(entry, type) {
    const desc = entry.pc.localDescription;
    if (!desc || !desc.sdp) return;
    this._queueOut(entry, { type, sid: entry.sid, data: { type: desc.type, sdp: desc.sdp } });
    entry.outHold = false;
    this._flushIce(entry);
    await entry.outChain;
  },

  // مرشحات ICE: نجمعها ~150ms ونرسلها برسالة وحدة
  _scheduleIce(entry) {
    if (entry.outTimer) return;
    entry.outTimer = setTimeout(() => { entry.outTimer = null; this._flushIce(entry); }, 150);
  },
  _flushIce(entry) {
    clearTimeout(entry.outTimer); entry.outTimer = null;
    // لا ترسل ICE candidates إذا:
    // 1. outHold مفعّل (SDP لم يُرسل بعد)
    // 2. لا يوجد remote description (الطرف الآخر لم يستلم/يرسل SDP)
    // 3. لا توجد مرشحات ICE للإرسال
    if (entry.outHold || !entry.outIce.length) return;
    if (!entry.pc.remoteDescription || !entry.pc.localDescription) {
      // SDP exchange لم يكتمل، أجّل إرسال المرشحات
      entry.outTimer = setTimeout(() => { entry.outTimer = null; this._flushIce(entry); }, 300);
      return;
    }
    const list = entry.outIce.splice(0);
    this._queueOut(entry, { type: "ice", sid: entry.sid, list });
  },

  /* ---- إنشاء Peer Connection (دائماً جديد، المستدعي يقرر قفل القديم) ---- */
  _peer(id, sid) {
    this._closePeer(id);
    let pc;
    try { pc = this._RTCPeer(this._rtcConfig()); }
    catch (e) { console.warn("[Voice] RTCPeerConnection failed", e); return null; }

    const entry = {
      id, sid, pc, session: (this.members.get(id) || {}).session || null, createdAt: Date.now(),
      audio: null, pending: [], outIce: [], outTimer: null,
      outChain: Promise.resolve(), outHold: true,
      makingOffer: false, initiator: false,
      ok: false, badSince: 0, goneSince: 0, route: "",
    };
    this.peers.set(id, entry);

    // أضف tracks المايك
    if (this.stream) {
      this.stream.getTracks().forEach(t => {
        try { const sender = pc.addTrack(t, this.stream); if (t.kind === "audio") entry.sender = sender; }
        catch (e) { console.warn("[Voice] addTrack", e); }
      });
    }

    pc.onicecandidate = e => {
      if (this.peers.get(id) !== entry) return;
      if (e.candidate) {
        const c = e.candidate;
        entry.outIce.push({ candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
        if (!entry.outHold) this._scheduleIce(entry);
      } else {
        this._flushIce(entry); // انتهى جمع المرشحات
      }
    };

    /* استلام صوت الطرف الآخر */
    pc.ontrack = e => {
      if (!this.on || this.peers.get(id) !== entry) return;
      const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      this._attachRemote(entry, stream);
      this._addMeter(id, stream);
    };

    const onState = () => {
      if (this.peers.get(id) !== entry) return;
      const s = this._st(pc);
      if (s === "connected") {
        if (!entry.ok) {
          entry.ok = true;
          this._logRoute(id, entry);
          this._tuneSenders(pc);
          // فور الاتصال: شغّل الصوت مباشرة
          if (entry.audio) {
            entry.audio.muted = false;
            entry.audio.volume = 1;
            this._play(entry);
          }
        }
        entry.badSince = 0;
        this.attempts.delete(id);
        if (entry.audio) this._play(entry);
      }
      if (s === "failed") {
        setTimeout(() => {
          if (this.on && this.peers.get(id) === entry && this._st(pc) === "failed") this._rebuild(id);
        }, 800);
      }
    };
    pc.onconnectionstatechange = () => { console.log("[Voice] conn:", String(id).substring(0, 8), pc.connectionState); onState(); };
    pc.oniceconnectionstatechange = () => { console.log("[Voice] ICE:", String(id).substring(0, 8), pc.iceConnectionState); onState(); };

    return entry;
  },

  _attachRemote(entry, stream) {
    if (!entry.audio) {
      const a = document.createElement("audio");
      a.autoplay = true; a.controls = false; a.muted = false; a.volume = 1;
      a.setAttribute("playsinline", "");
      a.setAttribute("webkit-playsinline", "");
      a.setAttribute("aria-hidden", "true");
      // المتصفح/النظام يوقف الصوت أحياناً (مكالمة، سيري، تبديل سماعة): نرجّعه تلقائياً
      a.onpause = () => {
        if (!this.on || this.peers.get(entry.id) !== entry || !a.srcObject) return;
        setTimeout(() => { if (this.on && this.peers.get(entry.id) === entry && a.paused) this._play(entry); }, 400);
      };
      (document.getElementById("voiceAudio") || this._mkAudioBox()).appendChild(a);
      entry.audio = a;
    }
    if (entry.audio.srcObject !== stream) entry.audio.srcObject = stream;
    // تأكد أنه مو مكتوم
    entry.audio.muted = false;
    entry.audio.volume = 1;
    if (this.outputDevice && typeof entry.audio.setSinkId === "function")
      entry.audio.setSinkId(this.outputDevice).catch(() => {});
    this._play(entry);
    // محاولات متعددة لضمان التشغيل على كل الأجهزة
    setTimeout(() => { if (this.peers.get(entry.id) === entry) { entry.audio && (entry.audio.muted = false); this._play(entry); } }, 600);
    setTimeout(() => { if (this.peers.get(entry.id) === entry) { entry.audio && (entry.audio.muted = false); this._play(entry); } }, 2500);
    setTimeout(() => { if (this.peers.get(entry.id) === entry) { entry.audio && (entry.audio.muted = false); this._play(entry); } }, 5000);
  },

  async _logRoute(id, entry) {
    try {
      const stats = await entry.pc.getStats();
      let pair = null;
      for (const s of stats.values()) {
        if (s.type === "candidate-pair" && (s.nominated || s.selected) && s.state === "succeeded") { pair = s; break; }
      }
      const local = pair && stats.get(pair.localCandidateId);
      entry.route = (local && local.candidateType) || "unknown";
      console.info(`[Voice] ${String(id).substring(0, 8)} connected via: ${entry.route}`, entry.route === "relay" ? "(TURN)" : "(P2P)");
    } catch {}
  },

  _closePeer(id) {
    const e = this.peers.get(id);
    if (!e) return;
    this.peers.delete(id);
    clearTimeout(e.outTimer);
    
    // Sender tracks belong to the shared local microphone stream. Closing one
    // peer must never stop the microphone for every other participant.
    // The shared stream is stopped only by leave()/cancel() when voice ends.

    try {
      e.pc.getReceivers().forEach(receiver => {
        if (receiver.track) {
          receiver.track.stop();
        }
      });
    } catch {}
    
    // إزالة كل مستمعي الأحداث
    try {
      e.pc.onicecandidate = null;
      e.pc.ontrack = null;
      e.pc.onconnectionstatechange = null;
      e.pc.oniceconnectionstatechange = null;
      e.pc.onnegotiationneeded = null;
      e.pc.ondatachannel = null;
      e.pc.onicecandidateerror = null;
    } catch {}
    
    // إغلاق الاتصال
    try { e.pc.close(); } catch {}
    
    // تنظيف عنصر الصوت
    if (e.audio) {
      try {
        e.audio.onpause = null;
        e.audio.onplay = null;
        e.audio.onerror = null;
        e.audio.pause();
        e.audio.srcObject = null;
        e.audio.remove();
      } catch {}
    }
    
    this._rmMeter(id);
    this._markPlaying();
  },

  _alive(entry, token) {
    return this.on && token === this.joinToken && this.peers.get(entry.id) === entry;
  },

  async _flush(entry) {
    const list = entry.pending.splice(0);
    for (const c of list) {
      try { await entry.pc.addIceCandidate(c); } catch (e) { console.warn("[Voice] addIceCandidate", e.message); }
    }
  },

  /* ---- ابدأ/أعد الاتصال مع لاعب ---- */
  // urgent: رد على join/ready (يتجاوز التهدئة). غير كذا: يمر من الـ watchdog مع تهدئة تتصاعد
  _connectTo(id, urgent = false) {
    if (!this.on || !id || id === this._myId()) return;
    const now = Date.now();
    const a = this.attempts.get(id) || { t: 0, n: 0 };
    if (!urgent && now - a.t < Math.min(2500 * (a.n + 1), 10000)) return;
    if (!this.peers.has(id) && this.peers.size >= VOICE_MAX - 1) return;
    this.attempts.set(id, { t: now, n: a.n });
    if (this._myId() < id) this._makeOffer(id);
    else this._send({ type: "ready", have: (this.peers.get(id) || {}).sid || null }, id);
  },

  _rebuild(id, quiet = false) {
    if (!this.on) return;
    console.warn("[Voice] rebuilding connection with", String(id).substring(0, 8));
    this._closePeer(id);
    const a = this.attempts.get(id) || { t: 0, n: 0 };
    if (!quiet) {
      a.n++;
      if (a.n === 3) toast(`تعذّر الاتصال بـ${this._nameOf(id)} 😕\nجرّب شبكة مختلفة (واي فاي / بيانات).`, 5000);
    }
    this.attempts.set(id, a);
    this._connectTo(id, true);
  },

  async _makeOffer(id, force = false) {
    if (!this.on || !this.stream) return;
    const token = this.joinToken;
    const old = this.peers.get(id);
    if (old && !force && (this._st(old.pc) === "connected" ||
        (old.initiator && Date.now() - old.createdAt < FRESH_MS && this._st(old.pc) !== "failed"))) return;
    if (!old && this.peers.size >= VOICE_MAX - 1) return;
    const entry = this._peer(id, this._newSid());
    if (!entry) return;
    entry.initiator = true;
    entry.makingOffer = true;
    try {
      const offer = await entry.pc.createOffer({ offerToReceiveAudio: true });
      if (!this._alive(entry, token)) return;
      await entry.pc.setLocalDescription(offer);
      if (!this._alive(entry, token)) return;
      await this._publishDesc(entry, "offer");
    } catch (e) {
      console.warn("[Voice] makeOffer", e);
      if (this.peers.get(id) === entry) this._closePeer(id); // الـ watchdog يعيد المحاولة
    } finally {
      entry.makingOffer = false;
    }
  },

  /* ---- الدخول للصوت ---- */
  async join() {
    if (this.on) return;
    if (this.joining) {                       // ضغطة ثانية أثناء الانتظار = إلغاء
      if (Date.now() - this.joinStart > 1200) this._cancelJoin();
      return;
    }
    this.lastError = "";

    // فحص المتطلبات الأساسية مع رسائل تشخيصية واضحة
    if (!window.isSecureContext)
      return this._fail("insecure", "❌ المايك يحتاج رابط HTTPS.\nتأكد أن الرابط يبدأ بـ https://");
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function")
      return this._fail("no-gum", this._inApp()
        ? "❌ متصفح التطبيق ما يدعم المايك.\nافتح الرابط في Safari أو Chrome."
        : "❌ المتصفح ما يتيح المايك.\nافتح اللعبة في Chrome أو Safari وتأكد من الإذن.");
    if (!window.RTCPeerConnection && !window.webkitRTCPeerConnection && !window.mozRTCPeerConnection)
      return this._fail("no-rtc", "❌ المتصفح ما يدعم الاتصال الصوتي.\nحدّث المتصفح أو جرّب Chrome.");
    if (!this._ch())
      return this._fail("no-channel", "❌ ما في اتصال بالغرفة.\nادخل غرفة أونلاين أولاً.");
    if (!this._room())
      return this._fail("no-room", "❌ بيانات الغرفة ما وصلت بعد.\nانتظر ثانية وحاول مجدداً.");

    const channel = this._ch();
    const attempt = ++this.joinToken;
    this.session = this._newSid();
    this.joining = true;
    this.joinStart = Date.now();
    console.log("[Voice] join started, attempt:", attempt, "myId:", this._myId());

    // AudioContext من داخل ضغطة المستخدم (مهم لـ iOS)
    this.acAllowed = true;
    this._resumeAC();
    this.updateUi();

    // التقاط المايك (لازم يكون أول await عشان iOS ما يعتبرها خارج الضغطة)
    let stream = null;
    // لو نافذة الإذن ما ظهرت/انتظرت (Firefox/Safari): نذكّره
    const permHint = setTimeout(() => {
      if (this.joining && attempt === this.joinToken && !this.stream)
        toast("ننتظر إذن المايك 🎙️\nاضغط (سماح) من نافذة المتصفح، أو اضغط الزر مرة ثانية للإلغاء.", 6000);
    }, 7000);
    try {
      stream = await this._getMic();
      if (attempt !== this.joinToken || channel !== this._ch()) {
        stream.getTracks().forEach(t => t.stop());
        if (attempt === this.joinToken) { this.joining = false; this.acAllowed = false; this._stopMeters(); this.updateUi(); }
        return;
      }
      const tracks = stream.getAudioTracks();
      if (!tracks.length) throw Object.assign(new Error("no audio track"), { name: "NotFoundError" });
      tracks.forEach(t => { t.enabled = true; });
      this.stream = stream;
      this.micLost = false;
      this._watchTrack(stream);
    } catch (e) {
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (attempt !== this.joinToken) return;   // انلغى الدخول
      console.warn("[Voice] mic error:", e && e.name, e && e.message);
      this.joining = false;
      this.stream = null;
      this.acAllowed = false;
      this._stopMeters();
      this._fail("mic:" + ((e && e.name) || "?"), this._micError(e), 7000);
      return;
    } finally {
      clearTimeout(permHint);
    }

    // انتظر TURN بحد أقصى 4.5 ثانية (غالباً جاهز من preload). لو تأخر يكمل بالخلفية ويعيد بناء الاتصالات
    await Promise.race([this.loadIce(), new Promise(r => setTimeout(r, TURN_WAIT_MS))]);

    if (attempt !== this.joinToken || channel !== this._ch()) {
      stream.getTracks().forEach(t => t.stop());
      if (this.stream === stream) this.stream = null;
      if (attempt === this.joinToken) { this.joining = false; this.acAllowed = false; this._stopMeters(); this.updateUi(); }
      return;
    }

    this.joining = false;
    this.on = true;
    this.muted = false;
    this.playbackBlocked = false;
    this.attempts.clear(); this.earlyIce.clear();
    this._deadSince = 0; this._deadWarned = false;
    if (typeof Music !== "undefined") Music.stop && Music.stop();
    this._wakeLock(true);
    this._track();
    this._startMeters();
    this._addMeter(this._myId(), stream);
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => this._watchdog(), 1500);
    this.updateUi();
    this._send({ type: "join" });                  // نعلن دخولنا للي بالصوت
    this.members.forEach((m, id) => this._connectTo(id, true)); // ونتصل باللي كانوا بالصوت (urgent لتجاوز الـ throttle)
    if (typeof SFX !== "undefined") SFX.join && SFX.join();
    toast("دخلت الصوت 🎧");
    // المايك انقطع أثناء ما كنا ندخل
    const t0 = stream.getAudioTracks()[0];
    if (t0 && t0.readyState === "ended") this._micEnded(stream);
  },

  _cancelJoin() {
    ++this.joinToken;
    this.joining = false;
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.acAllowed = false;
    this._stopMeters();
    this.updateUi();
    toast("تم إلغاء الدخول للصوت");
  },

  /* ---- الخروج ---- */
  leave(silent = false) {
    const had = this.on || this.joining || !!this.stream || this.peers.size > 0;
    ++this.joinToken;
    this.joining = false;
    if (!had) { this.updateUi(); return; }
    if (!silent) this.peers.forEach((e, id) => this._send({ type: "leave", sid: e.sid }, id));
    [...this.peers.keys()].forEach(id => this._closePeer(id));
    if (this.stream) {
      this.stream.getAudioTracks().forEach(t => { t.onended = t.onmute = t.onunmute = null; });
      this.stream.getTracks().forEach(t => t.stop());
    }
    this.stream = null; this.on = false; this.muted = false; this.micLost = false;
    this.playbackBlocked = false; this.acAllowed = false;
    clearInterval(this.watchTimer); this.watchTimer = null;
    clearInterval(this._hintTimer); this._hintTimer = null;
    clearTimeout(this._dcT); clearTimeout(this._netT);
    this._recovering = false; this._recoverPromise = null; this._recoverToken = null;
    this._deadSince = 0; this._deadWarned = false;
    this._wakeLock(false);
    this.attempts.clear(); this.earlyIce.clear(); this.signalQueues.clear();
    this._stopMeters();
    if (!silent) { this._track(); if (typeof SFX !== "undefined") SFX.hide && SFX.hide(); }
    this.updateUi();
    if (typeof Music !== "undefined" && Music.on) Music.start && Music.start();
  },

  /* ---- كتم/فتح ---- */
  toggleMute() {
    if (!this.on || !this.stream) return;
    this.muted = !this.muted;
    this.stream.getAudioTracks().forEach(t => { t.enabled = !this.muted; });
    this._track();
    this.updateUi();
    if (typeof SFX !== "undefined") SFX.pop && SFX.pop();
    toast(this.muted ? "كتمت صوتك 🔇" : "صوتك شغال 🎤");
  },

  /* ---- استقبال إشارات WebRTC (بالترتيب لكل لاعب) ---- */
  onSignal(raw) {
    if (!this.on || !raw || typeof raw !== "object" || raw.from === this._myId()) return Promise.resolve();
    const id = raw.from;
    if (typeof id !== "string" || id.length > 64) return Promise.resolve();
    if (raw.to && raw.to !== this._myId()) return Promise.resolve();
    const token = this.joinToken, channel = this._ch();
    const prev = this.signalQueues.get(id) || Promise.resolve();
    const next = prev.then(() => {
      if (token !== this.joinToken || channel !== this._ch()) return;
      return this._handleSignal(raw);
    }).catch(e => console.warn("[Voice] signal", e));
    this.signalQueues.set(id, next);
    next.finally(() => { if (this.signalQueues.get(id) === next) this.signalQueues.delete(id); });
    return next;
  },

  _stashIce(from, sid, cands) {
    const now = Date.now();
    const list = (this.earlyIce.get(from) || []).filter(x => now - x.t < 20000);
    list.push({ sid, cands, t: now });
    this.earlyIce.set(from, list.slice(-6));
  },

  async _handleSignal(raw) {
    if (!this.on || (raw.to && raw.to !== this._myId())) return;
    const token = this.joinToken;
    const from = raw.from;
    // نحتاج مفتاح اللاعب (من حالة الغرفة) - ننتظره شوي لو لسا ما وصل
    const pk = await this._waitPk(from, 2500);
    if (!pk) { console.warn("[Voice] _handleSignal: no pk for", from.substring(0, 8)); return; }
    if (!this.on || token !== this.joinToken) return;

    let p;
    if (raw.box) {
      try {
        const key = await Sec.pairKey(pk);
        p = await Sec.open(key, raw.box);
      } catch (e) { console.warn("[Voice] decrypt failed", e); return; }
      if (!p || typeof p !== "object") return;
      p.from = from;
    } else if (raw.type === "join") {
      p = { type: "join", from };
    } else return;
    if (!this.on || token !== this.joinToken) return;
    if (p.targetSession && p.targetSession !== this.session) return;
    const memberSession = (this.members.get(from) || {}).session;
    if (p.session && memberSession && p.session !== memberSession) return;

    const validDesc = d => d && typeof d === "object" &&
      (d.type === "offer" || d.type === "answer") &&
      typeof d.sdp === "string" && d.sdp.length < 20000;
    const validSid = s => typeof s === "string" && s.length > 0 && s.length <= 32;
    const me = this._myId();

    try {
      switch (p.type) {
        case "join": {
          // لاعب دخل الصوت (أو رجع): أي اتصال قديم معه ميّت
          // Broadcast join is only a discovery hint, never permission to tear down
          // a healthy encrypted session (duplicates and late broadcasts are normal).
          const old = this.peers.get(from);
          if (!old || this._st(old.pc) === "failed" || this._st(old.pc) === "closed") this._connectTo(from, true);
          break;
        }
        case "ready": {
          // الطرف الثاني يطلب عرض. بس المبادر (id أصغر) يرد
          if (me > from) return;
          const e = this.peers.get(from);
          if (e && ((p.have && p.have === e.sid) || Date.now() - e.createdAt < FRESH_MS)) return; // عنده الجلسة، أو لسا نتفاوض
          this._makeOffer(from, true);
          break;
        }
        case "offer": {
          if (!validSid(p.sid) || !validDesc(p.data) || p.data.type !== "offer") return;
          if (!this.peers.has(from) && this.peers.size >= VOICE_MAX - 1) return;
          const cur = this.peers.get(from);
          if (cur && cur.sid === p.sid) return;               // نفس العرض وصل مرتين
          // تعارض (كلنا أرسلنا عرض): صاحب الـ id الأصغر يتمسك بعرضه
          if (cur && cur.initiator && me < from && cur.pc.signalingState === "have-local-offer") return;
          const e = this._peer(from, p.sid);                  // يقفل القديم
          if (!e) return;
          e.initiator = false;
          if (p.session) e.session = p.session;
          // مرشحات ICE اللي وصلت قبل العرض
          (this.earlyIce.get(from) || []).filter(x => x.sid === p.sid).forEach(x => e.pending.push(...x.cands));
          this.earlyIce.delete(from);
          await e.pc.setRemoteDescription(p.data);
          if (!this._alive(e, token)) return;
          await this._flush(e);
          if (!this._alive(e, token)) return;
          const answer = await e.pc.createAnswer();
          if (!this._alive(e, token)) return;
          await e.pc.setLocalDescription(answer);
          if (!this._alive(e, token)) return;
          await this._publishDesc(e, "answer");
          break;
        }
        case "answer": {
          const e = this.peers.get(from);
          if (!e || !e.initiator || e.sid !== p.sid || !validDesc(p.data) || p.data.type !== "answer" || e.pc.signalingState !== "have-local-offer") return;
          await e.pc.setRemoteDescription(p.data);
          if (!this._alive(e, token)) return;
          await this._flush(e);
          break;
        }
        case "ice": {
          const src = Array.isArray(p.list) ? p.list : (p.data ? [p.data] : []);
          const cands = src.slice(0, 40)
            .filter(c => c && typeof c.candidate === "string" && c.candidate.length < 600)
            .map(c => ({
              candidate: c.candidate,
              sdpMid: typeof c.sdpMid === "string" ? c.sdpMid : "0",
              sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : 0,
            }));
          if (!cands.length || !validSid(p.sid)) return;
          const e = this.peers.get(from);
          if (!e || e.sid !== p.sid) { this._stashIce(from, p.sid, cands); return; } // قبل العرض: نحتفظ فيها
          if (e.pc.remoteDescription) {
            for (const c of cands) { try { await e.pc.addIceCandidate(c); } catch (er) { console.warn("[Voice] ice", er.message); } }
          } else e.pending.push(...cands);
          break;
        }
        case "leave": {
          const e = this.peers.get(from);
          if (e && (!p.sid || p.sid === e.sid)) this._closePeer(from);
          break;
        }
      }
    } catch (err) {
      console.warn("[Voice] negotiation error", p.type, err);
      // الـ watchdog يعيد المحاولة بعد تهدئة بدل ما نقفل ونتعلق
      const e = this.peers.get(from);
      if (e && (p.type === "offer" || p.type === "answer")) this._closePeer(from);
    }
  },

  /* ---- Presence ---- */
  onPresence(state) {
    const previous = this.members;
    this.members = new Map();
    Object.entries(state || {}).forEach(([id, metas]) => {
      // Multiple tabs may share a player id; a non-voice tab must not mask voice.
      const live = Array.isArray(metas) ? metas.filter(m => m && m.voice) : [];
      const m = live[live.length - 1];
      if (m) this.members.set(id, { muted: !!m.muted, session: typeof m.voiceSession === "string" ? m.voiceSession : null });
    });
    this.members.forEach((m, id) => {
      const e = this.peers.get(id), old = previous.get(id);
      if (this.on && id !== this._myId() && e && m.session && e.session !== m.session && old && old.session && m.session !== old.session)
        this._rebuild(id, true);
    });
    this.updateUi();
  },

  /* ---- Watchdog كل ثانية ونص: يعيد أي اتصال مقطوع أو معلّق ---- */
  _watchdog() {
    if (!this.on) return;
    const now = Date.now(), me = this._myId();

    // TURN ما انحمّل (أو انتهت صلاحيته): نعيد المحاولة بالخلفية
    this.loadIce();
    
    // تحديث presence إذا كان متسخ أو مضى وقت طويل
    if (this._presenceDirty || now - this._presenceAt > 20000) this._track();
    
    // مراقبة المايك واسترجاعه عند الحاجة
    const mic = this.stream && this.stream.getAudioTracks()[0];
    if ((!mic || mic.readyState === "ended" || (mic.muted && now - this._lostAt > 6000)) &&
        document.visibilityState === "visible" && !this._recovering && now - this._recoverAt > 15000)
      this._recoverMic();
    
    // Keep established media alive while the signalling socket reconnects.
    if ((this._channel === this._ch() && this._channelStatus && this._channelStatus !== "SUBSCRIBED") || navigator.onLine === false) return;

    // مراقبة الاتصالات الموجودة
    [...this.peers].forEach(([id, e]) => {
      if (this.peers.get(id) !== e) return;
      
      // اللاعب خرج من الصوت
      if (!this.members.has(id)) {
        e.goneSince = e.goneSince || now;
        if (now - e.goneSince > 15000) this._closePeer(id);
        return;
      }
      e.goneSince = 0;
      
      const st = this._st(e.pc);
      
      // الاتصال متصل بنجاح
      if (st === "connected") {
        e.badSince = 0;
        
        // مراقبة جودة الاتصال من خلال WebRTC stats
        this._monitorConnectionQuality(id, e);
        
        // فحص الصوت: لو الـ audio موجود لكن paused أو muted بشكل غريب
        if (e.audio) {
          if (e.audio.muted) { e.audio.muted = false; e.audio.volume = 1; }
          if (e.audio.paused) this._play(e);
        }
        return;
      }
      
      // الاتصال فشل أو أغلق
      if (st === "failed" || st === "closed" || e.pc.signalingState === "closed") {
        this._rebuild(id);
        return;
      }
      
      // الاتصال منقطع مؤقتاً
      if (st === "disconnected") {
        e.badSince = e.badSince || now;
        if (now - e.badSince > DISCONNECT_MS) this._rebuild(id);
        return;
      }
      
      e.badSince = 0;
      
      // الاتصال معلّق (عرض/جواب ضاع)
      if (now - e.createdAt > NEGOTIATE_MS) {
        console.warn("[Voice] negotiation stalled with", String(id).substring(0, 8));
        this._rebuild(id);
      }
    });

    // اتصل باللاعبين الجدد في الصوت
    this.members.forEach((m, id) => {
      if (id === me || this.peers.has(id)) return;
      // إذا ما حاولنا أصلاً أو مضت فترة كافية: حاول بـ urgent
      const a = this.attempts.get(id) || { t: 0, n: 0 };
      const wait = Math.min(2500 * (a.n + 1), 10000);
      if (now - a.t >= wait) this._connectTo(id, true);
    });
  },
  
  // مراقبة جودة الاتصال باستخدام فرق العدادات بين عينتين، وليس النسبة التراكمية
  // طوال المكالمة. فقد الحزم وحده لا يبرر هدم اتصال WebRTC وإعادة التفاوض.
  async _monitorConnectionQuality(id, entry) {
    try {
      if (!entry || !entry.pc || this.peers.get(id) !== entry) return;
      const stats = await entry.pc.getStats();
      if (this.peers.get(id) !== entry) return;
      let inbound = null;
      for (const report of stats.values()) {
        if (report.type === "inbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) {
          inbound = report;
          break;
        }
      }
      if (!inbound) return;

      const lost = Math.max(0, Number(inbound.packetsLost) || 0);
      const received = Math.max(0, Number(inbound.packetsReceived) || 0);
      const previous = entry.qualityStats;
      entry.qualityStats = { lost, received };
      if (!previous || lost < previous.lost || received < previous.received) return;

      const deltaLost = lost - previous.lost;
      const deltaReceived = received - previous.received;
      const total = deltaLost + deltaReceived;
      if (total < 20) return;

      const lossRate = (deltaLost / total) * 100;
      if (lossRate >= 5 && !entry.warnedQuality) {
        console.warn(`[Voice] Packet loss with ${String(id).substring(0, 8)}: ${lossRate.toFixed(1)}% over the latest sample`);
        entry.warnedQuality = true;
      } else if (lossRate < 3) {
        entry.warnedQuality = false;
      }
    } catch (e) {
      // A transient stats failure must not interrupt the voice watchdog.
    }
  },

  /* ---- مؤشر الكلام ---- */
  _startMeters() {
    this._resumeAC();
    clearInterval(this.meterTimer);
    this.meterTimer = setInterval(() => this._tickMeters(), 100);
  },

  _stopMeters() {
    clearInterval(this.meterTimer); this.meterTimer = null;
    [...this.meters.keys()].forEach(id => this._rmMeter(id));
    document.querySelectorAll(".av.speaking").forEach(e => e.classList.remove("speaking"));
    const f = document.getElementById("voiceFab"); if (f) f.classList.remove("talking");
    if (this.meterCtx && this.meterCtx.state !== "closed") {
      const ctx = this.meterCtx; this.meterCtx = null; ctx.close().catch(() => {});
    } else this.meterCtx = null;
  },

  _addMeter(id, stream) {
    this._rmMeter(id);
    const m = { src: null, an: null, silent: null, buf: null, level: 0 };
    const ctx = this._getAC();
    if (ctx && ctx.state !== "closed") {
      try {
        m.src = ctx.createMediaStreamSource(stream);
        m.an = ctx.createAnalyser(); m.an.fftSize = 256;
        m.src.connect(m.an);
        // Keep the graph rendering on WebKit without ever monitoring our own mic.
        m.silent = ctx.createGain(); m.silent.gain.value = 0;
        m.an.connect(m.silent); m.silent.connect(ctx.destination);
        m.buf = new Uint8Array(m.an.fftSize);
      } catch (e) { console.warn("[Voice] meter", e); m.src = m.an = m.buf = null; }
      if (ctx.state !== "running") ctx.resume().catch(() => {});
    }
    // بدون AudioContext شغّال نقرأ مستوى الصوت من WebRTC نفسه (للآخرين فقط)
    this.meters.set(id, m);
  },

  _rmMeter(id) {
    const m = this.meters.get(id);
    if (m) {
      try { m.src && m.src.disconnect(); } catch {}
      try { m.an && m.an.disconnect(); } catch {}
      try { m.silent && m.silent.disconnect(); } catch {}
      this.meters.delete(id);
    }
    _setSpeaking(id, false);
  },

  _rtpLevel(entry) {
    try {
      const r = entry.pc.getReceivers().find(x => x.track && x.track.kind === "audio");
      if (!r || typeof r.getSynchronizationSources !== "function") return null;
      const s = r.getSynchronizationSources();
      return s.length ? (s[0].audioLevel || 0) : 0;
    } catch { return null; }
  },

  _tickMeters() {
    const ctx = this.meterCtx;
    // iOS/الخلفية: السياق يوقف نفسه، نحاول نشغله (بحارس عشان ما تتراكم الوعود)
    if (ctx && ctx.state !== "running" && ctx.state !== "closed" && !this._resumePending) {
      this._resumePending = true;
      ctx.resume().catch(() => {}).finally(() => { this._resumePending = false; });
    }
    const running = !!ctx && ctx.state === "running";
    const me = this._myId();
    this.meters.forEach((m, id) => {
      let lvlA = null, lvlR = null, dead = false;
      if (running && m.an && m.buf) {
        m.an.getByteTimeDomainData(m.buf);
        let sum = 0, mx = 0;
        for (let i = 0; i < m.buf.length; i++) {
          const d = m.buf[i] - 128; const v = d / 128;
          sum += v * v; if (d < 0 ? -d > mx : d > mx) mx = d < 0 ? -d : d;
        }
        m.level = m.level * 0.7 + Math.sqrt(sum / m.buf.length) * 0.3;
        lvlA = m.level; dead = mx === 0;
      }
      if (id !== me) {
        // الآخرين: نقرأ من WebRTC نفسه كمان، لأن تحليل الصوت البعيد يطلع صفر ببعض متصفحات كروم/سفاري
        const e = this.peers.get(id);
        const l = e && this._rtpLevel(e);
        if (l != null) { m.rtp = (m.rtp || 0) * 0.6 + l * 0.4; lvlR = m.rtp; }
      } else if (running && !this.muted && !this.micLost && !this._deadWarned) {
        // مايكي صامت تماماً (صفر رقمي) لفترة طويلة = غالباً مكتوم من النظام/الجهاز
        if (!dead) this._deadSince = 0;
        else if (!this._deadSince) this._deadSince = Date.now();
        else if (Date.now() - this._deadSince > SILENT_MIC_MS) {
          this._deadWarned = true;
          toast("ما نلتقط أي صوت من مايكك 🎙️\nلو الناس ما يسمعونك: تأكد أنه مو مكتوم من إعدادات الجهاز أو السماعة.", 7000);
        }
      }
      if (lvlA === null && lvlR === null) return;
      const loud = (lvlA !== null && lvlA > 0.03) || (lvlR !== null && lvlR > 0.02);
      const talking = loud && !(id === me && (this.muted || this.micLost)) && !(this.members.get(id) || {}).muted;
      _setSpeaking(id, talking);
    });
  },

  /* ---- واجهة المستخدم ---- */
  _mkAudioBox() {
    let box = document.getElementById("voiceAudio");
    if (box) return box;
    box = document.createElement("div");
    box.id = "voiceAudio";
    box.setAttribute("aria-hidden", "true");
    // لا نخفيه بـ display:none/opacity:0 عشان بعض المتصفحات تمنع الصوت من العناصر المخفية
    Object.assign(box.style, {
      position: "fixed", width: "1px", height: "1px", overflow: "hidden",
      left: "-9999px", top: "-9999px", pointerEvents: "none"
    });
    document.body.appendChild(box);
    return box;
  },

  ensureUi() {
    this._mkAudioBox();
    if (document.getElementById("voiceFab")) { this.updateUi(); return; }

    const mk = (id, cls, label, text) => {
      const b = document.createElement("button");
      b.id = id; b.className = cls; b.dataset.quiet = "1";
      b.setAttribute("aria-label", label);
      b.textContent = text;
      return b;
    };
    const fab = mk("voiceFab", "voice-fab", "ادخل الصوت", "");
    fab.innerHTML = `<span class="voice-ico">🎙️</span><span class="unread voice-count" id="voiceCount"></span>`;
    const leave   = mk("voiceLeave",   "voice-leave",   "اطلع من الصوت", "📞");
    const speaker = mk("voiceSpeaker", "voice-speaker", "فعّل سماع الأصوات", "🔊");
    const diag    = mk("voiceDiag",    "voice-diag",    "تشخيص الصوت", "🔍");
    document.body.append(fab, leave, speaker, diag);

    fab.addEventListener("click", () => { if (this.on) this.toggleMute(); else this.join(); });
    leave.addEventListener("click", () => this.leave());
    speaker.addEventListener("click", () => this.unlockAudio());
    diag.addEventListener("click", () => this._showDiag());

    this.updateUi();
  },

  _diagText() {
    const L = [];
    L.push(`on=${this.on} muted=${this.muted} joining=${this.joining} micLost=${this.micLost}`);
    L.push(`https=${window.isSecureContext} gUM=${!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)} rtc=${!!(window.RTCPeerConnection || window.webkitRTCPeerConnection)} inApp=${this._inApp()}`);
    const t = this.stream && this.stream.getAudioTracks()[0];
    L.push(t ? `mic: ${t.label || "?"} | ${t.readyState} | enabled=${t.enabled} | muted=${t.muted}` : "mic: none");
    L.push(`audioCtx=${this.meterCtx ? this.meterCtx.state : "none"} playbackBlocked=${this.playbackBlocked}`);
    L.push(`turn=${this.turnOk ? "credentials-loaded (relay not yet verified)" : "unavailable: restricted networks may fail"} iceServers=${this.iceServers.length}`);
    L.push(`signalling=${this._channelStatus || "unknown"} presencePending=${this._presenceDirty} recovery=${this._recovering}`);
    L.push(`channel=${!!this._ch()} room=${!!this._room()} me=${String(this._myId() || "?").substring(0, 8)}`);
    if (this.lastError) L.push(`lastError=${this.lastError}`);
    this.peers.forEach((e, id) => {
      const a = e.audio ? (e.audio.paused ? "paused" : "playing") : "none";
      L.push(`peer ${id.substring(0, 8)}: ${this._st(e.pc)} ice=${e.pc.iceConnectionState} sig=${e.pc.signalingState} route=${e.route || "-"} audio=${a} ${e.initiator ? "(offerer)" : "(answerer)"}`);
    });
    this.members.forEach((m, id) => {
      if (id !== this._myId()) L.push(`member ${id.substring(0, 8)}: muted=${m.muted} connected=${this.peers.has(id) && this._st(this.peers.get(id).pc) === "connected"}`);
    });
    return L.join("\n");
  },

  _showDiag() {
    let panel = document.getElementById("voiceDiagPanel");
    if (panel) panel.remove();
    const text = this._diagText();
    panel = document.createElement("div");
    panel.id = "voiceDiagPanel"; panel.className = "voice-diag-panel";
    const pre = document.createElement("pre"); pre.textContent = text;
    const row = document.createElement("div"); row.className = "row";
    const copy = document.createElement("button"); copy.textContent = "نسخ"; copy.dataset.quiet = "1";
    const close = document.createElement("button"); close.textContent = "إغلاق"; close.dataset.quiet = "1";
    copy.onclick = () => { if (typeof copyText === "function") copyText(text, "تم النسخ"); };
    close.onclick = () => panel.remove();
    const retry = document.createElement("button"); retry.textContent = "إعادة تشغيل المايك"; retry.dataset.quiet = "1";
    retry.disabled = !this.on;
    retry.onclick = async () => { retry.disabled = true; await this._recoverMic(); retry.disabled = !this.on; pre.textContent = this._diagText(); };
    row.append(retry, copy, close);
    panel.append(pre, row);
    const micLabel = document.createElement("label"); micLabel.textContent = "الميكروفون ";
    const select = document.createElement("select"); select.setAttribute("aria-label", "اختيار الميكروفون");
    select.append(new Option("الافتراضي (النظام)", "")); micLabel.append(select); panel.append(micLabel);
    select.disabled = !this.on;
    select.onchange = async () => {
      this.selectedMic = select.value; select.disabled = true;
      await this._recoverMic(this.selectedMic);
      select.value = this.selectedMic; select.disabled = !this.on; pre.textContent = this._diagText();
    };
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices)
      navigator.mediaDevices.enumerateDevices().then(devices => {
        if (!panel.isConnected) return;
        devices.filter(d => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default")
          .forEach((d, i) => select.append(new Option(d.label || `مايك ${i + 1}`, d.deviceId)));
        select.value = this.selectedMic;
      }).catch(() => {});
    document.body.appendChild(panel);
  },

  removeUi() {
    ["voiceFab", "voiceLeave", "voiceSpeaker", "voiceDiag", "voiceDiagPanel", "voiceAudio"].forEach(id => {
      const e = document.getElementById(id); if (e) e.remove();
    });
  },

  updateUi() {
    const fab     = document.getElementById("voiceFab");
    const leave   = document.getElementById("voiceLeave");
    const speaker = document.getElementById("voiceSpeaker");
    const diag    = document.getElementById("voiceDiag");
    const count   = document.getElementById("voiceCount");
    if (!fab) return;
    fab.classList.toggle("in",      this.on);
    fab.classList.toggle("muted",   this.on && this.muted);
    fab.classList.toggle("joining", this.joining);
    fab.classList.toggle("lost",    this.on && this.micLost);
    fab.querySelector(".voice-ico").textContent =
      this.joining ? "⏳" : !this.on ? "🎙️" : this.micLost ? "⚠️" : this.muted ? "🔇" : "🎤";
    fab.setAttribute("aria-label",
      this.joining ? "إلغاء الدخول" : !this.on ? "ادخل الصوت" : this.muted ? "شغّل صوتك" : "اكتم صوتك");
    if (leave) leave.classList.toggle("show", this.on);
    if (speaker) {
      speaker.classList.toggle("show", this.on);
      speaker.classList.toggle("needs-unlock", this.on && this.playbackBlocked);   // برتقالي ينبض فقط لو فعلاً ممنوع
      speaker.setAttribute("aria-label", this.playbackBlocked ? "اضغط هنا لسماع الأصوات" : "فعّل سماع الأصوات");
    }
    if (diag) diag.classList.toggle("show", this.on || this.joining || !!this.lastError);
    if (count) {
      const n = this.members.size;
      count.textContent = n;
      count.classList.toggle("show", n > 0);
    }
  }
};

/* ---- رجوع للتبويب / أي ضغطة بالصفحة: شغّل الصوت اللي منعه المتصفح واستأنف السياق ---- */
if (!window.__jVoiceHooks) {
  window.__jVoiceHooks = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !Voice.on) return;
    Voice.retryPlayback();
    Voice._wakeLock(true);   // القفل يتحرر لما الصفحة تنخفي، نعيد طلبه
    const t = Voice.stream && Voice.stream.getAudioTracks()[0];
    if (t && t.readyState === "ended") Voice._micEnded(Voice.stream);
  });
  ["pointerdown", "touchend", "click", "keydown"].forEach(ev =>
    document.addEventListener(ev, () => { if (Voice.on && Voice.playbackBlocked) Voice.retryPlayback(true); }, { capture: true, passive: true }));

  // الشبكة: رجع النت / تبدّل واي فاي ↔ بيانات
  window.addEventListener("online", () => Voice.onNetBack());
  try {
    const c = navigator.connection;
    if (c && c.addEventListener) c.addEventListener("change", () => Voice.onNetBack());
  } catch {}

  // الأجهزة: سحب/توصيل سماعة أو مايك
  try {
    const md = navigator.mediaDevices;
    if (md && md.addEventListener) md.addEventListener("devicechange", () => Voice._onDeviceChange());
  } catch {}

  // قفل الصفحة/إغلاقها: نحرر المايك فوراً (يطفي مؤشر المايك بالجهاز)
  window.addEventListener("pagehide", () => {
    if (Voice.on || Voice.joining || Voice.stream) Voice.leave(true);
  });
  // رجوع من bfcache: نحدّث حالتنا عند الآخرين
  window.addEventListener("pageshow", e => { if (e.persisted) Voice._track(); });
}

/* ---- دوال مساعدة عامة ---- */
function _setSpeaking(id, on) {
  document.querySelectorAll(`.av[data-k="${CSS.escape(id)}"]`).forEach(e => e.classList.toggle("speaking", on));
  const mine = (typeof Voice !== "undefined" ? Voice._myId() : null)
            || (() => { try { return localStorage.getItem("bara_pid"); } catch { return null; } })();
  if (id === mine) {
    const f = document.getElementById("voiceFab");
    if (f) f.classList.toggle("talking", on);
  }
}

// للتوافق مع الكود القديم
function setSpeaking(id, on) { _setSpeaking(id, on); }

function voiceTag(id) {
  const m = Voice.members.get(id);
  return m ? `<span class="tag voice-tag">${m.muted ? "🔇" : "🎧"}</span>` : "";
}
