import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let _ffmpeg;
const getFfmpeg = async () => {
  if (_ffmpeg === undefined) {
    _ffmpeg = await import("fluent-ffmpeg").then((m) => m.default ?? m).catch(() => null);
  }
  if (!_ffmpeg) throw new Error("fluent-ffmpeg is required for sticker/voice-note conversion. Install it with: npm i fluent-ffmpeg");
  return _ffmpeg;
};

let _webpmux;
const getWebpmux = async () => {
  if (_webpmux === undefined) {
    _webpmux = await import("node-webpmux").then((m) => m.default ?? m).catch(() => null);
  }
  if (!_webpmux) throw new Error("node-webpmux is required for sticker packname/author metadata. Install it with: npm i node-webpmux (conversion without metadata does not need this package)");
  return _webpmux;
};

export class MediaManager {
  static getTempFile(ext) {
    return path.join(os.tmpdir(), `baileys-fw-${randomBytes(8).toString("hex")}.${ext}`);
  }

  static async convertToSticker(inputPathOrBuffer, metadata) {
    const ffmpegLib = await getFfmpeg();
    const tempInput = MediaManager.getTempFile("in");
    const tempOutput = MediaManager.getTempFile("webp");
    try {
      if (Buffer.isBuffer(inputPathOrBuffer)) {
        await fs.promises.writeFile(tempInput, inputPathOrBuffer);
      } else {
        await fs.promises.copyFile(inputPathOrBuffer, tempInput);
      }
      await new Promise((resolve, reject) => {
        ffmpegLib(tempInput)
          .outputOptions([
            "-vcodec", "libwebp",
            "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0",
            "-loop", "0",
            "-preset", "default",
            "-an", "-vsync", "0",
            "-t", "00:00:05"
          ])
          .output(tempOutput)
          .on("end", () => resolve())
          .on("error", (err) => reject(err))
          .run();
      });
      const webpBuffer = await fs.promises.readFile(tempOutput);
      if (metadata?.packname || metadata?.author) {
        const exifJson = JSON.stringify({
          "sticker-pack-id": `com.thisxys.sticker.${randomBytes(4).toString("hex")}`,
          "sticker-pack-name": metadata.packname || "",
          "sticker-pack-publisher": metadata.author || "",
          emojis: ["🤖"]
        });
        const exifBytes = Buffer.from(exifJson, "utf8");
        const exifHeader = Buffer.from([
          0x49, 0x49, 0x2a, 0x00,
          0x08, 0x00, 0x00, 0x00,
          0x01, 0x00,
          0x41, 0x57, 0x07, 0x00,
          0x00, 0x00, 0x00, 0x00,
          0x16, 0x00, 0x00, 0x00
        ]);
        exifHeader.writeUInt32LE(exifBytes.length, 14);
        const fullExif = Buffer.concat([exifHeader, exifBytes]);
        const webpmux = await getWebpmux();
        const img = new webpmux.Image();
        await img.load(webpBuffer);
        img.exif = fullExif;
        return await img.save(null);
      }
      return webpBuffer;
    } finally {
      await fs.promises.unlink(tempInput).catch(() => {});
      await fs.promises.unlink(tempOutput).catch(() => {});
    }
  }

  static async convertToVoiceNote(inputPathOrBuffer) {
    const ffmpegLib = await getFfmpeg();
    const tempInput = MediaManager.getTempFile("in");
    const tempOutput = MediaManager.getTempFile("ogg");
    try {
      if (Buffer.isBuffer(inputPathOrBuffer)) {
        await fs.promises.writeFile(tempInput, inputPathOrBuffer);
      } else {
        await fs.promises.copyFile(inputPathOrBuffer, tempInput);
      }
      await new Promise((resolve, reject) => {
        ffmpegLib(tempInput)
          .inputOptions(["-y"])
          .outputOptions([
            "-c:a", "libopus",
            "-ac", "1",
            "-ar", "16000",
            "-application", "voip",
            "-b:a", "32k",
            "-compression_level", "10",
            "-vbr", "on"
          ])
          .format("ogg")
          .output(tempOutput)
          .on("end", () => resolve())
          .on("error", (err) => reject(err))
          .run();
      });
      return await fs.promises.readFile(tempOutput);
    } finally {
      await fs.promises.unlink(tempInput).catch(() => {});
      await fs.promises.unlink(tempOutput).catch(() => {});
    }
  }
}
