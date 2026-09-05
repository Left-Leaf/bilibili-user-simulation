/**
 * Stealth 浏览器（反自动化检测）封装。
 *
 * 用 `puppeteer-extra` + `puppeteer-extra-plugin-stealth` 消除自动化硬指纹
 * （`navigator.webdriver`、`window.chrome`、`navigator.plugins/languages`、WebGL vendor 等），
 * 让浏览器看起来像真实 Chrome。对应 DESIGN「反检测路线」中的 stealth 项。
 *
 * 用法：`import { stealthPuppeteer } from './stealth'` → `stealthPuppeteer.launch(...)`。
 * `puppeteer.use()` 是全局注册，模块加载时只注册一次（幂等），所有 OpenBrowserBehavior 共享。
 */
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// 初始化 stealth（模块级只执行一次；delete 掉的 evasion 与 legacy init-puppeteer 保持一致）
const stealth = StealthPlugin();
// 移除与自定义/不必要冲突的默认 evasion：
stealth.enabledEvasions.delete('user-agent-override'); // UA 由 Chrome 默认 + --disable-blink-features 处理
stealth.enabledEvasions.delete('navigator.languages'); // 保持系统语言（真实 zh-CN）
stealth.enabledEvasions.delete('webgl.vendor'); // WebGL vendor 交由默认（或按需自定义）
puppeteerExtra.use(stealth);

/** 带 stealth 的 puppeteer 实例（与普通 puppeteer 同 API：launch/newPage 等） */
export const stealthPuppeteer = puppeteerExtra;
