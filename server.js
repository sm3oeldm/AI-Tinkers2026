/*
 * Course Companion — custom Next.js server.
 *
 * Keeps the prototype's live-lecture feature working end to end: proxies
 * microphone audio from the faculty page to the Gemini Live API's
 * input-audio-transcription over WebSocket, streaming recognized text back.
 * The API key stays server-side and is never sent to the browser.
 *
 * Everything else (pages, REST API, uploads) is handled by Next.js App Router.
 */

const http = require("http");
const path = require("path");
const next = require("next");
const { WebSocketServer } = require("ws");

require("./src/lib/env").loadLocalEnv(__dirname);

const PORT = Number(process.env.PORT || 8792);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-live-2.5-flash-preview";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, dir: __dirname });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = http.createServer((req, res) => handle(req, res));

  const wss = new WebSocketServer({ server, path: "/ws/transcribe" });

  wss.on("connection", (clientWs) => {
    let geminiWs = null;

    const cleanupGemini = () => {
      if (geminiWs) {
        try { geminiWs.close(); } catch (e) {}
        geminiWs = null;
      }
    };

    clientWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }

      if (msg.type === "start") {
        if (!GEMINI_API_KEY) {
          clientWs.send(JSON.stringify({ type: "error", message: "GEMINI_API_KEY is empty in .env — add your AI Studio key to enable live transcription." }));
          return;
        }
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
        try {
          geminiWs = new WebSocket(url);
        } catch (e) {
          clientWs.send(JSON.stringify({ type: "error", message: "Could not open transcription connection: " + e.message }));
          return;
        }

        geminiWs.addEventListener("open", () => {
          geminiWs.send(JSON.stringify({
            setup: {
              model: GEMINI_MODEL,
              generationConfig: { responseModalities: ["TEXT"] },
              inputAudioTranscription: {},
            },
          }));
          clientWs.send(JSON.stringify({ type: "status", message: "connected" }));
        });

        geminiWs.addEventListener("message", (event) => {
          let data;
          try {
            data = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
          } catch (e) {
            return;
          }
          const transcript = data && data.serverContent && data.serverContent.inputTranscription;
          if (transcript && transcript.text) {
            clientWs.send(JSON.stringify({ type: transcript.finished ? "segment" : "partial", text: transcript.text }));
          }
        });

        geminiWs.addEventListener("error", (err) => {
          clientWs.send(JSON.stringify({ type: "error", message: "Transcription service error: " + (err.message || "connection failed") }));
        });

        geminiWs.addEventListener("close", () => {
          clientWs.send(JSON.stringify({ type: "status", message: "closed" }));
          geminiWs = null;
        });
      }

      if (msg.type === "audio" && geminiWs && geminiWs.readyState === 1 /* WebSocket.OPEN */) {
        geminiWs.send(JSON.stringify({ realtimeInput: { audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" } } }));
      }

      if (msg.type === "stop") cleanupGemini();
    });

    clientWs.on("close", cleanupGemini);
  });

  server.listen(PORT, () => {
    console.log(`Course Companion server running at http://localhost:${PORT}`);
    if (!GEMINI_API_KEY) {
      console.log("GEMINI_API_KEY is empty in .env — live transcription will show an error until it's set.");
    }
  });
});
