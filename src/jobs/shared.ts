/**
 * 正式实验定时调度系统 - 共享常量/类型/工具函数（Twitter 适配版）
 * ============================================================================
 * 被 collector.ts / commenter.ts / monitor.ts / scheduler.ts 复用
 */

import { query } from '../lib/db';

// ─── 类型定义 ──────────────────────────────────────────────

export interface TwitterAccount {
  id: string;
  nickname: string;
  twitter_handle: string;
  api_key: string;
  api_secret: string;
  access_token: string;
  access_token_secret: string;
  daily_comment_count: number;
  max_daily_comments: number;
  status: string;
  can_comment?: boolean;
  comment_checked_at?: string;
  comment_ban_reason?: string;
}

export interface ScreeningPost {
  postId: string;
  postUrl: string;
  content: string;
  authorUid: string;
  authorName: string;
  followers: number;
  commentsCount: number;
  repostsCount: number;
  likesCount: number;
  publishedAt: string;
  failReason?: string;
}

export interface ExperimentRun {
  id: string;
  user_id: string;
  date: string;
  experiment_date: string;
  status: string; // screening | ready | running | completed
  total_posts: number;
  t0_at?: string;
  completed_points?: string[];
}

// ─── 规模参数（分批增量建池）──────────────────────────────
// 支持环境变量覆盖（试跑用小规模），默认为正式实验规格。
// 策略：16/18/20 三批，每批采 CANDIDATE_BATCH 条候选追加池，跨批筛选累计；
//       合格帖累计 ≥ TARGET_QUALIFIED 即停后续批次；从池中选 EXPERIMENT_POSTS 做实验。
export const CANDIDATE_BATCH = Number(process.env.CANDIDATE_BATCH) || 2000;
export const MAX_BATCHES = Number(process.env.MAX_BATCHES) || 3;
export const TARGET_QUALIFIED = Number(process.env.TARGET_QUALIFIED) || 150;
export const EXPERIMENT_POSTS = Number(process.env.EXPERIMENT_POSTS) || 90;
export const MAX_PAGES_PER_KEYWORD = Number(process.env.MAX_PAGES) || 8;
export const COLLECT_HOURS = [16, 18, 20];

// ─── 监控时间点 ────────────────────────────────────────────
export const MONITOR_POINTS = ['t2h', 't4h', 't8h', 't12h', 't24h', 't48h', 't72h'] as const;
export type MonitorPoint = (typeof MONITOR_POINTS)[number];

export const POINT_OFFSET_HOURS: Record<string, number> = {
  t2h: 2, t4h: 4, t8h: 8, t12h: 12, t24h: 24, t48h: 48, t72h: 72,
};

export const LIFECYCLE_HOURS = 72;

// ─── 搜索关键词（英文日常话题）─────────────────────────────
export const SEARCH_KEYWORDS = [
  'daily', 'sharing', 'life', 'food', 'travel', 'today', 'feeling', 'really',
  'recently', 'suddenly', 'happy', 'delicious', 'beautiful', 'home', 'weekend',
  'good morning', 'good night', 'weather', 'mood', 'work',
  'coffee', 'movie', 'show', 'exercise', 'fitness', 'walk', 'photo', 'sunset',
  'breakfast', 'lunch', 'dinner', 'pet', 'cat', 'dog', 'reading', 'music',
];

// ─── 关键词黑名单（英文敏感/营销/引流）─────────────────────
export const EXCLUDE_KW = [
  // Sensitive/political
  'giveaway', 'contest', 'win free', 'discount code', 'promo code', 'sale now',
  // Spam/ads
  'buy now', 'click here', 'subscribe now', 'follow me', 'dm me',
  // Financial/scam
  'crypto', 'bitcoin', 'nft drop', 'investment opportunity', 'earn money',
  'get rich', 'forex', 'trading signal',
  // Medical/legal
  'medical advice', 'legal advice',
  // Growth hacking
  'follow back', 'gain followers', 'growth hack',
];

// ─── 评论权限探测用中性短语（探测后会立即删除）─────────────
export const PROBE_COMMENTS = [
  'Noted.', 'Bookmarking this.', 'Interesting take.', 'Good point!', 'Checking this out.',
];

// ─── 通用工具函数 ──────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function now(): string {
  return new Date().toISOString();
}

export function ts(): string {
  return new Date().toLocaleString();
}

/**
 * 获取纽约时间（America/New_York）的本地 Date 对象
 * 返回的 Date 对象各 get 方法（getHours/getDate 等）返回纽约时间分量
 */
export function getNYDate(): Date {
  const nyStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  return new Date(nyStr);
}

/** 获取当前纽约时间的日期字符串 YYYY-MM-DD */
export function nyDateStr(): string {
  const d = getNYDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── 账号读取 ──────────────────────────────────────────────

/** 读取所有 active 账号 */
export async function getActiveAccounts(): Promise<TwitterAccount[]> {
  const { rows } = await query<TwitterAccount>('twitter_accounts', { status: 'active' });
  return rows;
}

/** 读取可评论账号：status=active 且 未被标记禁评（can_comment !== false） */
export async function getCommentableAccounts(): Promise<TwitterAccount[]> {
  const { rows } = await query<TwitterAccount>('twitter_accounts', {
    status: 'active',
    can_comment: { $ne: false },
  });
  return rows;
}
