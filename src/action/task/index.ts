export { BaseTask } from './base';
export type { Task, TaskResult } from './base';

// 搜索决策器（决定搜索触发方式）
export { SearchDecider, DirectSearchDecider, FirstSuggestionDecider } from './search-decider';
export type { SearchDecision } from './search-decider';

// 一个任务一个文件（扁平结构）
export { LoginTask } from './login';
export { BrowseHomeTask } from './browse-home';
export type { BrowseHomeInput, VideoItem } from './browse-home';
export { BrowseDynamicTask } from './browse-dynamic';
export type { BrowseDynamicInput } from './browse-dynamic';
export { BrowseProfileTask } from './browse-profile';
export type { BrowseProfileInput } from './browse-profile';
export { SearchTask } from './search';
export type { SearchTaskInput } from './search';
export { OpenVideoTask } from './open-video';
export { WatchVideoTask } from './watch-video';
export type { WatchVideoInput } from './watch-video';
export { RestTask } from './rest';
export type { RestTaskInput } from './rest';
export { CloseVideoTask } from './close-video';
export { LikeTask } from './like';
export { TripleTask } from './triple';
export { FollowTask } from './follow';
export { CommentTask } from './comment';
