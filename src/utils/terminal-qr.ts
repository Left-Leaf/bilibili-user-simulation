import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import qrcodeTerminal from 'qrcode-terminal';

const require = createRequire(import.meta.url);
// 项目内置的二维码解码器（vendor/jsqr/jsQR.cjs，UMD 单文件、无外部依赖）
const jsQR = require('../../vendor/jsqr/jsQR.cjs') as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }
) => { data: string } | null;

/**
 * 二维码转换函数的输入类型。
 * utils 层只负责“转换”，不负责从页面提取二维码信息（提取在 action 层实现）。
 */
export type QrTerminalInput = { type: 'base64-image'; data: string } | { type: 'link'; url: string };

export interface QrConversionOptions {
  // 预留：目前 base64 图片路径按二维码模块网格自动渲染，无需手动指定宽度
}

interface PngImage {
  width: number;
  height: number;
  rgba: Buffer;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
};

/** 解码 8-bit、非隔行 PNG 为 RGBA（纯 Node 实现，不依赖第三方解码库） */
const decodePng = (buffer: Buffer): PngImage | null => {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const palette: number[] = [];
  const idatChunks: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      break;
    }

    const data = buffer.subarray(dataStart, dataEnd);

    if (type === 'IHDR' && data.length >= 13) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      for (let i = 0; i + 2 < data.length; i += 3) {
        palette.push(data[i], data[i + 1], data[i + 2]);
      }
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // 跳过 CRC
  }

  if (!width || !height || idatChunks.length === 0) {
    return null;
  }
  if (bitDepth !== 8 || interlace !== 0) {
    return null;
  }

  const channelsByColorType: Record<number, number> = {
    0: 1, // 灰度
    2: 3, // RGB
    3: 1, // 调色板
    4: 2, // 灰度 + 透明
    6: 4, // RGBA
  };
  const channels = channelsByColorType[colorType];
  if (channels === undefined) {
    return null;
  }

  const bpp = channels;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idatChunks));
  } catch {
    return null;
  }

  const stride = width * bpp;
  const rgba = Buffer.alloc(width * height * 4);
  const prevRow = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filterType = raw[rowStart] ?? 0;
    if (filterType > 4) {
      return null;
    }
    const rowData = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const row = Buffer.alloc(stride);

    for (let x = 0; x < stride; x += 1) {
      const rawByte = rowData[x] ?? 0;
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prevRow[x] ?? 0;
      const c = x >= bpp ? prevRow[x - bpp] : 0;

      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + Math.floor((a + b) / 2);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          return null;
      }
      row[x] = value & 0xff;
    }

    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[out] = row[x * 4];
        rgba[out + 1] = row[x * 4 + 1];
        rgba[out + 2] = row[x * 4 + 2];
        rgba[out + 3] = row[x * 4 + 3];
      } else if (colorType === 2) {
        rgba[out] = row[x * 3];
        rgba[out + 1] = row[x * 3 + 1];
        rgba[out + 2] = row[x * 3 + 2];
        rgba[out + 3] = 255;
      } else if (colorType === 0) {
        const gray = row[x];
        rgba[out] = gray;
        rgba[out + 1] = gray;
        rgba[out + 2] = gray;
        rgba[out + 3] = 255;
      } else if (colorType === 4) {
        const gray = row[x * 2];
        rgba[out] = gray;
        rgba[out + 1] = gray;
        rgba[out + 2] = gray;
        rgba[out + 3] = row[x * 2 + 1];
      } else if (colorType === 3) {
        const idx = row[x] * 3;
        rgba[out] = palette[idx] ?? 0;
        rgba[out + 1] = palette[idx + 1] ?? 0;
        rgba[out + 2] = palette[idx + 2] ?? 0;
        rgba[out + 3] = 255;
      }
    }

    prevRow.set(row);
  }

  return { width, height, rgba };
};

/**
 * 把 RGBA 像素渲染成可扫码的终端二维码。
 *
 * 关键点：
 *  - **半块字符**（每个字符 = 上下 2 行模块）：终端字符本身高宽比约 2:1，
 *    用半块字符可抵消这种拉伸，让二维码在终端里保持正方形。
 *  - **黑白二值、按模块网格多数投票**：高对比、无灰阶毛边，识别率更高。
 *  - 通过左上角定位图形推断模块大小，再按模块网格采样。
 */
const buildAsciiFromPixels = (rgba: Uint8Array | Buffer, width: number, height: number): string => {
  // 1) 二值化：亮度 < 128 视为深色
  const dark = new Array<boolean>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const luminance = 0.299 * (rgba[i] ?? 255) + 0.587 * (rgba[i + 1] ?? 255) + 0.114 * (rgba[i + 2] ?? 255);
      dark[y * width + x] = luminance < 128;
    }
  }

  // 2) 深色包围盒：裁掉二维码四周的白色留白
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (dark[y * width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return '';
  }

  const qrWidth = maxX - minX + 1;

  // 3) 通过三个定位图形做结构匹配，选出最可能的模块数（标准 QR 版本 21+4n）。
  //    逐个候选版本按模块中心采样定位图形，结构一致度最高的即正确模块数。
  const finderMask = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
  ];

  const finderScore = (modules: number, fx: number, fy: number): number => {
    const mpx = qrWidth / modules;
    let agree = 0;
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const px = Math.round(minX + (fx + c + 0.5) * mpx);
        const py = Math.round(minY + (fy + r + 0.5) * mpx);
        if (px < 0 || px >= width || py < 0 || py >= height) {
          continue;
        }
        const expected = finderMask[r][c] === 1;
        if (dark[py * width + px] === expected) {
          agree += 1;
        }
      }
    }
    return agree / 49;
  };

  let modules = 29;
  let bestScore = -1;
  for (let v = 1; v <= 40; v += 1) {
    const n = 21 + 4 * (v - 1);
    const s1 = finderScore(n, 0, 0);
    const s2 = finderScore(n, n - 7, 0);
    const s3 = finderScore(n, 0, n - 7);
    const total = (s1 + s2 + s3) / 3;
    if (total > bestScore) {
      bestScore = total;
      modules = n;
    }
  }
  if (bestScore < 0.6) {
    modules = 29; // 结构匹配失败时兜底
  }
  const modulePx = qrWidth / modules;

  // 5) 每个模块取多数投票确定黑白
  const moduleDark = (mx: number, my: number): boolean => {
    const sx = minX + Math.floor(mx * modulePx);
    const sy = minY + Math.floor(my * modulePx);
    const ex = Math.min(width, minX + Math.ceil((mx + 1) * modulePx));
    const ey = Math.min(height, minY + Math.ceil((my + 1) * modulePx));
    let darkCount = 0;
    let total = 0;
    for (let y = sy; y < ey; y += 1) {
      for (let x = sx; x < ex; x += 1) {
        if (dark[y * width + x]) {
          darkCount += 1;
        }
        total += 1;
      }
    }
    return total > 0 && darkCount * 2 >= total;
  };

  // 6) 半块字符输出：每字符 = 上下 2 行模块，周围留 1 列/行静区
  const quiet = ' '.repeat(modules + 2);
  const lines: string[] = [quiet];
  for (let my = 0; my < modules; my += 2) {
    let line = ' ';
    for (let mx = 0; mx < modules; mx += 1) {
      const top = moduleDark(mx, my);
      const bottom = my + 1 < modules ? moduleDark(mx, my + 1) : false;
      if (top && bottom) {
        line += '█';
      } else if (top) {
        line += '▀';
      } else if (bottom) {
        line += '▄';
      } else {
        line += ' ';
      }
    }
    line += ' ';
    lines.push(line);
  }
  lines.push(quiet);

  return lines.join('\n');
};

/**
 * base64 图片 -> 字符串二维码。
 *
 * 优先“解码 -> 重新编码”：
 *  - 用内置 jsqr 把图片里的二维码解码成它实际表示的链接；
 *  - 再用 qrcode-terminal 把链接编码回终端二维码（保证正方形比例、黑白高对比、可扫码）。
 * 直接对图片做像素字符画（buildAsciiFromPixels）在模块边界为亚像素时不可靠，仅作为兜底。
 */
const renderBase64ImageToQr = async (data: string): Promise<string | null> => {
  const base64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) {
    return null;
  }

  const png = decodePng(buffer);
  if (!png) {
    return null;
  }

  const rgba = new Uint8ClampedArray(png.rgba.buffer, png.rgba.byteOffset, png.rgba.byteLength);
  try {
    const decoded = jsQR(rgba, png.width, png.height);
    if (decoded?.data) {
      return await encodeLinkToQr(decoded.data);
    }
  } catch {
    // 解码失败则走像素兜底
  }

  return buildAsciiFromPixels(png.rgba, png.width, png.height);
};

/** 二维码实际表示的链接字符串 -> 字符串二维码（编码回 QR 输出到终端） */
const encodeLinkToQr = (url: string): Promise<string> =>
  new Promise((resolve) => {
    qrcodeTerminal.generate(url, { small: true }, (qr: string) => resolve(qr));
  });

/**
 * 把二维码转换为可打印到终端的字符串二维码。
 *
 * 仅接受两种输入（见 {@link QrTerminalInput}）：
 *  - base64 格式的图片（data URL 或纯 base64）
 *  - 二维码实际表示的链接字符串
 */
export async function convertQrToTerminalString(input: QrTerminalInput, _options: QrConversionOptions = {}): Promise<string | null> {
  if (input.type === 'link') {
    return encodeLinkToQr(input.url);
  }
  return renderBase64ImageToQr(input.data);
}
