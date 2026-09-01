import { Jimp, JimpMime } from "jimp";

const toBuffer = async stream => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  stream.destroy?.();
  return Buffer.concat(chunks);
};

const generateWideProfilePicture = async img => {
  const jimp = await Jimp.read(img);
  const width = jimp.bitmap.width;
  const height = jimp.bitmap.height;
  const ratio = width > height ? width / 720 : width / 324;
  const targetWidth = Math.round(width / ratio);
  const targetHeight = Math.round(height / ratio);
  const buffer = await jimp.resize({
    w: targetWidth,
    h: targetHeight
  }).getBuffer(JimpMime.jpeg, {
    quality: 100
  });
  return {
    img: buffer
  };
};

export const generateProfilePictureFull = generateWideProfilePicture;

export const changeprofileFull = generateWideProfilePicture;

const generateSquareProfilePicture = async buffer => {
  const jimp = await Jimp.read(buffer);
  const img = await jimp.clone().scaleToFit({
    w: 720,
    h: 720
  }).getBuffer(JimpMime.jpeg);
  const preview = await jimp.clone().normalize().getBuffer(JimpMime.jpeg);
  return {
    img: img,
    preview: preview
  };
};

export const generateProfilePictureFP = generateSquareProfilePicture;

export const generatePP = generateSquareProfilePicture;

export const generateProfilePicturee = async mediaUpload => {
  let bufferOrFilePath;
  if (Buffer.isBuffer(mediaUpload)) {
    bufferOrFilePath = mediaUpload;
  } else if ("url" in mediaUpload) {
    bufferOrFilePath = mediaUpload.url.toString();
  } else {
    bufferOrFilePath = await toBuffer(mediaUpload.stream);
  }
  const jimp = await Jimp.read(bufferOrFilePath);
  const {width: width, height: height} = jimp.bitmap;
  const resized = width > height ? jimp.resize({
    w: 720,
    h: Math.round(height / width * 720)
  }) : jimp.resize({
    w: Math.round(width / height * 720),
    h: 720
  });
  const img = await resized.getBuffer(JimpMime.jpeg, {
    quality: 100
  });
  return {
    img: img
  };
};