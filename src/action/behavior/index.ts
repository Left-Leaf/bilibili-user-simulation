// 行为层（Behavior）：模拟真人的基本动作单元（原子）。
// 只含物理操作：鼠标（移动/左键/右键/双击/长按/悬停）、滚动、键盘、停留、
// 导航、扫码等。点赞/三连/关注等目标化交互由任务（Task=行为集合）组合实现。
export * from './types';
export * from './navigation';
export * from './mouse';
export * from './scroll';
export * from './dwell';
export * from './content';
export * from './scan-qr';
