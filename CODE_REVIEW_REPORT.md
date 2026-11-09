# jalsah-2 — Comprehensive Code Review & Fix Report

**Review date:** 9 November 2026  
**Review scope:** HTML/CSS/JavaScript source, WebRTC voice implementation, Supabase Realtime room transport, WebCrypto helpers, browser test harness, and deployment/security documentation.

## Executive summary

The supplied archive had a JavaScript parse error in the voice module and several confirmed lifecycle, delivery, and state-management defects. I corrected the identified source issues in this working copy and added a regression assertion for the shared-microphone lifecycle.

The most important fixes are:

1. Removed an orphaned duplicate watchdog fragment that made `js/voice.js` fail JavaScript parsing.
2. Prevented closing one WebRTC peer connection from stopping the shared microphone track used by every other participant.
3. Made audio playback recovery respect browser autoplay policy instead of repeatedly retrying blocked audio.
4. Checked Supabase Realtime broadcast acknowledgements, retried failed room-state sends, and made room listeners reject stale-channel work.
5. Fixed round-change handling in **مين الأطرش بالزفة؟** so a previous round's local answer is cleared.
6. Evicted failed WebCrypto promises and bounded cryptographic and rate-limit caches.
7. Handled suspended/interrupted Web Audio contexts without leaving rejected `resume()` promises unhandled.

This is a source-level correction, not a certification of the deployed service. The browser integration suite could not execute in this environment because Chromium navigation to the local test server was blocked before the assertions ran. Production Supabase, the Metered account, and real iOS/Android devices were not contacted or tested.

## Confirmed defects fixed

### 1. `js/voice.js` — parse error in the watchdog section

**Original problem:** The supplied file contained a duplicated tail of the watchdog loop after the `Voice` object had already ended. The orphaned statements caused a syntax error (reported at approximately line 1304 in the supplied copy), so the browser could not load the voice module.

**Fix applied:** Removed the stray duplicate statements. The watchdog loop now exists only within the `Voice` object. The corrected file passes `node --check`, both alone and in the combined classic-script load order.

### 2. `js/voice.js` — one participant could kill everyone's microphone

**Original problem:** `Voice._closePeer()` stopped tracks returned by `RTCPeerConnection.getSenders()`. The local microphone stream is shared by all peer connections, so stopping a sender track while rebuilding or removing one participant's connection also stopped the microphone being sent to every other participant.

**Fix applied:** `_closePeer()` now closes only that peer connection, stops its remote receiver tracks, removes its event handlers and audio element, and leaves shared local sender tracks running. The shared microphone is stopped by the overall voice-leave/cancel lifecycle instead. A regression assertion was added to `tests/voice-browser.test.cjs` to check that closing one peer leaves the shared microphone live for the remaining mesh connections.

**Location:** `js/voice.js`, `_closePeer()` (approximately lines 766–812).

### 3. `js/voice.js` — autoplay-blocked audio was retried as if it were a network failure

**Original problem:** Browser autoplay policy can reject `HTMLMediaElement.play()` with `NotAllowedError`. Repeated watchdog, pause, and timer callbacks could keep trying to play the same blocked element, while a successful participant could hide another participant's playback-blocked status.

**Fix applied:** Playback state is tracked per peer. `_play()` stops retrying a peer marked as blocked; only a real user gesture clears that peer's block. The speaker control and page interaction listeners provide that gesture-driven retry. The aggregate warning remains visible while any participant is still blocked.

**Location:** `js/voice.js`, `unlockAudio()`, `retryPlayback()`, and `_play()` (approximately lines 399–454).

### 4. `js/voice.js` — cumulative packet-loss statistics could trigger needless reconnections

**Original problem:** A lifetime cumulative `packetsLost / packetsReceived` ratio can remain high even after a connection has recovered. Using it to make connection decisions can tear down a healthy WebRTC connection and cause avoidable renegotiation.

**Fix applied:** The quality monitor compares deltas between consecutive RTP-stat samples. Packet loss now produces a warning; actual connection and ICE state plus the watchdog decide whether a peer needs rebuilding. A transient `getStats()` failure is isolated and does not interrupt the watchdog.

**Location:** `js/voice.js`, `_monitorConnectionQuality()` (approximately lines 1262–1299).

### 5. `js/fx.js` — unhandled `AudioContext.resume()` rejection

**Original problem:** `AudioEngine.init()` called `resume()` on a suspended audio context without consuming the returned Promise. Autoplay restrictions or browser interruption can reject that Promise and cause an unhandled rejection.

**Fix applied:** The engine now attempts to resume any non-running, non-closed context and consumes resume failures. If a context has been closed, the engine clears its stale node references and can create a fresh context on the next user interaction.

**Location:** `js/fx.js`, `AudioEngine.init()` (approximately lines 87–100).

### 6. `js/online.js` and `js/atarsh_online.js` — Realtime send results were not treated as delivery failures

**Original problem:** Room state, join, and action broadcasts were sent without consistently checking the acknowledgement returned by Supabase Realtime. A resolved call is not necessarily a successful broadcast: Realtime can return statuses such as `error` or `timed out`.

**Fix applied:** Added the shared `sendRealtimeBroadcast()` helper, which awaits the send and throws unless the status is `ok`. Important join/action/state/close broadcasts now use it. Host state broadcasting is serialized and retries failed sends with a bounded backoff (up to three retries), while later commits can still mark the state dirty so the latest room snapshot is sent after the in-flight operation.

**Locations:** `js/online.js`, helper and state send path (approximately lines 40–45 and 559–596); `js/atarsh_online.js`, corresponding state send path (approximately lines 328–367).

### 7. `js/online.js` and `js/atarsh_online.js` — stale room channels could process late callbacks

**Original problem:** An asynchronous decrypt/verify or a queued broadcast callback could finish after the player had left a room or connected to another room. Without checking the channel and room generation again, late work could affect the newly active room.

**Fix applied:** State and action callbacks capture their source channel. Queued handlers and asynchronous receive paths re-check that the captured channel is still the active channel and that the room code/reference has not changed after asynchronous cryptographic work. Old `removeChannel()` Promises are consumed with error handling instead of being left floating.

**Locations:** `js/online.js`, `connect()`, callback registration, `leaveChannel()`, `receiveEnvelope()`, and `hostReceive()`; matching paths in `js/atarsh_online.js`.

### 8. Room join retries could stop too early or be silently lost

**Original problem:** The join path had a fixed retry-attempt limit, and callers did not consistently await or inspect the delivery result. A temporary network failure could leave a player on the connecting screen even while the retry timer appeared active.

**Fix applied:** Join requests are asynchronous, throttled, delivery-checked, and retried by the existing join interval while the player remains outside the room. The arbitrary small attempt cap was removed; the existing 30-second connection timeout remains the final failure boundary. Both games now use the same strategy.

**Locations:** `js/online.js`, `sendJoin()` (approximately lines 389–413); `js/atarsh_online.js`, `atSendJoin()` (approximately lines 262–285).

### 9. Incoming room envelopes needed stricter validation and safer sequence advancement

**Original problem:** A malformed or stale signed/encrypted envelope could consume sequence state before the room payload had been decrypted and validated. That could prevent a later valid state from being accepted. Old timestamps and invalid action counters also needed explicit rejection.

**Fix applied:** Both game modes validate the room code, protocol version, public-key shape, host identifier, safe-integer sequence, and timestamp window. The signature is checked before state is trusted. Encrypted room state is decrypted and validated before advancing the accepted sequence; channel identity is re-checked after every asynchronous boundary. Encrypted host actions also require a safe non-negative action counter.

**Locations:** `js/online.js`, `receiveEnvelope()` and `hostReceive()` (approximately lines 426–476 and 610–635); `js/atarsh_online.js`, `atReceiveEnvelope()` and `atHostReceive()` (approximately lines 380–435 and 488–513).

### 10. Newcomer rate limiting could penalize unrelated players and retain oversized buckets

**Original problem:** A shared join-rate bucket allowed one noisy newcomer to consume the same allowance used by all other joiners. Rate buckets also continued appending timestamps after a sender was already blocked.

**Fix applied:** New join attempts are limited per sender, with a separate generous global ceiling on newcomer crypto work. Rate maps are bounded and old entries are evicted; once a sender reaches the limit, further blocked attempts do not keep growing the timestamp list. Chat activity maps are also bounded.

**Locations:** `js/online.js`, `rateOk()` and `hostReceive()` (approximately lines 598–635); `js/atarsh_online.js`, `atRateOk()` and `atHostReceive()` (approximately lines 68–76 and 488–510).

### 11. `js/atarsh_online.js` — previous round number was read after replacing the room state

**Original problem:** `atReceiveState()` assigned `AtOn.room = r` and then read the previous round number from `AtOn.room`. At that point the old value was already lost, making the old and new round numbers identical. `AtOn.myAnswer` could therefore survive into a new round and appear as a stale answer.

**Fix applied:** Capture the previous round number before replacing `AtOn.room`, then clear `AtOn.myAnswer` when the round number changes.

**Location:** `js/atarsh_online.js`, `atReceiveState()` (approximately lines 464–482).

### 12. `js/secure.js` — rejected WebCrypto promises could poison caches

**Original problem:** Key-import/derive Promises were cached. When a transient WebCrypto operation failed, a rejected Promise could remain cached, so later attempts reused the same failure rather than retrying the operation.

**Fix applied:** Failed pair-key, verification-key, and group-key operations now evict their exact failed Promise, allowing a later retry. The maps use bounded insertion-order caches (256 pair/verification entries and 64 group-key entries) to avoid unbounded growth across repeated rooms or hostile key traffic.

**Location:** `js/secure.js`, `pairKey()`, `verify()`, and `groupKey()` (approximately lines 26–33 and 68–120).

### 13. Voice UI cleanup left the hidden audio container behind

**Original problem:** The audio container was created dynamically, but the UI cleanup removed the visible controls without removing that container.

**Fix applied:** `Voice.removeUi()` now removes the hidden `voiceAudio` container as well as the voice controls.

**Location:** `js/voice.js`, `removeUi()` (approximately lines 1499–1503).

## Supabase and persistence architecture findings

The project uses **Supabase Realtime Broadcast and Presence**, not Supabase database tables, for online rooms. A source scan found no application calls to `.from(...)` or `.rpc(...)` for table/database operations. The host browser stores the authoritative room snapshot in its own local/session browser storage and broadcasts encrypted, signed snapshots to guests.

This has practical consequences:

- There is no server-side room record to restore if the host loses browser storage, clears site data, or permanently disappears.
- Guests do not have an independent authoritative copy from which a replacement host can safely resume the game.
- A browser that closes unexpectedly may remain in the roster as an offline player; presence indicates the connection state, but the game does not automatically kick the player. This avoids removing someone for a temporary network interruption, but a host may need to remove an abandoned player manually if the current game phase requires everyone to respond.
- There are no Supabase table queries or database writes to validate, so database schema, RLS policies, table permissions, backups, and database sync cannot be certified from this repository.

The app's Supabase publishable key is intentionally shipped in browser code. It is not a service-role secret. However, because browser code is public, outsiders can reuse it to consume Realtime quota. Monitor usage and configure project-level restrictions/rate controls where available.

## Security and deployment findings

### Metered TURN API credential is browser-visible

A Metered TURN API credential is embedded in both `js/voice.js` and `test-voice.html`. Anyone can inspect static site assets and reuse it. Treat that credential as exposed: rotate it in the Metered dashboard, then preferably replace the browser API-key flow with a rate-limited server endpoint that issues short-lived TURN credentials. The client already accepts `window.JALSAH_VOICE_CONFIG.turnEndpoint` for that purpose. A static GitHub Pages deployment cannot itself host that credential-issuing endpoint.

I have not printed the credential in this report and have not checked whether it is currently valid, active, or within quota.

### Content Security Policy is not configured in the repository

The source includes a JavaScript iframe/frame-busting fallback, but there is no hosting response header configuring `Content-Security-Policy`. The fallback is not a substitute for `frame-ancestors`. Configure CSP at the hosting/CDN layer. Before adopting a strict CSP, externalize the inline code and inline event handlers in `test-voice.html`, then explicitly allow the app's Supabase Realtime WebSocket/API and TURN endpoints in `connect-src`.

### Publishable keys are not secret keys

The Supabase browser key is a publishable key, which is expected for a browser application. No service-role key was identified in the application source. The TURN API key is different: it should not be left as a long-lived browser credential in a production public site.

## Validation performed

<badge color="success">Passed</badge> **Static validation**

- `node --check` passed for all application JavaScript files, the bundled Supabase JavaScript file, and both `.cjs` test files.
- A combined parse of the classic global scripts in their application load sequence passed.
- All local script and stylesheet references found in `index.html` resolved to files in the archive.
- Cache-busting query parameters in `index.html` consistently use `v=32`.
- The source scan found no application Supabase `.from(...)` table access or `.rpc(...)` calls.

<badge color="warning">Not run to completion</badge> **Browser integration validation**

The supplied Playwright test suite was prepared to run with real Chromium WebRTC/WebCrypto and a fake microphone, without contacting production Supabase or Metered services. The sandbox blocked Chromium navigation to the local test server with `ERR_BLOCKED_BY_ADMINISTRATOR` before the test assertions ran. Therefore the current `tests/voice-test-results.json` explicitly records `BLOCKED_BEFORE_TESTS` and an empty result list. This is an environment limitation, not a passing test run and not an application assertion failure.

No test in this review verified a real microphone, speaker output, Bluetooth route, background audio, real cross-network TURN relay, deployed Supabase account, Supabase quota/policies, or the Metered API account.

## Deployment checklist

1. Replace the deployed project files with the contents of this reviewed archive; do not copy only one changed JavaScript file. The project has no build step.
2. Deploy over HTTPS and have every player perform a hard reload. The application asset version is now `v=32`; create a fresh room for the first verification.
3. Rotate the exposed Metered credential. Configure a server-side, rate-limited TURN endpoint returning short-lived ICE credentials before treating the voice feature as production-hardened.
4. Configure host-level CSP and `frame-ancestors` policy. If using a strict CSP, first externalize inline JavaScript and event handlers in `test-voice.html` and allow the necessary Supabase and TURN connection origins.
5. Test the actual deployment using at least two devices on different networks (for example, Wi-Fi and mobile data). Exercise both game modes, voice join/leave/rejoin, mute/unmute, permission denial/recovery, headset unplug/replug, network switching, and return from background. Confirm actual audio in both directions.
6. In the deployed diagnostic page, confirm a selected ICE candidate of type `relay` during the TURN test. A fetched TURN credential alone does not prove that a relay path was allocated or that end-to-end audio works.

## Files changed

- `js/voice.js`
- `js/online.js`
- `js/atarsh_online.js`
- `js/secure.js`
- `js/fx.js`
- `index.html`
- `README.md`
- `SECURITY.md`
- `tests/voice-browser.test.cjs`
- `tests/voice-test-results.json`
- Historical-document notices added to `FIXES_VOICE.md`, `FIXES_ONLINE.md`, `IMPLEMENTED_FIXES.md`, and `ACTION_PLAN.md`.

## Final assessment

The archive now has corrected source for the confirmed defects described above and passes static JavaScript parsing. The biggest remaining risks are operational rather than fixable from browser code alone: host-local room persistence, the public TURN credential, missing host-level CSP, and the absence of successful real-browser/real-device/production-service verification. Do not treat this report as proof that every device, network, or production account will work until the deployment checklist has been completed.
