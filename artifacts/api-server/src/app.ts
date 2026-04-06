import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/api", router);

// ─── Remote log endpoint ──────────────────────────────────────────────────────
// The Android APK sends critical lifecycle events here (fire-and-forget HTTP).
// Print them to stdout with a clear prefix so they appear in the Replit
// workflow console in real-time — acting as a "cardiac monitor" for the app.
app.post("/api/remote-log", (req, res) => {
  const { level = "LOG", tag = "?", message = "", ts } = req.body as {
    level?: string;
    tag?: string;
    message?: string;
    ts?: number;
  };
  const time = ts
    ? new Date(ts).toISOString().replace("T", " ").replace("Z", "")
    : new Date().toISOString().replace("T", " ").replace("Z", "");
  const icon = level === "ERROR" ? "❌" : level === "WARN" ? "⚠️ " : "📱";
  // Use process.stdout.write to bypass pino formatting and always be visible
  process.stdout.write(`${icon} [APP ANDROID][${tag}] ${message}  (${time})\n`);
  res.status(200).json({ ok: true });
});

// APK download — must be under /api/ so the Replit workspace proxy forwards it
// Accessible at: /api/download/apk
app.get("/api/download/apk", (_req, res) => {
  const downloadsDir = "/home/runner/workspace/downloads";
  let latestApk: string | null = null;
  let latestMtime = 0;
  try {
    for (const f of fs.readdirSync(downloadsDir)) {
      if (!f.endsWith(".apk")) continue;
      const full = path.join(downloadsDir, f);
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > latestMtime) { latestMtime = mtime; latestApk = full; }
    }
  } catch {}
  if (!latestApk) {
    res.status(404).json({ error: "No APK available yet" });
    return;
  }
  const filename = path.basename(latestApk);
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", fs.statSync(latestApk).size);
  fs.createReadStream(latestApk).pipe(res);
});

export default app;
