/**
 * 临时探针（验证后删除）：文本截断不得把 emoji 劈成**孤立代理字符**。
 *
 * 复现链路（用户报的缺陷）：
 *   `dynText(item).slice(0, 60)` 按 **UTF-16 码元**剪 → emoji 跨在边界上被劈成半个代理字符
 *   → `JSON.stringify` 写成转义 `"\ud83d"` → 宿主 `json.loads` 还原成孤立代理 `str`
 *   → `ensure_ascii=False` + `.encode('utf-8')` 抛 `surrogates not allowed`。
 */
import fs from 'node:fs';
import { attachDynamicFeedListener, dynText, setFetchBaseline } from '../src/business/passive-fetch.js';
import { clipText, sanitizeLoneSurrogates } from '../src/utils/text.js';
import type { Page } from 'puppeteer-core';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}`);
  }
};

/** 是否存在孤立代理字符（高/低代理未成对） */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) {
        return true;
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** JSON.stringify 是否把它写成了 `\ud8xx`–`\udbxx` 转义（= 孤立代理的痕迹） */
const escapesLoneSurrogate = (s: string): boolean => /\\ud[89ab][0-9a-f]{2}/i.test(JSON.stringify(s));

const EMOJI = '😂'; // U+1F602 = 高代理 D83D + 低代理 DE02

// ===== ① 复现原缺陷：按码元 slice 会劈开 emoji =====
console.log('===== ① 复现：`.slice(0, 60)` 劈开 emoji =====');
const longText = 'A'.repeat(59) + EMOJI + 'B'.repeat(10); // 第 59、60 个码元正好是 emoji 的两个代理
const sliced = longText.slice(0, 60);
ok(sliced.length === 60, 'slice 结果长度 = 60 码元');
ok(sliced.charCodeAt(59) === 0xd83d, `末位码元是孤立高代理（U+${sliced.charCodeAt(59).toString(16).toUpperCase()}）`);
ok(hasLoneSurrogate(sliced), 'slice 结果含孤立代理字符（缺陷复现成功）');
ok(escapesLoneSurrogate(sliced), 'JSON.stringify 把它写成 \\ud83d 转义（宿主 json.loads 会还原成孤立代理）');

// ===== ② clipText：按完整字符截断 =====
console.log('===== ② clipText：按完整字符截断 =====');
const clipped = clipText(longText, 60);
ok(clipped === 'A'.repeat(59) + EMOJI, '结果 = 59 个 A + 完整 emoji（不劈开）');
ok(!hasLoneSurrogate(clipped), '不含孤立代理字符');
ok(!escapesLoneSurrogate(clipped), 'JSON.stringify 不含 \\ud8xx 转义');
ok(clipped.length === 61, `码元长度 61（emoji 占 2 个码元，但仍是 1 个字符）`);
ok(Buffer.from(clipped, 'utf8').toString('utf8') === clipped, 'UTF-8 往返一致（可安全编码）');

// ===== ③ 语义：前缀风格、不超上限 =====
console.log('===== ③ 截断语义 =====');
ok(clipText('😀😀😀', 2) === '😀😀', '3 个 emoji 截到 2 → 前 2 个完整 emoji');
ok(clipText('😀😀', 2) === '😀😀', '正好 2 个字符 → 原样返回');
ok(clipText('你好世界', 2) === '你好', 'CJK 同 slice 行为（1 码元 = 1 字符）');
ok(clipText('abc', 0) === '' && clipText('abc', -1) === '', 'maxLength <= 0 → 空串');
ok(clipText(null, 5) === '' && clipText(undefined, 5) === '', 'null / undefined → 空串');
ok(clipText('A'.repeat(100), 60) === 'A'.repeat(60), '纯 ASCII 行为与 slice 完全一致（前缀语义不变）');

// ===== ④ 组合字素：人体/家庭 emoji 不被拆开（Node 有 Intl.Segmenter） =====
console.log('===== ④ 组合字素 =====');
const family = '👨‍👩‍👧'; // 由 3 个 emoji + ZWJ 组成 1 个字素
const hasSegmenter = typeof Intl !== 'undefined' && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function';
ok(
  hasSegmenter ? clipText(family + 'x', 1) === family : clipText(family + 'x', 1).length > 0,
  hasSegmenter ? 'Intl.Segmenter 可用：家庭 emoji 完整保留（未劈成单个成员）' : 'Intl.Segmenter 不可用：退化为码点级（仍不会劈开代理对）'
);

// ===== ⑤ 孤立代理清洗 =====
console.log('===== ⑤ 孤立代理清洗 =====');
ok(sanitizeLoneSurrogates('\uD83D') === '\uFFFD', '孤立高代理 → U+FFFD');
ok(sanitizeLoneSurrogates('a\uDE02b') === 'a\uFFFDb', '孤立低代理 → U+FFFD');
ok(sanitizeLoneSurrogates(EMOJI) === EMOJI, '合法代理对（emoji）原样保留');
ok(sanitizeLoneSurrogates('普通文本') === '普通文本', '无代理码元 → 原样返回');
ok(!hasLoneSurrogate(clipText('坏名字\uD83D尾巴', 100)), 'clipText 对未超长的文本也会清洗孤立代理');
ok(clipText('坏名字\uD83D尾巴', 100).includes('坏名字'), '清洗不破坏其余内容');

// ===== ⑥ dynText 自身 =====
console.log('===== ⑥ dynText 自身按完整字符截断 =====');
const item = {
  type: 'DYNAMIC_TYPE_WORD',
  modules: { module_dynamic: { desc: { text: longText } } },
};
ok(!hasLoneSurrogate(dynText(item, 60)), 'dynText(item, 60) 不含孤立代理');
ok(dynText(item, 60).endsWith(EMOJI), 'dynText(item, 60) 以完整 emoji 结尾');

// ===== ⑦ 端到端：真实投递路径打印的摘要行 =====
console.log('===== ⑦ 端到端：蹲饼摘要日志行 =====');
let responseHandler: ((response: unknown) => void) | null = null;
const fakePage = {
  on: (event: string, cb: (response: unknown) => void): void => {
    if (event === 'response') {
      responseHandler = cb;
    }
  },
} as unknown as Page;
attachDynamicFeedListener(fakePage);
ok(!!responseHandler, '已挂上 response 监听（假 Page）');

const nowSec = Math.floor(Date.now() / 1000);
setFetchBaseline(nowSec - 10);
const dynItem = {
  id_str: 'probe-1',
  type: 'DYNAMIC_TYPE_WORD',
  modules: {
    module_author: { mid: 12345, name: '坏名字\uD83D', pub_ts: String(nowSec) },
    module_dynamic: { desc: { text: longText } },
  },
};

const lines: string[] = [];
const origLog = console.log;
console.log = (...args: unknown[]): void => {
  lines.push(args.map((a) => String(a)).join(' '));
};
responseHandler!({
  url: () => 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=all',
  json: async () => ({ code: 0, data: { items: [dynItem], update_num: 0 } }),
});
await new Promise((r) => setTimeout(r, 150));
console.log = origLog;

const summary = lines.find((l) => l.includes('   - ')) ?? '';
ok(!!summary, `摘要行已打印：${summary.slice(0, 90)}`);
ok(!hasLoneSurrogate(summary), '摘要行不含孤立代理字符（作者名已清洗 + 正文按完整字符截断）');
ok(!escapesLoneSurrogate(summary), '摘要行 JSON 化后不含 \\ud8xx 转义');
ok(summary.includes(EMOJI), '摘要行含完整 emoji（emoji 未被劈掉）');
ok(summary.includes('坏名字'), '作者名清洗后保留可读部分');

// ===== ⑧ 宿主链路（Python）：写文件供 python 复核 =====
const outFile = new URL('./_probe-lines.json', import.meta.url);
fs.writeFileSync(outFile, JSON.stringify({ old: sliced, new: summary }), 'utf-8');
console.log('===== ⑧ 宿主链路样本已写出 =====');
console.log(`  old（.slice 旧写法）含孤立代理: ${hasLoneSurrogate(sliced)}`);
console.log(`  new（现在）含孤立代理: ${hasLoneSurrogate(summary)}`);

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}（共 ${pass + fail} 项：通过 ${pass} / 失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
