import type { Page } from 'puppeteer-core';
import type { QrTerminalInput } from '../../utils/terminal-qr';

/**
 * 在“已点击登录入口、登录弹窗已打开”的 B 站页面中提取登录二维码信息。
 *
 * 职责：只负责从页面 DOM 分析、提取登录二维码，输出限定为 utils 转换函数接受的输入：
 *  - {@link QrTerminalInput.base64-image}：base64 格式的二维码图片
 *  - {@link QrTerminalInput.link}：二维码实际表示的登录链接字符串
 *
 * 关键约束：
 *  - **只在登录弹窗容器内查找**（`.login-scan-box` / `.scan-box`），
 *    绝不回退到整页扫描——整页里存在“下载客户端”等其他二维码，会抓到错误目标。
 *  - 二维码图片是异步填充的（容器先出现、图片后加载），因此会在超时内轮询重试，
 *    直到容器内出现 data URL 图片或 canvas。
 *  - 所有选择器/正则都定义在 evaluate 回调内部（模块级常量在浏览器上下文不可见）。
 */
export async function extractLoginQrInfo(page: Page, timeoutMs = 15000): Promise<QrTerminalInput | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate((): QrTerminalInput | null => {
      const qrContainerSelectors = ['.login-scan-box', '.scan-box'];

      const findQrContainer = (): HTMLElement | null => {
        for (const selector of qrContainerSelectors) {
          const el = document.querySelector(selector) as HTMLElement | null;
          if (el) {
            return el;
          }
        }
        return null;
      };

      const container = findQrContainer();
      if (!container) {
        return null;
      }

      // 1) canvas -> toDataURL 得到 base64 图片
      const canvas = container.querySelector('canvas');
      if (canvas) {
        try {
          const dataUrl = canvas.toDataURL('image/png');
          if (dataUrl.startsWith('data:image/')) {
            return { type: 'base64-image', data: dataUrl };
          }
        } catch {
          // 画布被跨域内容污染时 toDataURL 会抛错，忽略并继续
        }
      }

      // 2) 容器内的 img 且 src 是 data URL -> base64 图片（B 站登录弹窗即此形式）
      for (const img of Array.from(container.querySelectorAll('img'))) {
        const src = img.currentSrc || img.getAttribute('src') || '';
        if (src.startsWith('data:image/')) {
          return { type: 'base64-image', data: src };
        }
      }

      return null;
    });

    if (result) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // 仍未找到：输出登录弹窗容器的诊断信息，便于定位
  const diagnostic = await page.evaluate(() => {
    const box = document.querySelector('.login-scan-box, .scan-box');
    if (!box) {
      return { boxFound: false };
    }
    return {
      boxFound: true,
      boxCls: String(box.className).slice(0, 60),
      imgs: Array.from(box.querySelectorAll('img')).map((img) => ({
        alt: img.getAttribute('alt'),
        srcStart: (img.currentSrc || img.getAttribute('src') || '').slice(0, 30),
        srcLen: (img.currentSrc || img.getAttribute('src') || '').length,
      })),
      canvases: Array.from(box.querySelectorAll('canvas')).map((c) => ({ w: c.width, h: c.height })),
    };
  });
  console.warn('[extract-login-qr] 未提取到登录二维码，弹窗容器状态：', JSON.stringify(diagnostic));

  return null;
}
