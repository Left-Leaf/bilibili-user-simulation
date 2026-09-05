/**
 * 搜索决策器：决定搜索的触发方式。
 *
 * 决策器在「键入搜索词、页面出现推荐词」后调用：
 * - 提供全部推荐词（suggestions）给决策器
 * - 由决策器决定是「直接搜索」还是「改用下方某个推荐词条」
 *
 * 直接搜索的触发（Enter / 点击搜索按钮）由 SearchTask 内部按 50% 概率决定，
 * 决策器只需给出「直接搜索」或「使用第几个推荐词」。
 */
export type SearchDecision = { type: 'direct' } | { type: 'suggestion'; index: number };

/** 搜索决策器抽象基类（衡量标准为虚方法 decide，由实现类实现） */
export abstract class SearchDecider {
  /**
   * 根据关键词与推荐词列表决定搜索方式。
   * @param keyword 用户键入的关键词
   * @param suggestions 页面出现的全部推荐词（可能为空）
   */
  abstract decide(keyword: string, suggestions: string[]): SearchDecision;
}

/** 决策器：每次都直接搜索（不使用推荐词） */
export class DirectSearchDecider extends SearchDecider {
  decide(_keyword: string, _suggestions: string[]): SearchDecision {
    return { type: 'direct' };
  }
}

/** 决策器：每次都选择推荐词列表的第一个进行搜索 */
export class FirstSuggestionDecider extends SearchDecider {
  decide(_keyword: string, suggestions: string[]): SearchDecision {
    if (suggestions.length === 0) {
      // 无推荐词时退化为直接搜索
      return { type: 'direct' };
    }
    return { type: 'suggestion', index: 0 };
  }
}
