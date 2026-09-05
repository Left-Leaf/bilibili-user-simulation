// action 目录遵循单一职责原则：
// 1. behavior：原子行为（鼠标移动/点击/滚动/停留/观看/扫码/搜索/关闭标签页/关闭浏览器...）
// 2. task：明确目的的行为集合（打开浏览器、导航、扫码登录、浏览页面等）
// 3. generate：生成/决策任务流（状态转移、动态生成下一步任务）
// 4. execute：执行引擎与上下文（任务执行器、任务上下文、日志）
// 5. engine：拟人动作引擎（拟人鼠标、滚动、停留时长采样）

export * from './behavior';
export * from './task';
export * from './generate';
export * from './execute';
