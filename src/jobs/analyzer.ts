/**
 * 正式实验 - 评论数据采集与分析（Twitter 适配版）
 * ============================================================================
 * 产出四张溯源表（4 张结果表均来源于此）：
 *   1. post_detail          - 帖子详情原始 API 响应（溯源）
 *   2. post_comment_meta    - 全部评论 API 原始响应（溯源）
 *   3. post_user_meta       - 评论用户信息 API 原始响应（溯源）
 *   4. comment_snapshots    - 结构化评论快照（支持构建评论树）
 *
 * 直跑调试：npx tsx src/jobs/analyzer.ts [experimentId]
 */

import { query, insert, upsert, updateOne, maybeOne } from '../lib/db';
import { getTweetDetailRaw, type CommentEntry } from '../lib/twitter-api';
import {
  TwitterAccount,
  sleep,
  ts,
  now,
  getActiveAccounts,
  getCredentials,
} from './shared';

interface PostRow {
  id: string;
  tweet_id: string;
  experiment_id: string;
}

interface ExperimentRun {
  id: string;
  status: string;
  t0_at?: string;
}

/** 采集单个帖子的评论数据 */
async function collectPostComments(
  experimentId: string,
  post: PostRow,
  account: TwitterAccount,
): Promise<{ comments: number; users: number }> {
  const creds = getCredentials(account);
  const detail = await getTweetDetailRaw(creds, post.tweet_id);
  if (!detail) return { comments: 0, users: 0 };

  // ── post_detail：保存原始帖子详情 ──
  await upsert(
    'post_detail',
    { experiment_id: experimentId, post_id: post.id },
    {
      experiment_id: experimentId,
      post_id: post.id,
      tweet_id: post.tweet_id,
      raw_response: JSON.stringify(detail.raw),
      captured_at: now(),
    },
  );

  // ── post_comment_meta：保存原始 API 响应（含评论 conversation）──
  await upsert(
    'post_comment_meta',
    { experiment_id: experimentId, post_id: post.id },
    {
      experiment_id: experimentId,
      post_id: post.id,
      tweet_id: post.tweet_id,
      raw_response: JSON.stringify(detail.raw),
      captured_at: now(),
    },
  );

  // ── comment_snapshots：结构化评论数据 ──
  const seenUsers = new Set<string>();
  let commentCount = 0;

  for (const entry of detail.entries) {
    await upsert(
      'comment_snapshots',
      { experiment_id: experimentId, comment_id: entry.comment_id },
      {
        experiment_id: experimentId,
        post_id: post.id,
        tweet_id: post.tweet_id,
        comment_id: entry.comment_id,
        parent_comment_id: entry.parent_comment_id,
        author_uid: entry.author_uid,
        author_name: entry.author_name,
        content: entry.content,
        likes_count: entry.likes_count,
        comment_time: entry.created_at,
        captured_at: now(),
      },
    );
    commentCount++;

    // 记录去重后的用户
    if (entry.author_uid && !seenUsers.has(entry.author_uid)) {
      seenUsers.add(entry.author_uid);
      if (entry.author_raw) {
        await upsert(
          'post_user_meta',
          { experiment_id: experimentId, user_id: entry.author_uid },
          {
            experiment_id: experimentId,
            user_id: entry.author_uid,
            raw_response: JSON.stringify(entry.author_raw),
            captured_at: now(),
          },
        );
      }
    }
  }

  return { comments: commentCount, users: seenUsers.size };
}

/** 对单个实验的所有帖子采集评论数据 */
async function collectExperiment(experimentId: string, accounts: TwitterAccount[]): Promise<{ posts: number; totalComments: number; totalUsers: number }> {
  const { rows: posts } = await query<PostRow>('posts', { experiment_id: experimentId });
  if (!posts.length) {
    console.log('  无帖子，跳过');
    return { posts: 0, totalComments: 0, totalUsers: 0 };
  }

  let totalComments = 0;
  let totalUsers = 0;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const acc = accounts[i % accounts.length];
    try {
      const { comments, users } = await collectPostComments(experimentId, post, acc);
      totalComments += comments;
      totalUsers += users;
    } catch (e: any) {
      console.log(`    ⚠️ ${post.tweet_id} 评论采集失败: ${e.message}`);
    }
    await sleep(500 + Math.random() * 1000);
    if ((i + 1) % 20 === 0) {
      console.log(`    评论采集进度: ${i + 1}/${posts.length} (评论:${totalComments}, 用户:${totalUsers})`);
    }
  }

  return { posts: posts.length, totalComments, totalUsers };
}

export async function runAnalyzer(expIdArg?: string): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[评论数据采集] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const accounts = await getActiveAccounts();
  if (accounts.length < 2) {
    console.log(`❌ 可用账号不足（${accounts.length}），至少需要 2 个`);
    return;
  }
  console.log(`可用账号: ${accounts.length}`);

  let experiments: ExperimentRun[];

  if (expIdArg) {
    const exp = await maybeOne<ExperimentRun>('experiment_runs', { id: expIdArg });
    experiments = exp ? [exp] : [];
  } else {
    const { rows } = await query<ExperimentRun>('experiment_runs', {
      status: { $in: ['running', 'ready'] },
    });
    experiments = rows;
  }

  if (!experiments.length) {
    console.log('❌ 未找到 running/ready 状态的实验');
    return;
  }
  console.log(`目标实验: ${experiments.length} 个\n`);

  for (const exp of experiments) {
    const experimentId = String(exp.id);
    console.log(`[${experimentId}] 开始采集评论数据...`);
    const { posts, totalComments, totalUsers } = await collectExperiment(experimentId, accounts);
    console.log(`[${experimentId}] 完成: ${posts} 帖, ${totalComments} 条评论, ${totalUsers} 个用户\n`);
    await sleep(2000);
  }

  console.log(`✅ 评论数据采集完成`);
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/analyzer.ts')) {
  runAnalyzer(process.argv[2])
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('分析异常:', e);
      process.exit(1);
    });
}
