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

// Serve the latest APK build for direct download
app.get("/download/apk", (_req, res) => {
  const apkPath = path.resolve("/home/runner/workspace/downloads/AsistenteVozIA-build14.apk");
  if (!fs.existsSync(apkPath)) {
    res.status(404).json({ error: "APK not found" });
    return;
  }
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader("Content-Disposition", 'attachment; filename="AsistenteVozIA-build14.apk"');
  res.setHeader("Content-Length", fs.statSync(apkPath).size);
  fs.createReadStream(apkPath).pipe(res);
});

export default app;
