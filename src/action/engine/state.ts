/**
 * 动作引擎的状态模型（对应 DESIGN 6.1 分层状态）。
 */

/** 主状态（页面级别 + 登录前置状态） */
export enum MainState {
  LOGGED_IN = 'logged_in', // 已登录（后续所有任务生成的前置状态）
  HOME_FEED = 'home_feed', // 首页推荐流
  DYNAMIC_FEED = 'dynamic_feed', // 关注动态流
  CONTENT_CONSUMING = 'content_consuming', // 正在消费内容（视频/文章/直播/评论）
  SEARCH_RESULT = 'search_result', // 搜索结果页
  USER_PROFILE = 'user_profile', // 用户主页/空间
  BROWSER_CLOSED = 'browser_closed', // 浏览器关闭（终止状态）
}

/** 内容消费子状态（CONTENT_CONSUMING 内部） */
export enum ContentSubState {
  VIDEO_FIRST_3S = 'video_first_3s', // 前3秒判断期（高秒关概率）
  VIDEO_WATCHING = 'video_watching', // 正常观看中
  VIDEO_NEAR_END = 'video_near_end', // 快看完了（80%+）
  VIDEO_RECOMMEND_LIST = 'video_recommend_list', // 在看推荐列表（连刷入口）
  ARTICLE_READING = 'article_reading', // 看专栏/图文
  LIVE_WATCHING = 'live_watching', // 看直播
  COMMENT_BROWSING = 'comment_browsing', // 浏览评论区
}

/** 运行时状态 */
export interface RuntimeState {
  main: MainState;
  sub: ContentSubState | null; // 仅在 CONTENT_CONSUMING 时有值
  enteredAt: number; // 进入此主状态的时间戳
}

/** 页面状态（用于转移矩阵统计） */
export type PageState = MainState;

export const MAIN_STATES: readonly MainState[] = [
  MainState.LOGGED_IN,
  MainState.HOME_FEED,
  MainState.DYNAMIC_FEED,
  MainState.CONTENT_CONSUMING,
  MainState.SEARCH_RESULT,
  MainState.USER_PROFILE,
  MainState.BROWSER_CLOSED,
];

export const CONTENT_SUB_STATES: readonly ContentSubState[] = [
  ContentSubState.VIDEO_FIRST_3S,
  ContentSubState.VIDEO_WATCHING,
  ContentSubState.VIDEO_NEAR_END,
  ContentSubState.VIDEO_RECOMMEND_LIST,
  ContentSubState.ARTICLE_READING,
  ContentSubState.LIVE_WATCHING,
  ContentSubState.COMMENT_BROWSING,
];

/** 主状态在矩阵中的索引 */
export function mainStateIndex(state: MainState): number {
  return MAIN_STATES.indexOf(state);
}

/** 索引 → 主状态 */
export function indexToMainState(index: number): MainState {
  return MAIN_STATES[index] ?? MainState.HOME_FEED;
}

/** 创建一个运行时状态 */
export function createRuntimeState(main: MainState, sub: ContentSubState | null = null, enteredAt: number = Date.now()): RuntimeState {
  return { main, sub, enteredAt };
}
