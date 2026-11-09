# 🕵️ مين برا السالفة؟

لعبة جماعية: كل اللاعبين يعرفون السالفة (كلمة سرية) إلا واحد "برا السالفة". تسألون بعض، وتصوّتون مين اللي برا السالفة، وهو يحاول يخمّن السالفة.

**العب الحين:** https://mtq974410-svg.github.io/mn-bara-alsalfa/

## طرق اللعب

- **🌐 أونلاين:** واحد يسوي غرفة ويرسل الرابط أو الكود (6 أرقام)، وكل لاعب يدخل من جواله. فيه دردشة داخل الغرفة للأسئلة.
- **📱 جوال واحد:** الجوال يتمرر بين اللاعبين.

## ملاحظات تقنية

- صفحة ثابتة بدون أدوات بناء: `index.html` و`css/` و`js/`.
- الغرف تشتغل عبر Supabase Realtime (Broadcast + Presence) بدون جداول. جوال صاحب الغرفة يحتفظ بحالة اللعبة ويرسلها للباقين، ويحفظها في المتصفح عشان يكمل لو سوّى تحديث للصفحة.
- مفتاح Supabase الموجود في `js/online.js` هو مفتاح publishable، ومصمم يكون ظاهر في كود المتصفح.
- **🎙️ الصوت:** مكالمة صوتية جماعية (WebRTC) داخل الغرفة، الصوت يمر مباشرة بين اللاعبين ومعها TURN احتياطي. لو المايك ما اشتغل: لازم رابط `https`، ومتصفحات التطبيقات (انستغرام، سناب...) ما تدعم المايك فافتح الرابط في Safari أو Chrome. للتشخيص افتح `test-voice.html` أو اضغط زر 🔍 جنب أزرار الصوت داخل الغرفة.
  - إذا انقطع المايك (سماعة انسحبت، بلوتوث، مكالمة) تحاول اللعبة ترجّعه تلقائياً وتبدّله داخل الاتصالات بدون ما يطلع اللاعب من الصوت.
  - تحاول اللعبة منع انطفاء الشاشة (Wake Lock عند توفره)، واستعادة الصوت بعد المكالمات وتغير الشبكة. المتصفح ونظام الجوال قد يوقفان المايك في الخلفية؛ لا يمكن ضمان استمرار المكالمة والشاشة مقفلة.
  - رسائل الإذن مخصصة لكل جهاز (iPhone / Android / كمبيوتر / متصفحات التطبيقات).
  - `test-voice.html` فيه الحين اختبار اتصال WebRTC محلي واختبار سماعة وعرض أجهزة الصوت.
- `js/data.js` فيه التصنيفات والكلمات والإيموجي، و`js/fx.js` فيه الأصوات والأنيميشن.

## الحماية

الغرف الأونلاين مشفرة وموقّعة، والأدوار سرية لكل لاعب. التفاصيل وحدود الحماية في [SECURITY.md](SECURITY.md).

## Voice reliability update — deployment and verification

Replace the existing site files with this folder's contents, including `index.html`, both online game scripts, `js/voice.js`, and `test-voice.html`. No build step is required. Asset versions are currently set to `v=32` to avoid old cached JavaScript. Deploy over HTTPS, have **all players reload**, and create a new room for the first verification. This ZIP is source code, not an already-deployed update to your live site.

This update adds generation-safe microphone recovery and signalling, serialized/retried presence, acknowledged RTC broadcasts, per-participant autoplay handling, microphone selection/manual restart in the 🔍 panel, and cleanup of obsolete captures. Existing connected media is retained during temporary signalling outages. A failed mic recovery does not eject the listener. The diagnostics page now checks connected ICE plus received RTP and offers a separate relay-allocation test; obtaining TURN credentials alone is not labelled a successful relay connection.

### Automated checks

The included `tests/voice-browser.test.cjs` uses three separate Chromium browser contexts with simulated microphones, **real WebRTC audio RTP and WebCrypto**, and a local mocked signalling service. It also tests both game-mode channel integrations and the shipped diagnostic page. See `tests/voice-test-results.json` for the executed results.

To rerun on a development machine with Node.js:

```sh
npm install --no-save playwright
npx playwright install chromium
# On Linux, if browser libraries are missing: npx playwright install-deps chromium
node tests/voice-browser.test.cjs
```

The test starts and stops its own local HTTP server. It does not use the production Supabase or Metered accounts. Do not deploy `node_modules`; the static game does not require it.

### Required live acceptance check

Automated checks do **not** verify iPhone/Android hardware, Bluetooth routing, audible speaker output, mobile background restrictions, your deployed Supabase limits, or the availability/quota of your TURN account. Before calling the deployment production-ready, use two real devices: one on Wi-Fi and one on mobile data. Test both game modes, mic permission denial/retry, mute/unmute, leave/rejoin, headset unplug/replug, a network switch, and returning from the background. Test speaker playback using a user tap if the browser requests it. Use headphones to limit acoustic feedback.

On the deployed `test-voice.html`, run the TURN test. A `relay` candidate verifies allocation with the service, not end-to-end audio across two networks. Real cross-network calls remain the final check. If TURN is unavailable, STUN-only connections can fail on restrictive networks; client-side code cannot repair an expired account, exhausted relay quota, or a firewall blocking every permitted route.

### TURN credentials and production hardening

The archive already included a browser-visible Metered credential API key. This update retains that integration for compatibility; its validity has **not** been checked against the provider account. Rotate/manage that key through the provider dashboard and do not treat it as a secret when embedded in JavaScript. For production, prefer a rate-limited server endpoint issuing short-lived TURN credentials. Set `window.JALSAH_VOICE_CONFIG = { turnEndpoint: "/api/turn" };` in a same-origin external JavaScript file loaded before `voice.js`. The endpoint must return an `RTCIceServer[]` JSON array, with `urls`, `username`, and `credential` for TURN entries. This repository does not configure a Content-Security-Policy response header. If you add a strict CSP at the host, first move the diagnostic page's inline JavaScript and inline event handlers into an external script, then explicitly allow the app's Supabase Realtime and TURN endpoints in `connect-src`. Static GitHub Pages cannot host the TURN-credential backend by itself.

No solution can guarantee perfect voice chat on every device and network; this package fixes the identified code defects and includes reproducible tests and an honest acceptance checklist.

## 📋 مراجعة الكود (9 نوفمبر 2026)

تم تحديث هذا الإصدار بعد مراجعة جديدة لملفات الصوت وWebRTC والتشفير ومزامنة الغرف. راجع `CODE_REVIEW_REPORT.md` لمعرفة المشاكل التي تم تأكيدها وإصلاحها، وحدود الاختبارات التي لم يمكن تنفيذها داخل بيئة الفحص. الملاحظات القديمة في `FIXES_VOICE.md` و`FIXES_ONLINE.md` و`ACTION_PLAN.md` تاريخية وقد لا تطابق النسخة الحالية.

## الحقوق

جميع الحقوق محفوظة. ممنوع نسخ اللعبة أو نشرها أو تعديلها بدون إذن. التفاصيل في [LICENSE](LICENSE).
