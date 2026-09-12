/*
 * Course Companion prototype server.
 *
 * - Serves the static student/faculty pages.
 * - Proxies live microphone audio from the faculty page to the Gemini Live API's
 *   input-audio-transcription feature over a WebSocket, and streams recognized
 *   text back in real time. The Gemini API key stays server-side (read from .env)
 *   and is never sent to the browser.
 *
 * NOTE: the exact Gemini Live WebSocket message schema below is written from
 * documented behavior and may need small adjustments once a real API key is in
 * place — check https://ai.google.dev/api/live for the current wire format if
 * the transcription connection errors out.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

function loadEnv(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch (e) {
    // no .env file — fine, fall back to process.env / defaults
  }
  return out;
}

const env = { ...loadEnv(path.join(__dirname, ".env")), ...process.env };
const GEMINI_API_KEY = env.GEMINI_API_KEY || "";
const GEMINI_MODEL = env.GEMINI_MODEL || "models/gemini-live-2.5-flash-preview";
const PORT = Number(env.PORT || 8792);

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/student.html";
  const full = path.join(__dirname, decodeURIComponent(urlPath));
  if (!full.startsWith(__dirname) || full.includes(".env")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// /ws/transcribe — browser mic audio in, Gemini transcript text out
// ---------------------------------------------------------------------------
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
        clientWs.send(JSON.stringify({ type: "error", message: "GEMINI_API_KEY is empty in .env — add your key to enable live transcription." }));
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
        geminiWs.send(
          JSON.stringify({
            setup: {
              model: GEMINI_MODEL,
              generationConfig: { responseModalities: ["TEXT"] },
              inputAudioTranscription: {},
            },
          })
        );
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
          clientWs.send(
            JSON.stringify({
              type: transcript.finished ? "segment" : "partial",
              text: transcript.text,
            })
          );
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

    if (msg.type === "audio" && geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(
        JSON.stringify({
          realtimeInput: { audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" } },
        })
      );
    }

    if (msg.type === "stop") {
      cleanupGemini();
    }
  });

  clientWs.on("close", cleanupGemini);
});

server.listen(PORT, () => {
  console.log(`Course Companion server running at http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) {
    console.log("GEMINI_API_KEY is empty in .env — live transcription will show an error until it's set.");
  }
});
