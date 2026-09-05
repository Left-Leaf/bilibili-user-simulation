import { BaseTask, TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { MouseMoveBehavior, LeftClickBehavior, TypeBehavior, KeyPressBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import type { SearchDecider } from './search-decider';

/** B 站顶部搜索栏选择器（多版本候选） */
const SEARCH_BOX_SELECTOR = '.nav-search-input, .search-input-el, input[placeholder*="搜索"]';

/**
 * B 站搜索按钮（多版本候选）：
 * - 首页顶栏：`.nav-search-btn`（放大镜，可见）
 * - 搜索页：顶栏按钮被 CSS 隐藏（尺寸 0），真实可点的是页内大搜索框右侧的蓝色「搜索」按钮
 *   （`button.vui_button.vui_button--blue.vui_button--lg.search-button`），用精确类名定位。
 */
const SEARCH_BUTTON_SELECTOR = '.nav-search-btn, button.search-button';

/** B 站搜索推荐词条（下拉建议项） */
const SUGGEST_ITEM_SELECTOR = '.suggest-item';

/** 搜索特定内容任务的输入：由人格（决策层）在执行时提供 */
export interface SearchTaskInput {
  /** 搜索关键词 */
  keyword: string;
  /** 搜索决策器：决定直接搜索还是使用推荐词条 */
  decider: SearchDecider;
}

/**
 * 搜索特定内容任务：明确目的「搜索指定关键词」的行为集合。
 *
 * - preCheck：识别顶部搜索栏（能识别到才执行）
 * - execute：鼠标移动到搜索栏聚焦 → 模拟键盘输入关键词 → 等待推荐词出现 →
 *   将推荐词交给决策器 → 按决策执行：
 *     - 直接搜索：Enter 与 点击搜索按钮 各 50% 概率触发
 *     - 使用推荐词：点击对应推荐词条
 */
export class SearchTask extends BaseTask {
  constructor(private input: SearchTaskInput) {
    super('Search');
  }

  /** preCheck：识别顶部搜索栏（多候选选择器中可能第一个是隐藏元素 → 遍历取可见的） */
  async preCheck(context: TaskContext): Promise<boolean> {
    const page = context.page;
    if (!page) {
      return false;
    }
    try {
      const handles = await page.$$(SEARCH_BOX_SELECTOR).catch(() => [] as never[]);
      for (const h of handles as never[]) {
        const box = await (h as { boundingBox: () => Promise<{ width: number; height: number } | null> }).boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    const page = context.page!;
    const steps: TaskResult[] = [];

    try {
      // 搜索目标关键词
      const targetKeyword = this.input.keyword;

      // 找出当前可用的搜索页标签（当前页若是搜索页优先用它；否则找栈里其它搜索页）
      let searchTab: NonNullable<TaskContext['page']> | null = null;
      if (page.url().includes('search.bilibili.com')) {
        searchTab = page; // 当前页即搜索页
      } else {
        searchTab = await this.findExistingSearchPage(context);
      }

      if (searchTab) {
        // 目标与搜索页一致 → 直接前往（复用，不新开标签）
        if (this.matchesKeyword(searchTab.url(), targetKeyword)) {
          if (searchTab !== context.page) {
            await searchTab.bringToFront().catch(() => {});
            context.page = searchTab;
          }
          this.log(`🔍 复用已有搜索标签页: ${searchTab.url().slice(0, 80)}`);
          return {
            success: true,
            data: {
              keyword: this.input.keyword,
              searched: this.keywordFromUrl(searchTab.url()) ?? this.input.keyword,
              trigger: 'reuse',
              steps: steps.length,
              url: searchTab.url(),
              viaPopup: false,
              reused: true,
            },
            nextState: MainState.SEARCH_RESULT,
          };
        }
        // 目标与搜索页不一致 → 在该搜索页搜索栏重新输入搜索（当前页直接刷新，不新开标签）
        if (searchTab !== context.page) {
          await searchTab.bringToFront().catch(() => {});
          context.page = searchTab;
        }
        this.log(`🔍 在已有搜索标签页重新输入搜索: ${this.input.keyword}`);
        const reres = await this.performSearch(context, this.input.keyword);
        this.log(`🔍 重新搜索：${this.input.keyword}（触发：${reres.trigger}）`);
        return {
          success: true,
          data: {
            keyword: this.input.keyword,
            searched: reres.searched,
            trigger: reres.trigger,
            steps: reres.steps,
            url: reres.url,
            viaPopup: reres.viaPopup,
            reused: true,
          },
          nextState: MainState.SEARCH_RESULT,
        };
      }

      // 无已有搜索页 → 正常搜索流程（performSearch 内部：非搜索页搜索 → window.open 新标签）
      const res = await this.performSearch(context, this.input.keyword);
      this.log(`🔍 搜索：${this.input.keyword}（触发：${res.trigger}）`);
      return {
        success: true,
        data: {
          keyword: this.input.keyword,
          searched: res.searched,
          trigger: res.trigger,
          steps: res.steps,
          url: res.url,
          viaPopup: res.viaPopup,
        },
        nextState: MainState.SEARCH_RESULT,
      };
    } catch (error) {
      return {
        success: false,
        error: `搜索失败: ${(error as Error).message}`,
        data: { steps: steps.length },
      };
    }
  }

  /**
   * 执行搜索交互（聚焦搜索栏 → 输入关键词 → 决策 → 触发搜索 → 捕获结果页并切换）。
   * - 在搜索页内重搜：当前页直接刷新（不新开标签，findSearchPage 也会匹配到当前页 → viaPopup=false）
   * - 在非搜索页搜索：B 站 window.open 新标签页（findSearchPage 匹配新标签 → viaPopup=true）
   * 返回 {searched, trigger, url, viaPopup, steps}；失败抛错。
   */
  private async performSearch(
    context: TaskContext,
    keyword: string
  ): Promise<{ searched: string; trigger: string; url: string; viaPopup: boolean; steps: number }> {
    const page = context.page!;
    const steps: TaskResult[] = [];

    // 解析搜索框坐标
    const boxResolved = await MousePositionManager.instance.resolveTarget(page, SEARCH_BOX_SELECTOR);
    if (!boxResolved.point && !boxResolved.alreadyClicked) {
      throw new Error('找不到搜索栏');
    }
    if (!boxResolved.alreadyClicked) {
      // 行为1：鼠标移动到搜索栏
      const mv = await new MouseMoveBehavior(boxResolved.point!).execute(context);
      steps.push(mv);
      if (!mv.success) {
        throw new Error(mv.error);
      }

      // 行为2：鼠标点击搜索栏聚焦
      const cl = await new LeftClickBehavior(boxResolved.point!).execute(context);
      steps.push(cl);
      if (!cl.success) {
        throw new Error(cl.error);
      }
    }

    // 行为3：模拟键盘输入关键词
    const ty = await new TypeBehavior(keyword).execute(context);
    steps.push(ty);
    if (!ty.success) {
      throw new Error(ty.error);
    }

    // 等待推荐词出现，全部提供给决策器
    const suggestions = await this.waitForSuggestions(page);
    const decision = this.input.decider.decide(keyword, suggestions);
    console.log(
      `   决策: ${decision.type === 'direct' ? '直接搜索' : `使用推荐词[${decision.index}]="${suggestions[decision.index] ?? ''}"`}`
    );

    // 行为4：按决策触发搜索
    let trigger: string;
    if (decision.type === 'suggestion') {
      // 使用下方推荐词条：点击对应词条
      const item = await page.$$(SUGGEST_ITEM_SELECTOR).catch(() => [] as never[]);
      const target = (item as unknown[])[decision.index];
      if (!target) {
        throw new Error(`推荐词条不存在（index=${decision.index}）`);
      }
      const sugResolved = await MousePositionManager.instance.resolveTarget(page, target as never);
      if (!sugResolved.point && !sugResolved.alreadyClicked) {
        throw new Error(`推荐词条不可点击（index=${decision.index}）`);
      }
      if (!sugResolved.alreadyClicked) {
        const sc = await new LeftClickBehavior(sugResolved.point!).execute(context);
        steps.push(sc);
        if (!sc.success) {
          throw new Error(sc.error);
        }
      }
      trigger = `suggestion#${decision.index}`;
    } else {
      // 直接搜索：Enter 与点击搜索按钮各 50%
      if (Math.random() < 0.5) {
        const kp = await new KeyPressBehavior('Enter').execute(context);
        steps.push(kp);
        if (!kp.success) {
          throw new Error(kp.error);
        }
        trigger = 'Enter';
      } else {
        const btnResolved = await MousePositionManager.instance.resolveTarget(page, SEARCH_BUTTON_SELECTOR);
        if (!btnResolved.point && !btnResolved.alreadyClicked) {
          throw new Error('找不到搜索按钮');
        }
        if (!btnResolved.alreadyClicked) {
          const sb = await new LeftClickBehavior(btnResolved.point!).execute(context);
          steps.push(sb);
          if (!sb.success) {
            throw new Error(sb.error);
          }
        }
        trigger = '搜索按钮';
      }
    }

    // 等待并捕获搜索结果页：
    // - 搜索页内重搜 → 当前页直接刷新（findSearchPage 匹配到当前页，viaPopup=false）
    // - 非搜索页搜索 → window.open 新标签（findSearchPage 匹配新标签，viaPopup=true）
    const searchKeyword = decision.type === 'suggestion' ? (suggestions[decision.index] ?? keyword) : keyword;
    await this.sleepReal(1500); // 功能性等待：等导航/新标签触发
    const searchPage = await this.findSearchPage(context, searchKeyword);
    if (!searchPage) {
      throw new Error('触发搜索后未打开搜索结果页（无当前页跳转，也未打开新标签页）');
    }
    context.page = searchPage;
    return {
      searched: searchKeyword,
      trigger,
      url: searchPage.url(),
      viaPopup: searchPage !== page,
      steps: steps.length,
    };
  }

  /** 等待推荐词出现并提取全部推荐词（最多等 3 秒；功能性等待，不走时间缩放） */
  private async waitForSuggestions(page: NonNullable<TaskContext['page']>): Promise<string[]> {
    for (let i = 0; i < 15; i++) {
      const items = await page.$$(SUGGEST_ITEM_SELECTOR).catch(() => [] as never[]);
      if (items.length > 0) {
        const texts = await page
          .$$eval(SUGGEST_ITEM_SELECTOR, (els) => els.map((el) => (el.textContent ?? '').trim()))
          .catch(() => [] as string[]);
        return texts.filter(Boolean);
      }
      await this.sleepReal(200);
    }
    return [];
  }

  /** 在所有标签页中查找搜索结果页（B 站搜索通过 window.open 打开新标签页） */
  private async findSearchPage(context: TaskContext, keyword: string): Promise<NonNullable<TaskContext['page']> | null> {
    const browser = context.browser;
    if (!browser) {
      return null;
    }
    const kw = keyword.toLowerCase();

    // 轮询最多 5 秒，等待新标签页 URL 就绪（功能性等待，不走时间缩放）
    for (let i = 0; i < 10; i++) {
      const pages = await browser.pages().catch(() => [] as NonNullable<TaskContext['page']>[]);
      for (const p of pages) {
        const url = p.url();
        if (url.includes('search.bilibili.com')) {
          // 关键词匹配（可选：URL 含 keyword 才认为是本任务的结果页）
          if (!kw || decodeURIComponent(url).toLowerCase().includes(kw)) {
            return p;
          }
        }
      }
      await this.sleepReal(500);
    }
    return null;
  }

  /** 在现有标签页中查找已存在的搜索页（复用/重搜，不新开标签；排除当前页） */
  private async findExistingSearchPage(context: TaskContext): Promise<NonNullable<TaskContext['page']> | null> {
    const browser = context.browser;
    if (!browser) {
      return null;
    }
    const pages = await browser.pages().catch(() => [] as NonNullable<TaskContext['page']>[]);
    return pages.find((p) => p !== context.page && p.url().includes('search.bilibili.com')) ?? null;
  }

  /** 搜索结果页 URL 是否匹配关键词（大小写不敏感，容忍 URL 编码与多余参数） */
  private matchesKeyword(url: string, keyword: string): boolean {
    const kw = keyword.trim().toLowerCase();
    if (!kw) {
      return false;
    }
    try {
      const kwParam = new URL(url).searchParams.get('keyword');
      if (kwParam) {
        return decodeURIComponent(kwParam).toLowerCase() === kw;
      }
    } catch {
      /* 解析失败则走 URL 包含匹配 */
    }
    return decodeURIComponent(url).toLowerCase().includes(kw);
  }

  /** 从搜索结果页 URL 提取关键词（search.bilibili.com/all?keyword=X） */
  private keywordFromUrl(url: string): string | null {
    try {
      const kw = new URL(url).searchParams.get('keyword');
      return kw ? decodeURIComponent(kw) : null;
    } catch {
      return null;
    }
  }
}
