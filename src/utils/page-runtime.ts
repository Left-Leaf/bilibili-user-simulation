/**
 * 页面运行时 shim（运行器兼容层）。
 *
 * **背景**：tsx 等基于 esbuild 且开启 `keepNames` 的运行器，会把回调里的**具名函数绑定**改写成
 * `const f = __name((…) => …, "f")`。而 `page.evaluate(fn)` 是把函数**序列化成字符串**送进浏览器执行的，
 * 页面上下文里没有 `__name` → 回调抛 `ReferenceError: __name is not defined` →
 * 被各处的 try/catch 吞掉，表现为「读不到数据」（例如关注时读到空名称）。
 *
 * **处理**：给每个页面注入同名 shim（幂等；用**纯字符串表达式**下发，自身不受转译影响）：
 * - `evaluateOnNewDocument` → 覆盖后续所有导航；
 * - `evaluate` → 覆盖当前文档；
 * - `attachPageRuntimeShim(browser)` → 额外监听 `targetcreated`，新建标签页自动覆盖。
 */
import type { Browser, Page } from 'puppeteer-core';

/** 幂等注入：页面里没有 __name 时才定义（返回 target 本身，等价于 esbuild 的 keepNames 语义） */
const SHIM = '(() => { globalThis.__name = globalThis.__name ?? ((target) => target); })();';

/** 给单个页面注入 shim（当前文档 + 后续导航；失败不抛错，不影响主流程） */
export async function installPageRuntimeShim(page: Page): Promise<void> {
  await Promise.allSettled([page.evaluate(SHIM), page.evaluateOnNewDocument(SHIM)]);
}

/**
 * 给浏览器下**所有页面**注入 shim，并监听后续新建的标签页。
 * 在浏览器启动后调用一次即可（OpenBrowserBehavior 已内置）。
 */
export async function attachPageRuntimeShim(browser: Browser): Promise<void> {
  try {
    browser.on('targetcreated', (target) => {
      if (target.type() !== 'page') {
        return;
      }
      void (async () => {
        const page = await target.page().catch(() => null);
        if (page) {
          await installPageRuntimeShim(page);
        }
      })();
    });
  } catch {
    /* 监听注册失败不影响主流程 */
  }
  const pages = await browser.pages().catch(() => [] as Page[]);
  await Promise.all(pages.filter((p) => !p.isClosed()).map((p) => installPageRuntimeShim(p)));
}
