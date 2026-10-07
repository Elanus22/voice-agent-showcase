/* Tanzschule Muster Voice-Agent — Browser-Test-UI (Gemini Live API)
   Mikrofon-PCM (16 kHz) → Server → Modell, Sprach-PCM (24 kHz) zurück.
   VAD, Barge-in und Transkription macht das Modell. */

const $ = (id) => document.getElementById(id);

const btnCall = $("btn_call_toggle");
const btnCallLabel = $("btn_call_label");
const statusHeading = $("call_status_heading");
const statusSub = $("call_status_sub");
const timerEl = $("call_timer");
const pingEl = $("phone_pulse_ping");
const micNote = $("mic_note");
const feed = $("transcript_feed");
const emptyState = $("transcript_empty");
const counterEl = $("transcript_counter");
const textForm = $("text_form");
const textInput = $("text_input");
const stateDot = $("extraction_state_dot");
const stateTxt = $("extraction_state_txt");
const mailTarget = $("mail_target");
const summaryText = $("summary_text");
const confirmBox = $("email_confirm_box");
const confirmText = $("confirm_text");
const btnSendEmail = $("btn_send_email");

let ws = null;
let callActive = false;
let currentGen = 0;
let lineCount = 0;
let timerInterval = null;
let callSeconds = 0;

// ── Status-Anzeige ───────────────────────────────────────────
function setStatus(state, heading, sub) {
  document.body.dataset.call = state;
  statusHeading.textContent = heading;
  if (sub !== undefined) statusSub.textContent = sub;
  pingEl.hidden = !(state === "listening" || state === "speaking");
}

function setExtractionState(mode, text) {
  stateDot.className = "dot" + (mode ? " " + mode : "");
  stateTxt.textContent = text;
}

function startTimer() {
  callSeconds = 0;
  timerEl.hidden = false;
  timerEl.textContent = "00:00";
  timerInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, "0");
    const s = String(callSeconds % 60).padStart(2, "0");
    timerEl.textContent = `${m}:${s}`;
  }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

// ── Transkript ───────────────────────────────────────────────
function addBubble(role, text) {
  if (emptyState && emptyState.isConnected) emptyState.remove();
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "assistant" ? "Tanzschule Muster Assistentin" : "Anrufer:in";
  const body = document.createElement("span");
  body.textContent = text;
  div.append(who, body);
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
  lineCount++;
  counterEl.textContent = `${lineCount} Zeilen`;
  return body;
}

let interimBubble = null;
function showInterim(text) {
  if (!interimBubble) {
    if (emptyState && emptyState.isConnected) emptyState.remove();
    const div = document.createElement("div");
    div.className = "bubble user interim";
    interimBubble = document.createElement("span");
    div.appendChild(interimBubble);
    feed.appendChild(div);
  }
  interimBubble.textContent = text;
  feed.scrollTop = feed.scrollHeight;
}
function clearInterim() {
  if (interimBubble) {
    interimBubble.closest(".bubble").remove();
    interimBubble = null;
  }
}

// ── Base64-Helfer ────────────────────────────────────────────
function b64FromBytes(bytes) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
function bytesFromB64(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// ── Mikrofon → 16-kHz-PCM16 → WS ─────────────────────────────
let micStream = null, micCtx = null, micSrcNode = null, micProc = null;

async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  micCtx = new AudioContext({ sampleRate: 16000 });
  await micCtx.resume();
  micSrcNode = micCtx.createMediaStreamSource(micStream);
  micProc = micCtx.createScriptProcessor(4096, 1, 1);
  micProc.onaudioprocess = (e) => {
    if (!callActive || !ws || ws.readyState !== WebSocket.OPEN) return;
    const f = e.inputBuffer.getChannelData(0);
    const i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    ws.send(JSON.stringify({ type: "audio_in", data: b64FromBytes(new Uint8Array(i16.buffer)) }));
  };
  micSrcNode.connect(micProc);
  micProc.connect(micCtx.destination); // nötig, damit onaudioprocess feuert (Ausgang ist stumm)
}

function stopMic() {
  try { micProc?.disconnect(); } catch {}
  try { micSrcNode?.disconnect(); } catch {}
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { micCtx?.close(); } catch {}
  micStream = micCtx = micSrcNode = micProc = null;
}

// ── 24-kHz-PCM16 vom Modell → lückenlos geplante AudioBuffer ─
let playCtx = null;
let playhead = 0;
const activeSources = new Set();
let speakWatch = null;

function playPcm(b64) {
  if (!playCtx) {
    playCtx = new AudioContext({ sampleRate: 24000 });
    playhead = 0;
  }
  const u8 = bytesFromB64(b64);
  const i16 = new Int16Array(u8.buffer, 0, Math.floor(u8.byteLength / 2));
  if (!i16.length) return;
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

  const buf = playCtx.createBuffer(1, f32.length, 24000);
  buf.getChannelData(0).set(f32);
  const src = playCtx.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx.destination);
  const t = Math.max(playCtx.currentTime + 0.06, playhead);
  src.start(t);
  playhead = t + buf.duration;
  activeSources.add(src);
  src.onended = () => activeSources.delete(src);

  setStatus("speaking", "Assistentin spricht …");
  if (!speakWatch) {
    speakWatch = setInterval(() => {
      if (playCtx && playCtx.currentTime >= playhead - 0.05 && activeSources.size === 0) {
        clearInterval(speakWatch);
        speakWatch = null;
        if (callActive) setStatus("listening", "Ich höre zu …", "Einfach sprechen — Sie dürfen auch unterbrechen.");
      }
    }, 200);
  }
}

function flushPlayback() {
  for (const s of activeSources) { try { s.stop(); } catch {} }
  activeSources.clear();
  if (playCtx) playhead = playCtx.currentTime;
}

function stopLiveAudio() {
  flushPlayback();
  clearInterval(speakWatch);
  speakWatch = null;
  try { playCtx?.close(); } catch {}
  playCtx = null;
}

/* ══════════════════════ WEBSOCKET ═════════════════════════════ */

let assistantBubble = null;

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let opened = false;
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => { opened = true; };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "config": {
        callActive = true;
        btnCall.classList.add("danger");
        btnCallLabel.textContent = "Auflegen & auswerten";
        btnCall.disabled = false;
        textInput.disabled = false;
        textForm.querySelector("button").disabled = false;
        startTimer();
        setExtractionState("active", "Gespräch läuft — Transkript wird aufgezeichnet…");
        setStatus("thinking", "Verbinde …", "Einen Moment, die Leitung wird aufgebaut.");

        try {
          await startMic();
        } catch (err) {
          micNote.hidden = false;
          micNote.textContent =
            "Mikrofon nicht verfügbar (" + err.message + ") — tippen funktioniert trotzdem.";
        }
        ws.send(JSON.stringify({ type: "start" }));
        break;
      }

      case "live_ready":
        setStatus("listening", "Verbunden", "Die Assistentin meldet sich gleich — Sie können auch einfach lossprechen.");
        break;

      case "user_partial":
        showInterim(msg.text);
        break;

      case "user_final":
        clearInterim();
        addBubble("user", msg.text);
        break;

      case "audio_out":
        playPcm(msg.data);
        break;

      case "interrupted":
        flushPlayback();
        if (callActive) setStatus("listening", "Ich höre zu …");
        break;

      case "assistant_start":
        currentGen = msg.gen;
        assistantBubble = null;
        break;

      case "assistant_delta":
        if (msg.gen !== currentGen) break;
        if (!assistantBubble) assistantBubble = addBubble("assistant", "");
        assistantBubble.textContent += msg.text;
        feed.scrollTop = feed.scrollHeight;
        break;

      case "assistant_end":
        if (msg.gen !== currentGen) break;
        if (msg.error) console.error("Serverfehler:", msg.error);
        break;

      // ── Auswertung ──
      case "processing":
        setExtractionState("active", "Gemini extrahiert die Gesprächsdaten…");
        break;

      case "extraction":
        showExtraction(msg.extraction);
        break;

      case "email_result":
        showEmailResult(msg.delivery);
        break;

      case "error":
        setExtractionState("", "Fehler: " + msg.message);
        console.error(msg.message);
        break;
    }
  };

  ws.onclose = () => {
    if (callActive) {
      endCallUi();
      setStatus("idle", "Verbindung getrennt", "Der Server hat die Verbindung beendet. Läuft der Dienst noch?");
    } else if (!opened) {
      setStatus("idle", "Server nicht erreichbar", "Bitte den Voice-Agent-Dienst starten und die Seite neu laden.");
      btnCall.disabled = false;
    }
  };
}

function sendUserText(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  flushPlayback(); // Barge-in per Text
  addBubble("user", text);
  ws.send(JSON.stringify({ type: "user_text", text }));
}

/* ═══════════════════ Anruf-Lebenszyklus ═══════════════════════ */

function startCall() {
  btnCall.disabled = true;
  setStatus("thinking", "Verbinde …", "");
  connect();
}

function hangUp() {
  stopMic();
  stopLiveAudio();
  stopTimer();
  callActive = false;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "end_call" }));
  }
  setStatus("idle", "Anruf beendet", "Die Gesprächsdaten werden rechts ausgewertet.");
  btnCall.classList.remove("danger");
  btnCallLabel.textContent = "Neuen Anruf starten";
  btnCall.disabled = false;
  textInput.disabled = true;
  textForm.querySelector("button").disabled = true;
  setExtractionState("active", "Auswertung läuft…");
}

function endCallUi() {
  stopMic();
  stopLiveAudio();
  stopTimer();
  callActive = false;
  btnCall.classList.remove("danger");
  btnCallLabel.textContent = "Neuen Anruf starten";
  btnCall.disabled = false;
  textInput.disabled = true;
  textForm.querySelector("button").disabled = true;
}

/* ═══════════════════ Extraktion & E-Mail ══════════════════════ */

function fillField(id, value) {
  const el = $(id);
  el.textContent = value ?? "—";
  el.classList.toggle("filled", value != null && value !== "");
}

function showExtraction(x) {
  if (!x) {
    setExtractionState("", "Kein auswertbares Gespräch vorhanden.");
    return;
  }
  const name = x.participant_name || x.caller_name;
  const termin = x.weekday
    ? `${x.weekday}${x.time_start ? " " + x.time_start : ""}${x.time_end ? "–" + x.time_end : ""}`
    : null;

  fillField("summary_val_name", name);
  fillField("summary_val_email", x.email);
  fillField("summary_val_course", x.course);
  fillField("summary_val_start", termin);

  summaryText.textContent = x.summary || "";
  summaryText.hidden = !x.summary;

  setExtractionState("done", "Daten extrahiert ✓");
  confirmBox.hidden = false;
  confirmBox.classList.remove("success");
  btnSendEmail.disabled = false;
  btnSendEmail.textContent = "E-Mail absenden";
  confirmText.textContent = x.booking_requested
    ? "Buchungsdaten extrahiert. „E-Mail absenden“ schickt die Notiz ans Büro — der Termin wird dort von Hand bestätigt."
    : "Gesprächsnotiz erstellt. „E-Mail absenden“ schickt die Zusammenfassung ans Büro.";
}

function showEmailResult(delivery) {
  if (delivery && delivery.sent) {
    confirmBox.classList.add("success");
    confirmBox.querySelector(".confirm-title").textContent = "E-Mail verschickt ✓";
    confirmText.textContent = `Die Buchungsnotiz ist unterwegs an ${delivery.to}.`;
    setExtractionState("done", "E-Mail versendet ✓");
    btnSendEmail.textContent = "Erledigt";
  } else if (delivery && delivery.fehlgeschlagen) {
    // Wichtigster der drei Fälle: SMTP ist konfiguriert, der Versand ist aber
    // gescheitert. Das darf nicht wie ein Erfolg aussehen.
    confirmBox.classList.remove("success");
    confirmBox.querySelector(".confirm-title").textContent = "Versand fehlgeschlagen ✖";
    confirmText.textContent =
      `Die Mail an ${delivery.to} konnte nach 3 Versuchen nicht zugestellt werden ` +
      `(${delivery.fehler}). Die Anfrage liegt vollständig auf dem Server unter ` +
      `${delivery.outboxPath} und muss von Hand nachgereicht werden.`;
    setExtractionState("", "Versand fehlgeschlagen — Anfrage liegt in outbox/");
    btnSendEmail.textContent = "Nicht zugestellt";
  } else if (delivery) {
    confirmBox.classList.add("success");
    confirmBox.querySelector(".confirm-title").textContent = "In outbox/ abgelegt";
    confirmText.textContent = `Kein SMTP konfiguriert — die Mail liegt als Datei in outbox/ (Empfänger wäre ${delivery.to}).`;
    setExtractionState("done", "Notiz in outbox/ abgelegt");
    btnSendEmail.textContent = "Erledigt";
  }
  btnSendEmail.disabled = true;
}

/* ═══════════════════════ Events ═══════════════════════════════ */

btnCall.addEventListener("click", () => {
  if (!callActive) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      location.reload(); // neuer Anruf nach beendetem Gespräch
      return;
    }
    startCall();
  } else {
    hangUp();
  }
});

btnSendEmail.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    btnSendEmail.disabled = true;
    btnSendEmail.textContent = "Wird gesendet…";
    ws.send(JSON.stringify({ type: "send_email" }));
  }
});

textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = "";
  sendUserText(text);
});

fetch("/config")
  .then((r) => r.json())
  .then((c) => { mailTarget.textContent = c.mailTo; })
  .catch(() => { mailTarget.textContent = "—"; });
