import { Boom } from "@hapi/boom";
import { zip } from "fflate";
import { promises as fsPromises } from "fs";
import { gunzipSync, gzipSync } from "zlib";
import { proto } from "../../WAProto/index.js";
import { sha256 } from "./crypto.js";
import { generateMessageIDV2, unixTimestampSeconds } from "./generics.js";
import { encryptedStream, getImageProcessingLibrary, getStream, toBuffer } from "./messages-media.js";
export const isWebPBuffer = (buffer) => {
    return (buffer.length > 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP');
};

export const isAnimatedWebP = (buffer) => {
    return isWebPBuffer(buffer) && buffer.includes(Buffer.from('ANIM', 'ascii'));
};

export const isLottieBuffer = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
        return false;
    }
    let jsonBuffer;
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        try {
            jsonBuffer = gunzipSync(buffer, { maxOutputLength: 50 * 1024 * 1024 });
        }
        catch {
            return false;
        }
    }
    else if (buffer[0] === 0x7b) {
        jsonBuffer = buffer;
    }
    else {
        return false;
    }
    const head = jsonBuffer.toString('utf8', 0, Math.min(jsonBuffer.length, 4096));
    return head.includes('"v"') && head.includes('"layers"') && head.includes('"ip"') && head.includes('"op"');
};

export const convertToWebP = async (input) => {
    const { stream } = await getStream(input);
    const buffer = await toBuffer(stream);
    if (isWebPBuffer(buffer)) {
        return { buffer, isAnimated: isAnimatedWebP(buffer) };
    }
    const lib = await getImageProcessingLibrary();
    const hasSharp = 'sharp' in lib && !!lib.sharp?.default;
    const hasImage = 'image' in lib && !!lib.image?.Transformer;
    if (!hasSharp && !hasImage) {
        throw new Boom('No image processing library (sharp or @napi-rs/image) available for converting sticker to WebP.');
    }
    let webpBuffer;
    if (hasSharp) {
        webpBuffer = await lib.sharp
            .default(buffer)
            .resize(512, 512, { fit: 'inside' })
            .webp({ quality: 80 })
            .toBuffer();
    }
    else {
        webpBuffer = await new lib.image.Transformer(buffer).resize(512, 512).webp(80);
    }
    return { buffer: webpBuffer, isAnimated: false };
};

export const generateStickerPackId = () => {
    const arr = new Uint8Array(8);
    for (let i = 0; i < 8; i++)
        arr[i] = Math.floor(Math.random() * 256);
    return Array.from(arr)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
};

export const buildStickerPackProto = (pack) => ({
    name: pack.name,
    publisher: pack.publisher,
    packId: pack.packId ?? generateStickerPackId(),
    description: pack.description ?? ''
});

export const STICKER_PACK_MESSAGE_TYPE = 'sticker_pack';

const ITSL_CONCURRENCY_LIMIT = 15;

export const prepareStickerPackMessageItsliaaa = async (message, options) => {
    const { cover, stickers = [], name = '📦 Sticker Pack', publisher = '', description = '', packId } = message;
    if (stickers.length > 60) {
        throw new Boom('Sticker pack exceeds the maximum limit of 60 stickers', { statusCode: 400 });
    }
    if (stickers.length === 0) {
        throw new Boom('Sticker pack must contain at least one sticker', { statusCode: 400 });
    }
    if (!cover) {
        throw new Boom('Sticker pack must contain a cover', { statusCode: 400 });
    }
    const { logger } = options;
    let cacheableKey = false;
    if (stickers.length && options.mediaCache) {
        const urls = [];
        for (const s of stickers) {
            const data = s.data;
            if (typeof data === 'object' && data?.url)
                urls.push(data.url);
        }
        if (urls.length > 0)
            cacheableKey = 'sticker:' + urls.join('@');
    }
    if (cacheableKey) {
        const mediaBuff = await options.mediaCache.get(cacheableKey);
        if (mediaBuff) {
            logger?.debug({ cacheableKey }, 'got media cache hit');
            return proto.Message.StickerPackMessage.decode(mediaBuff);
        }
    }
    const lib = await getImageProcessingLibrary();
    const hasSharp = 'sharp' in lib && !!lib.sharp?.default;
    const hasImage = 'image' in lib && !!lib.image?.Transformer;
    if (!hasSharp && !hasImage) {
        throw new Boom('No image processing library (sharp or @napi-rs/image) available for converting sticker to WebP.');
    }
    const stickerPackIdValue = packId ?? generateMessageIDV2();
    const stickerData = {};
    const stickerMetadata = new Array(stickers.length);
    for (let i = 0; i < stickers.length; i += ITSL_CONCURRENCY_LIMIT) {
        const chunkEnd = Math.min(i + ITSL_CONCURRENCY_LIMIT, stickers.length);
        const promises = [];
        for (let j = i; j < chunkEnd; j++) {
            promises.push((async (index) => {
                const sticker = stickers[index];
                const { stream } = await getStream(sticker.data);
                const buffer = await toBuffer(stream);
                let webpBuffer;
                let isAnimated = false;
                const isLottie = sticker.isLottie !== undefined ? !!sticker.isLottie : isLottieBuffer(buffer);
                if (isLottie) {
                    const wasBuffer = buffer[0] === 0x7b ? gzipSync(buffer) : buffer;
                    if (wasBuffer.length > 1024 * 1024) {
                        throw new Boom(`Sticker at index ${index} exceeds the 1MB size limit`, { statusCode: 400 });
                    }
                    const wasName = `${sha256(wasBuffer).toString('base64').replace(/\//g, '-')}.was`;
                    stickerData[wasName] = [new Uint8Array(wasBuffer), { level: 0 }];
                    stickerMetadata[index] = {
                        fileName: wasName,
                        mimetype: 'application/was',
                        isAnimated: true,
                        isLottie: true,
                        emojis: sticker.emojis || ['✨'],
                        accessibilityLabel: sticker.accessibilityLabel || '‎'
                    };
                    return;
                }
                if (isWebPBuffer(buffer)) {
                    webpBuffer = buffer;
                    isAnimated = isAnimatedWebP(buffer);
                }
                else if (hasSharp) {
                    webpBuffer = await lib.sharp
                        .default(buffer)
                        .resize(512, 512, { fit: 'inside' })
                        .webp({ quality: 80 })
                        .toBuffer();
                }
                else {
                    webpBuffer = await new lib.image.Transformer(buffer).resize(512, 512).webp(80);
                }
                if (webpBuffer.length > 1024 * 1024) {
                    throw new Boom(`Sticker at index ${index} exceeds the 1MB size limit`, { statusCode: 400 });
                }
                const hash = sha256(webpBuffer).toString('base64').replace(/\//g, '-');
                const fileName = `${hash}.webp`;
                stickerData[fileName] = [new Uint8Array(webpBuffer), { level: 0 }];
                stickerMetadata[index] = {
                    fileName,
                    mimetype: 'image/webp',
                    isAnimated,
                    emojis: sticker.emojis || ['✨'],
                    accessibilityLabel: sticker.accessibilityLabel || '‎'
                };
            })(j));
        }
        await Promise.all(promises);
    }
    const trayIconFileName = `${stickerPackIdValue}.webp`;
    const { stream: coverStream } = await getStream(cover);
    const coverBuffer = await toBuffer(coverStream);
    let coverWebpBuffer;
    if (isWebPBuffer(coverBuffer)) {
        coverWebpBuffer = coverBuffer;
    }
    else if (hasSharp) {
        coverWebpBuffer = await lib.sharp
            .default(coverBuffer)
            .resize(512, 512, { fit: 'inside' })
            .webp({ quality: 80 })
            .toBuffer();
    }
    else {
        coverWebpBuffer = await new lib.image.Transformer(coverBuffer).resize(512, 512).webp(80);
    }
    stickerData[trayIconFileName] = [new Uint8Array(coverWebpBuffer), { level: 0 }];
    const zipBuffer = await new Promise((resolve, reject) => {
        zip(stickerData, (error, data) => (error ? reject(error) : resolve(Buffer.from(data))));
    });
    const stickerPackUpload = await encryptedStream(zipBuffer, 'sticker-pack', { logger, opts: options.options });
    let stickerPackUploadResult;
    try {
        stickerPackUploadResult = await options.upload(stickerPackUpload.encFilePath, {
            fileEncSha256B64: stickerPackUpload.fileEncSha256.toString('base64'),
            mediaType: 'sticker-pack',
            timeoutMs: options.mediaUploadTimeoutMs
        });
    }
    finally {
        fsPromises.unlink(stickerPackUpload.encFilePath).catch(() => logger?.warn('failed to remove tmp file'));
    }
    const obj = {
        name,
        publisher,
        stickerPackId: stickerPackIdValue,
        packDescription: description,
        stickerPackOrigin: proto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED,
        stickerPackSize: zipBuffer.length,
        stickers: stickerMetadata,
        fileSha256: stickerPackUpload.fileSha256,
        fileEncSha256: stickerPackUpload.fileEncSha256,
        mediaKey: stickerPackUpload.mediaKey,
        directPath: stickerPackUploadResult.directPath,
        fileLength: stickerPackUpload.fileLength,
        mediaKeyTimestamp: unixTimestampSeconds(),
        trayIconFileName
    };
    try {
        let thumbnailBuffer;
        if (hasSharp) {
            thumbnailBuffer = await lib.sharp.default(coverBuffer).resize(252, 252).jpeg().toBuffer();
        }
        else {
            thumbnailBuffer = await new lib.image.Transformer(coverBuffer).resize(252, 252).jpeg();
        }
        if (!thumbnailBuffer || thumbnailBuffer.length === 0) {
            throw new Error('Failed to generate thumbnail buffer');
        }
        const thumbUpload = await encryptedStream(thumbnailBuffer, 'thumbnail-sticker-pack', {
            logger,
            opts: options.options,
            mediaKey: stickerPackUpload.mediaKey
        });
        let thumbUploadResult;
        try {
            thumbUploadResult = await options.upload(thumbUpload.encFilePath, {
                fileEncSha256B64: thumbUpload.fileEncSha256.toString('base64'),
                mediaType: 'thumbnail-sticker-pack',
                timeoutMs: options.mediaUploadTimeoutMs
            });
        }
        finally {
            fsPromises.unlink(thumbUpload.encFilePath).catch(() => logger?.warn('failed to remove tmp file'));
        }
        Object.assign(obj, {
            thumbnailDirectPath: thumbUploadResult.directPath,
            thumbnailSha256: thumbUpload.fileSha256,
            thumbnailEncSha256: thumbUpload.fileEncSha256,
            thumbnailHeight: 252,
            thumbnailWidth: 252,
            imageDataHash: sha256(thumbnailBuffer).toString('base64')
        });
    }
    catch (error) {
        logger?.warn(`Thumbnail generation failed: ${error}`);
    }
    if (cacheableKey) {
        logger?.debug({ cacheableKey }, 'set cache (background)');
        options.mediaCache.set(cacheableKey, Buffer.from(proto.Message.StickerPackMessage.encode(obj).finish()));
    }
    return proto.Message.StickerPackMessage.fromObject(obj);
};

const DEFAULT_EMOJIS = [
  "😀",
  "😂",
  "😍",
  "🔥",
  "👍",
  "🎉",
  "😎",
  "🤩",
  "💯",
  "🥳",
];

const normalizeSticker = (entry, index) => {
  if (
    Buffer.isBuffer(entry) ||
    (entry &&
      typeof entry === "object" &&
      "url" in entry &&
      !("sticker" in entry))
  ) {
    return {
      sticker: entry,
      emojis: [DEFAULT_EMOJIS[index % DEFAULT_EMOJIS.length]],
      accessibilityLabel: "",
    };
  }
  return {
    sticker: entry.sticker || entry.data,
    emojis: entry.emojis || [DEFAULT_EMOJIS[index % DEFAULT_EMOJIS.length]],
    accessibilityLabel: entry.accessibilityLabel || "",
  };
};

export const makeStickerPack = ({
  name,
  publisher = "",
  description = "",
  packId,
  stickers = [],
  cover,
  contextInfo,
} = {}) => {
  if (!name) throw new Error("makeStickerPack: name is required");
  if (!stickers.length)
    throw new Error("makeStickerPack: at least one sticker is required");

  const normalizedStickers = stickers.map(normalizeSticker);
  const resolvedCover = cover ?? normalizedStickers[0].sticker;

  return {
    stickerPack: {
      name,
      publisher,
      description,
      ...(packId ? { packId } : {}),
      stickers: normalizedStickers,
      cover: resolvedCover,
    },
    ...(contextInfo ? { contextInfo } : {}),
  };
};
