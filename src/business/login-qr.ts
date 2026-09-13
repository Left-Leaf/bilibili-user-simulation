/**
 * 登录二维码的「对外输出」通道（与终端打印并列）。
 *
 * 背景：扫码登录时二维码原本只打印到控制台，**宿主进程（如 Flutter App）拿不到**，
 * 无法在自己的界面上呈现二维码。这里提供一个出口，让宿主**在调用登录时直接传回调**拿到二维码数据。
 *
 * 接入方式（内核）：把回调传给 `kernel.login({ onQrcode })` —— 这是**唯一**入口，
 * 内核在登录流程期间把它接到这里（流程结束 / 抛异常都自动摘除）。
 *
 * 注意：`initialize()` **不接受** `onQrcode`（它内置的登录等待只打印到控制台）。
 * 若要在初始化阶段就把二维码交给宿主渲染：
 * ```ts
 * await kernel.initialize({ waitForLogin: false });
 * await kernel.login({ onQrcode });
 * ```
 *
 * ⚠️ 一次登录里二维码可能被发布多次（首次 + 过期自动刷新后重打），
 * 宿主用 `fingerprint` 判断「是不是换了新码」（内容不变 = 同一张码，不必重建界面）。
 */
import { convertQrForOutput, type QrTerminalInput } from '../utils/terminal-qr';

/**
 * 一张登录二维码（对外输出负载）。
 * `url` 与 `imageBase64` 至少有一个：图片来源解得出链接时两者都有。
 */
export interface LoginQrPayload {
  /** 二维码实际表示的登录链接（图片也会尽力解出；解不出则为 undefined） */
  url?: string;
  /** 二维码图片（`data:image/png;base64,...`，可直接交给图片控件渲染） */
  imageBase64?: string;
  /** 指纹（内容串）：同一次登录里不变 = 同一张码；变了 = 换了新码 */
  fingerprint: string;
  /** 生成时间（毫秒时间戳） */
  at: number;
}

/** 登录二维码回调（宿主在 `login()` / `initialize()` 的选项里提供） */
export type LoginQrHandler = (qr: LoginQrPayload) => void;

let loginQrHandler: LoginQrHandler | null = null;

/**
 * 接入 / 摘除登录二维码回调（内核在 `login()` 的登录流程期间调用）；
 * 传 `null` = 本次登录不对外输出（终端打印照常）。
 */
export function setLoginQrHandler(handler: LoginQrHandler | null): void {
  loginQrHandler = handler;
}

/**
 * 发布一张登录二维码：**同时**输出到「终端打印」与「宿主回调」（若本次登录传了 `onQrcode`）。
 *
 * 调用方（`ScanQrBehavior` / `LoginTask`）只负责从页面提取，不用关心输出方式；
 * 两条输出共用**同一次**二维码解码（`convertQrForOutput`）。
 *
 * @param input 页面提取到的二维码信息；`null` = 本次没取到
 * @returns 指纹（内容串；未取到二维码返回 `null`），供调用方比对「是否换码」
 */
export async function publishLoginQr(input: QrTerminalInput | null): Promise<string | null> {
  if (!input) {
    console.log('\n📱 请在浏览器窗口中扫描二维码完成登录（本次未取到二维码图片）\n');
    return null;
  }

  const fingerprint = input.type === 'link' ? input.url : input.data;
  const { link, terminal } = await convertQrForOutput(input).catch(() => ({ link: null, terminal: null }));

  // ① 对外输出（宿主提供 onQrcode 时）：宿主界面自行渲染（单次解码，与下方终端打印共用）
  if (loginQrHandler) {
    const payload: LoginQrPayload = {
      fingerprint,
      at: Date.now(),
      ...(link ? { url: link } : {}),
      ...(input.type === 'base64-image' ? { imageBase64: input.data } : {}),
    };
    try {
      loginQrHandler(payload);
    } catch {
      /* 回调异常不影响登录流程（同处还负责终端打印） */
    }
  }

  // ② 终端打印（无头模式下可拿手机扫控制台里的二维码）
  if (terminal) {
    console.log('\n=== Bilibili 登录二维码 ===\n');
    console.log(terminal);
    console.log('\n请使用手机 Bilibili App 扫码登录。\n');
  } else if (loginQrHandler) {
    console.log('\n📱 请在浏览器窗口中扫描二维码完成登录（二维码已通过回调交给宿主）\n');
  } else {
    console.log('\n📱 请在浏览器窗口中扫描二维码完成登录\n');
  }

  return fingerprint;
}
