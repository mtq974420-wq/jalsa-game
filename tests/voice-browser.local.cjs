/* Run from project root: npm install --no-save playwright && npx playwright install chromium
   node tests/voice-browser.test.cjs
   No production Supabase/TURN services are contacted; real Chromium WebRTC and
   WebCrypto run between separate browser contexts over a local signalling relay. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const results = [];
let browser, server;
const peers = new Map(), presence = new Map();
const errors = [], relayErrors = [];
const harness = `<!doctype html><html><body><div id="log"></div><script>
const LS={get:k=>localStorage.getItem(k),set:(k,v)=>localStorage.setItem(k,v)};
function toast(){}; function copyText(){};
</script><script src="/js/secure.js"></script><script src="/js/voice.js"></script></body></html>`;
function ok(name, details = '') { results.push({name, status:'PASS', details}); console.log('PASS', name, details); }
async function wait(page, fn, timeout=15000) { await page.waitForFunction(fn, null, {timeout}); }
async function connected(ids) {
 for (const id of ids) await wait(peers.get(id), () => Voice.peers.size === 2 && [...Voice.peers.values()].every(e => Voice._st(e.pc)==='connected'), 22000);
}
function schedule(page, fn, data) { setImmediate(() => { if (!page.isClosed()) page.evaluate(fn,data).catch(e=>relayErrors.push(e.message)); }); }
async function newPeer(id) {
 const context = await browser.newContext({permissions:['microphone']});
 const page = await context.newPage();
 page.on('pageerror',e=>errors.push(`${id}: ${e.message}`));
 await page.exposeFunction('relay', async event => {
   if (event.kind==='track') {
     presence.set(id,event.meta);
     const state=Object.fromEntries([...presence].map(([key,meta])=>[key,[meta]]));
     for(const other of peers.values()) schedule(other,s=>Voice.onPresence(s),state);
   } else if (event.kind==='send') {
     const raw=event.packet.payload;
     for(const [otherId,other] of peers) if(otherId!==id && (!raw.to || raw.to===otherId))
       schedule(other,p=>{void Voice.onSignal(p);},raw);
   }
   return 'ok';
 });
 peers.set(id,page);
 await page.goto('http://127.0.0.1:'+server.address().port+'/__harness');
 await page.evaluate(async id => {
   await Sec.init(); window.testId=id;
   window.testRoom={players:[],waiting:[]};
   window.testChannel={track:meta=>relay({kind:'track',meta}),send:packet=>relay({kind:'send',packet})};
   Voice._myId=()=>testId; Voice._room=()=>testRoom; Voice._ch=()=>testChannel;
   Voice.iceServers=[]; Voice.turnOk=true; Voice.turnAt=Date.now();
   // Local ICE only: never contact the archive's production infrastructure.
   Voice.loadIce=async()=>{};
   Voice.ensureUi();
   Voice.onChannelStatus(testChannel,'SUBSCRIBED');
 },id);
 return page;
}
async function syncRoom() {
 const players=[];
 for(const [id,p] of peers) players.push({id,pk:await p.evaluate(()=>Sec.pubEcdh),name:id});
 for(const p of peers.values()) await p.evaluate(players=>{testRoom.players=players;},players);
}
async function run() {
 server=http.createServer((req,res)=>{
   if(req.url==='/__harness') {res.setHeader('Content-Type','text/html');res.end(harness);return;}
   let file=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));
   if(!file.startsWith(root+path.sep)) {res.writeHead(403).end();return;}
   if(fs.existsSync(file)&&fs.statSync(file).isFile()) {
     res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');
     res.end(fs.readFileSync(file));
   } else res.writeHead(404).end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const a=await newPeer('a'), b=await newPeer('b'), c=await newPeer('c');
 await syncRoom();
 for(const p of [a,b,c]) await p.evaluate(()=>Voice.join());
 await connected(['a','b','c']);
 ok('Three participants negotiate all six encrypted peer connections');
 const stats=await a.evaluate(async()=>{
   await new Promise(r=>setTimeout(r,1800));
   return Promise.all([...Voice.peers.values()].map(async e=>{
     const reports=await e.pc.getStats();
     return [...reports.values()].filter(s=>s.type==='inbound-rtp'&&s.kind==='audio').map(s=>({bytes:s.bytesReceived,packets:s.packetsReceived}));
   }));
 });
 assert(stats.flat().length===2 && stats.flat().every(s=>s.bytes>0&&s.packets>0));
 ok('Real audio RTP packets received from both remote participants',JSON.stringify(stats));
 await a.evaluate(()=>Voice.toggleMute());
 await wait(a,()=>Voice.muted&&!Voice.stream.getAudioTracks()[0].enabled);
 await wait(b,()=>Voice.members.get('a').muted===true);
 ok('Mute disables outgoing track and updates remote presence');
 const replaced=await a.evaluate(async()=>{
   const old=Voice.stream.getAudioTracks()[0];
   const pcs=[...Voice.peers.values()].map(e=>e.pc);
   const p1=Voice._recoverMic(),p2=Voice._recoverMic();
   const single=p1===p2;
   const recovered=await p1;
   return {single,recovered,stopped:old.readyState==='ended',muted:!Voice.stream.getAudioTracks()[0].enabled,
     intact:[...Voice.peers.values()].every((e,i)=>e.pc===pcs[i]&&e.sender.track===Voice.stream.getAudioTracks()[0])};
 });
 assert(Object.values(replaced).every(Boolean));
 ok('Concurrent recovery coalesces, replaces senders, stops old capture, preserves mute');
 await a.evaluate(()=>Voice.toggleMute());
 const sids=await a.evaluate(()=>[...Voice.peers.values()].map(e=>e.sid));
 await a.waitForTimeout(1800);
 await a.evaluate(()=>Voice.onSignal({from:'b',type:'join'}));
 assert.deepEqual(await a.evaluate(()=>[...Voice.peers.values()].map(e=>e.sid)),sids);
 ok('Duplicate or late discovery cannot tear down established audio');
 await b.evaluate(()=>Voice._rebuild('a',true));
 await connected(['a','b','c']);
 ok('Answerer-initiated reconnection rebuilds both sides');
 const session=await c.evaluate(()=>Voice.session);
 await c.evaluate(()=>Voice.leave());
 await wait(a,()=>!Voice.members.has('c'));
 await c.evaluate(()=>Voice.join());
 assert.notEqual(await c.evaluate(()=>Voice.session),session);
 await connected(['a','b','c']);
 ok('Leaving and rejoining creates a fresh voice generation');
 const stale=await a.evaluate(async()=>{
   const entry=Voice.peers.get('b'),sid=entry.sid;
   const key=await Sec.pairKey(Voice._pkOf('b'));
   const box=await Sec.seal(key,{type:'leave',sid,targetSession:'obsolete-generation',session:Voice.members.get('b').session});
   await Voice.onSignal({from:'b',to:'a',box});
   return Voice.peers.get('b')===entry;
 });
 assert(stale);ok('Encrypted stale-generation message is rejected');
 await a.evaluate(()=>{Voice._showDiag();});
 assert(await a.locator('#voiceDiagPanel select').count()===1);
 assert(await a.locator('#voiceDiagPanel select option').count()>=2);
 ok('In-game diagnostics enumerate selectable microphone devices');
 await a.evaluate(()=>{
   const entries=[...Voice.peers.values()];
   entries[0].playBlocked=true; entries[1].playBlocked=false; Voice._markBlocked();Voice._markPlaying();
 });
 assert(await a.evaluate(()=>Voice.playbackBlocked));
 await a.evaluate(()=>{Voice.peers.forEach(e=>{e.playBlocked=false;});Voice._markPlaying();});
 assert(!(await a.evaluate(()=>Voice.playbackBlocked)));
 ok('One playing peer cannot hide another peer autoplay block');
 const offline=await a.evaluate(()=>{
   const e=Voice.peers.get('b');e.goneSince=Date.now()-30000;
   const oldMembers=Voice.members;Voice.members=new Map();Voice.onChannelStatus(testChannel,'CHANNEL_ERROR');Voice._watchdog();
   const retained=Voice.peers.get('b')===e;
   Voice.members=oldMembers;Voice.onChannelStatus(testChannel,'SUBSCRIBED');return retained;
 });
 assert(offline);ok('Signalling outage retains established media');
 await connected(['a','b','c']);
 // Serial presence regression with a deliberately slow first write.
 const trackOrder=await a.evaluate(async()=>{
   await Voice._presenceChain;
   const orig=testChannel.track,seen=[];
   testChannel.track=async meta=>{await new Promise(r=>setTimeout(r,80));seen.push(meta.muted);return 'ok';};
   Voice.muted=false;const first=Voice._track();
   await new Promise(r=>setTimeout(r,10));Voice.muted=true;const last=Voice._track();
   await Promise.all([first,last]);testChannel.track=orig;
   Voice.muted=false;await Voice._track();return seen;
 });
 assert.deepEqual(trackOrder,[false,true]);ok('Presence writes preserve order under slow signalling');
 const multiple=await a.evaluate(()=>{
   Voice.onPresence({b:[{voice:true,muted:true},{voice:false,muted:false}]});
   return Voice.members.has('b')&&Voice.members.get('b').muted;
 });
 assert(multiple);ok('Non-voice duplicate tab does not hide active voice presence');
 await a.evaluate(()=>Voice._track());
 // Isolated race/error tests: these do not need the mesh to remain active.
 for(const p of [a,b,c]) await p.evaluate(()=>Voice.leave());
 const cancelled=await a.evaluate(async()=>{
   const original=Voice._getMic;let deliver;
   Voice._getMic=()=>new Promise(r=>{deliver=r;});
   const joining=Voice.join();Voice._cancelJoin();
   const late=await original.call(Voice);deliver(late);await joining;Voice._getMic=original;
   return !Voice.on&&!Voice.joining&&!Voice.stream&&late.getTracks().every(t=>t.readyState==='ended');
 });
 assert(cancelled);ok('Cancelled permission request stops a late arriving microphone');
 const changedRoom=await a.evaluate(async()=>{
   const original=Voice._getMic,oldChannel=testChannel;let deliver;
   Voice._getMic=()=>new Promise(r=>{deliver=r;});const joining=Voice.join();
   testChannel={...oldChannel};const late=await original.call(Voice);deliver(late);await joining;
   Voice._getMic=original;testChannel=oldChannel;
   return !Voice.on&&!Voice.joining&&late.getTracks().every(t=>t.readyState==='ended');
 });
 assert(changedRoom);ok('Changing rooms during permission prompt cannot activate wrong-room voice');
 const denied=await a.evaluate(async()=>{
   const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);let calls=0;
   navigator.mediaDevices.getUserMedia=async()=>{calls++;throw new DOMException('Blocked','NotAllowedError');};
   await Voice.join();navigator.mediaDevices.getUserMedia=original;
   return calls===1&&!Voice.on&&!Voice.joining&&Voice.lastError==='mic:NotAllowedError';
 });
 assert(denied);ok('Denied microphone permission fails cleanly without repeated prompts');
 await a.evaluate(()=>Voice.join());
 const failure=await a.evaluate(async()=>{
   const original=Voice._getMic;
   Voice._getMic=async()=>{throw new DOMException('Blocked','NotAllowedError');};
   const result=await Voice._recoverMic();Voice._getMic=original;
   return !result&&Voice.on&&Voice.stream.getAudioTracks()[0].readyState==='live';
 });
 assert(failure);ok('Failed recovery does not kick listener out of voice');
 const recoveryRace=await a.evaluate(async()=>{
   const original=Voice._getMic;let finishOld;
   Voice._getMic=()=>new Promise(r=>{finishOld=r;});const obsolete=Voice._recoverMic();
   Voice.leave();Voice._getMic=original;await Voice.join();const current=Voice.stream;
   const late=await original.call(Voice);finishOld(late);await obsolete;
   return Voice.on&&Voice.stream===current&&current.getAudioTracks()[0].readyState==='live'&&late.getTracks().every(t=>t.readyState==='ended');
 });
 assert(recoveryRace);ok('Late recovery cannot replace or stop microphone in a new call');
 const queued=await a.evaluate(async()=>{
   let release;const blocker=new Promise(r=>{release=r;});Voice.signalQueues.set('b',blocker);
   const original=Voice._handleSignal;let called=false;Voice._handleSignal=async()=>{called=true;};
   const pending=Voice.onSignal({from:'b',type:'join'});Voice.leave();await Voice.join();
   release();await pending;Voice._handleSignal=original;return !called;
 });
 assert(queued);ok('Old queued signalling is discarded after leave/rejoin');
 const detached=await a.evaluate(()=>{
   const tracks=Voice.stream.getTracks();Voice.leave();Voice.resetRoom();
   return tracks.every(t=>t.readyState==='ended')&&!Voice.stream&&Voice.peers.size===0&&Voice.members.size===0&&
    Voice.meters.size===0&&!Voice.watchTimer&&!Voice.meterTimer&&!Voice._recoverPromise;
 });
 assert(detached);ok('Leave and room reset release tracks, peers, timers, meters, and membership');
 // Full application smoke test: CSP, load order, and home screens.
 const smoke=await browser.newPage();smoke.on('pageerror',e=>errors.push('game: '+e.message));
 await smoke.route('https://**/*',r=>r.abort());
 await smoke.goto('http://127.0.0.1:'+server.address().port+'/index.html');
 await wait(smoke,()=>document.getElementById('app').textContent.length>10);
 assert(await smoke.evaluate(()=>typeof Voice==='object'&&typeof On==='object'&&typeof AtOn==='object'));
 ok('Complete application loads under its Content Security Policy');
 const integrations=await smoke.evaluate(async()=>{
   await Sec.init();Voice.loadIce=async()=>{};
   const channels=[];
   const client={channel:(name,options)=>{
     const ch={name,options,handlers:[],meta:null,
       on(type,filter,cb){this.handlers.push({type,event:filter.event,cb});return this;},
       subscribe(cb){this.status=cb;return this;},
       async track(meta){this.meta=meta;return 'ok';},async send(){return 'ok';},
       presenceState(){return this.state||{};}};
     channels.push(ch);return ch;
   },async removeChannel(){return 'ok';}};
   On.sb=client;On.isHost=false;connect('123456');
   const first=On.ch;await first.status('SUBSCRIBED');
   const firstReady=Voice._channel===first&&first.meta.voice===false&&first.options.config.broadcast.ack===true;
   await first.status('CHANNEL_ERROR');const detectsError=Voice._channelStatus==='CHANNEL_ERROR';
   leaveChannel();
   first.state={ghost:[{voice:true}]};first.handlers.find(h=>h.type==='presence').cb();
   const staleIgnored=Voice.members.size===0;
   AtOn.isHost=false;atConnect('654321');
   const second=AtOn.ch;await second.status('SUBSCRIBED');
   const secondReady=Voice._channel===second&&second.meta.voice===false&&second.options.config.broadcast.ack===true;
   await second.status('TIMED_OUT');const detectsTimeout=Voice._channelStatus==='TIMED_OUT';
   leaveAtChannel();return {firstReady,detectsError,staleIgnored,secondReady,detectsTimeout};
 });
 assert(Object.values(integrations).every(Boolean));
 ok('Both game modes integrate acknowledged signalling, reconnect status, and stale-channel guards');
 // The shipped diagnostic page must verify connected ICE + inbound RTP, not just ontrack.
 const diagnostic=await browser.newPage();diagnostic.on('pageerror',e=>errors.push('diagnostic: '+e.message));
 await diagnostic.goto('http://127.0.0.1:'+server.address().port+'/test-voice.html');
 await diagnostic.evaluate(()=>loopbackTest());
 const diagnosticLog=await diagnostic.locator('#log').innerText();
 assert(diagnosticLog.includes('RTP:')&&!diagnosticLog.includes('❌'));
 ok('Shipped loopback diagnostic waits for connected ICE and confirms actual audio RTP');
 const diagnosticCleanup=await diagnostic.evaluate(async()=>{
   const originalGet=getStream,originalLevel=measureLevel;let captured;
   getStream=async()=>{captured=await originalGet();return captured;};
   measureLevel=async()=>{throw new Error('Injected analyser failure');};
   await testMic();getStream=originalGet;measureLevel=originalLevel;
   return !captureTestRunning&&captured.getTracks().every(t=>t.readyState==='ended');
 });
 assert(diagnosticCleanup);ok('Diagnostic microphone is released even when analyser throws');
 const missingDevice=await a.evaluate(async()=>{
   const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),calls=[];
   navigator.mediaDevices.getUserMedia=async constraints=>{
     calls.push(constraints);
     if(constraints.audio.deviceId) throw new DOMException('Unplugged','OverconstrainedError');
     return original(constraints);
   };
   Voice.selectedMic='missing-device';const stream=await Voice._getMic();
   const fallback=calls.length===2&&!Voice.selectedMic&&stream.getAudioTracks()[0].readyState==='live';
   stream.getTracks().forEach(t=>t.stop());navigator.mediaDevices.getUserMedia=original;return fallback;
 });
 assert(missingDevice);ok('Unplugged selected microphone falls back to the system default');
 const retrySend=await a.evaluate(async()=>{
   Voice.on=true;const original=Voice._send;let calls=0;
   Voice._send=async()=>++calls===1?false:'ok';
   const entry={id:'retry',outChain:Promise.resolve()};Voice.peers.set('retry',entry);
   await Voice._queueOut(entry,{type:'ice'});Voice._send=original;Voice.peers.delete('retry');Voice.on=false;
   return calls===2;
 });
 assert(retrySend);ok('A boolean signalling failure triggers a retry, not silent message loss');
 const turnValidation=await a.evaluate(async()=>{
   const original=window.fetch;Voice.turnOk=false;Voice.turnAt=0;
   window.fetch=async()=>({ok:true,json:async()=>[{urls:'stun:example.invalid:3478'}]});
   await Voice._fetchTurn();const rejected=!Voice.turnOk;
   window.fetch=async()=>({ok:true,json:async()=>[{urls:'turn:example.invalid:3478',username:'test',credential:'test'}]});
   await Voice._fetchTurn();const accepted=Voice.turnOk;
   window.fetch=original;return rejected&&accepted;
 });
 assert(turnValidation);ok('STUN-only API response cannot falsely report working TURN credentials');
 const leavePresence=await a.evaluate(async()=>{
   await Voice._presenceChain;
   const original=testChannel.track;let calls=0;const seen=[];
   testChannel.track=async meta=>{seen.push(meta.voice);return ++calls===1?'timed out':'ok';};
   Voice.on=false;await Voice._track();
   await new Promise(r=>setTimeout(r,2200));await Voice._presenceChain;
   const retried=calls===2&&seen.every(voice=>voice===false)&&!Voice._presenceDirty;
   testChannel.track=original;Voice.resetRoom();return retried;
 });
 assert(leavePresence);ok('Voice-off presence retries after call watchdog has stopped, preventing ghost callers');

 assert.deepEqual(errors,[]);assert.deepEqual(relayErrors,[]);
 ok('No uncaught browser errors or signalling relay errors');
}
run().catch(e=>{console.error(e);results.push({name:'Test failure',status:'FAIL',details:String(e.stack)});process.exitCode=1;})
.finally(async()=>{
 fs.writeFileSync(path.join(__dirname,'voice-test-results.json'),JSON.stringify({browser:'Chromium (Playwright)',signalling:'local test relay; real WebCrypto/WebRTC; fake microphone',productionServicesTested:false,results},null,2));
 if(browser)await browser.close();if(server)server.close();
});
