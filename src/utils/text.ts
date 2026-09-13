/**
 * 文本截断 / 清洗：**凡是「可能包含任意 Unicode 的文本」的截断，都必须走这里**。
 *
 * 为什么不能直接 `String.prototype.slice`：
 * JS 字符串是 UTF-16 序列，`slice` 按**码元**剪，emoji（代理对，如 😂 = `\uD83D\uDE02`）
 * 正好跨在边界上就会被劈成半个代理字符（**孤立代理**）。这种字符串一旦离开本进程：
 * 1. `JSON.stringify` 会把它写成转义 `"\ud83d"`（而不是真实字符）；
 * 2. 宿主（如 Python）`json.loads` 会把它原样还原成一个孤立代理字符的 `str`；
 * 3. 该 `str` **无法编码成 UTF-8**：`ensure_ascii=False` + `.encode('utf-8')` 直接抛
 *    `surrogates not allowed` —— 表现为宿主侧状态刷新 / 日志落盘持续失败。
 *
 * 所以截断一律按**完整字符**（grapheme cluster）走，绝不劈开代理对；顺带把任何来源的
 * 孤立代理字符替换成 U+FFFD（本身是合法可编码字符）。
 *
 * 使用约定：
 * - **文本**（标题 / UP 名 / 动态与评论正文 / `page.title()` 等）→ `clipText()`；
 * - **结构串**（URL、`className`、base64 data URL）可以直接 `slice()`：Chrome 的
 *   `location.href` / `a.href` 一律输出百分号编码的 ASCII，不含代理对（DOM 文本本身也是
 *   良构的 —— 是我们自己按码元截断才造出孤立代理，所以「文本」必须走这里）。
 *
 * ⚠️ 页面上下文（`page.evaluate` 回调在浏览器里执行）调不到本模块：那里的做法是
 * **返回完整文本，回到 Node 侧再用 `clipText()` 截断**。
 */

/** 是否存在代理码元（`\uD800`–`\uDFFF`）：绝大多数字符串都不含，用作快速路径（非全局，`.test` 无状态） */
const SURROGATE_RE = /[\uD800-\uDFFF]/;

/**
 * 把**孤立代理字符**替换为 U+FFFD（合法代理对原样保留）。
 * 不含代理码元的字符串直接原样返回（不产生新字符串）。
 */
export function sanitizeLoneSurrogates(text: string): string {
  if (!SURROGATE_RE.test(text)) {
    return text;
  }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1]; // 合法代理对（emoji 等星形平面字符）：整对保留
        i++;
      } else {
        out += '\uFFFD'; // 高代理后面没跟低代理 = 孤立字符
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\uFFFD'; // 低代理前面没跟高代理 = 孤立字符
    } else {
      out += text[i];
    }
  }
  return out;
}

/** 字素切分器（Node 16+ 自带完整 ICU；取不到时退化为码点级，仍不会劈开代理对） */
const graphemeSegmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** 按「完整字符」切分：优先字素（组合 emoji / 旗帜 / 肤色不被拆开），退化时按码点 */
function toCharacters(text: string): string[] {
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), (seg) => seg.segment);
  }
  return Array.from(text);
}

/**
 * 按**完整字符**截断到最多 `maxLength` 个字符（不劈开 emoji / 代理对），并顺带清洗孤立代理字符。
 *
 * - 不含省略号：与 `slice` 保持「前缀」语义（下游可能按前缀匹配，如 UP 名匹配），
 *   只是把「码元」换成「完整字符」；
 * - 未超长时原样返回（文字本身没被改写，只有孤立代理字符会被替换为 U+FFFD）。
 */
export function clipText(text: string | null | undefined, maxLength: number): string {
  const raw = sanitizeLoneSurrogates(text ?? '');
  if (maxLength <= 0) {
    return '';
  }
  // 码元数 ≤ 上限 → 一定不需要截断（码元数恒 ≥ 字符数），免去字素切分开销
  if (raw.length <= maxLength) {
    return raw;
  }
  return toCharacters(raw).slice(0, maxLength).join('');
}
