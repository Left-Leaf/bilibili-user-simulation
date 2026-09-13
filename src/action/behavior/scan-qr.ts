import type { TaskContext } from '../execute/context';
import { BaseBehavior, type BehaviorResult } from './types';
import { extractLoginQrInfo } from './extract-login-qr';
import { publishLoginQr } from '../../business/login-qr';

/**
 * 扫码登录（原子行为）：等待登录弹窗中的二维码出现，
 * 提取二维码并**发布**（终端打印 + 对外通道，见 `publishLoginQr`），返回给任务层做登录判定。
 */
export class ScanQrBehavior extends BaseBehavior {
  constructor(private timeoutMs = 30000) {
    super('ScanQr');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      console.log('⏳ 等待二维码加载...');
      await page
        .waitForFunction(
          () => {
            if (/^https:\/\/account\.bilibili\.com\//.test(location.href)) return true;
            const box = document.querySelector('.login-scan-box, .scan-box');
            if (!box) return false;
            if (box.querySelector('canvas')) return true;
            const img = box.querySelector('img');
            return !!img && /^data:image\//.test(img.currentSrc || img.getAttribute('src') || '');
          },
          { timeout: this.timeoutMs }
        )
        .catch(() => null);

      // 提取二维码并发布（终端打印 + 对外通道）——输出细节统一在 publishLoginQr，本行为不关心
      const qrInfo = await extractLoginQrInfo(page).catch(() => null);
      await publishLoginQr(qrInfo).catch(() => null);
      return this.ok();
    } catch (error) {
      return this.fail(`扫码失败: ${(error as Error).message}`);
    }
  }
}
