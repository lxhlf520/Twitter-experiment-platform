/**
 * 正式实验 - 每天纽约时间 20:00 采 t0 基线 + 发送评论（Twitter 适配版）
 * ============================================================================
 * 1. 找当天 status=ready 实验；对其全部帖采 t0 基线（干预前），记录 t0_at
 * 2. 多账号轮询发送评论（low+high）
 *    - 全账号遍历：从当前轮询位开始，逐个尝试所有可评论账号直到成功
 *    - 备选回补：仍失败则从 is_spare 池取新帖，同样全账号遍历重试
 * 3. 更新实验 status=running
 *
 * 直跑调试：npx tsx src/jobs/commenter.ts [experimentId]
 */

import { query, insert, updateOne, maybeOne } from '../lib/db';
import { getTweet, postReply } from '../lib/twitter-api';
import {
  TwitterAccount,
  sleep,
  ts,
  now,
  getActiveAccounts,
  getCommentableAccounts,
  getCredentials,
} from './shared';

interface PostRow {
  id: string;
  post_id: string;
  post_group: string | null;
  is_spare?: boolean;
  content?: string;
  author_uid?: string;
  author_name?: string;
  followers?: number;
}

interface LogRow {
  id: string;
  post_id: string;
  post_group: string;
  comment_template: string | null;
  comment_content: string;
  status: string;
}

/**
 * 遍历全部可评论账号发送评论，直到成功或用尽所有账号。
 * @returns { ok, replyId, err, usedIdx } 其中 usedIdx 是成功时消耗的最后一个账号位
 */
async function tryAllAccounts(
  postId: string,
  content: string,
  accounts: TwitterAccount[],
  startIdx: number,
): Promise<{ ok: boolean; replyId?: string; err?: string; usedIdx: number }> {
  let lastErr = '';
  for (let attempt = 0; attempt < accounts.length; attempt++) {
    const acc = accounts[(startIdx + attempt) % accounts.length];
    if (attempt > 0) {
      console.log(`    ⚠️ 失败(${lastErr})，换 @${acc.nickname} 重试 (${attempt + 1}/${accounts.length})`);
      await sleep(2000 + Math.random() * 3000);
    }
    const r = await postReply(getCredentials(acc), postId, content);
    if (r.ok) {
      return { ok: true, replyId: r.replyId, usedIdx: (startIdx + attempt) % accounts.length };
    }
    lastErr = r.err || 'unknown';
  }
  return { ok: false, err: lastErr, usedIdx: startIdx };
}

/** 采集单实验全部帖子的 t0 基线快照 */
async function captureBaseline(experimentId: string, accounts: TwitterAccount[]): Promise<number> {
  const { rows: posts } = await query<PostRow>('posts', { experiment_id: experimentId });
  console.log(`  采集 t0 基线：${posts.length} 帖...`);
  let ok = 0;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const { tweet } = await getTweet(getCredentials(accounts[i % accounts.length]), p.post_id);
    if (tweet) {
      await insert('post_snapshots', {
        experiment_id: experimentId,
        post_id: String(p.id),
        tweet_id: p.post_id,
        time_point: 't0',
        comments_count: tweet.legacy?.reply_count || 0,
        reposts_count: tweet.legacy?.retweet_count || 0,
        likes_count: tweet.legacy?.favorite_count || 0,
        captured_at: now(),
      });
      ok++;
    }
    await sleep(300 + Math.random() * 500);
    if ((i + 1) % 50 === 0) console.log(`    t0 进度: ${i + 1}/${posts.length}`);
  }
  console.log(`  t0 基线完成: ${ok}/${posts.length}`);
  return ok;
}

export async function runDailyComment(expIdArg?: string): Promise<{ sent: number; failed: number } | null> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[评论发送] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const allAccounts = await getActiveAccounts();
  if (allAccounts.length === 0) {
    console.log('❌ 没有 active 账号');
    return null;
  }
  const commentAccounts = await getCommentableAccounts();
  if (commentAccounts.length < 2) {
    console.log(`❌ 可评论账号不足（${commentAccounts.length}），跳过发评论`);
    return null;
  }
  console.log(`active 账号: ${allAccounts.length} (采集) | 可评论账号: ${commentAccounts.length} (发评论)`);
  console.log(`可评论: ${commentAccounts.map((a) => a.nickname).join(', ')}`);
  const bannedNames = allAccounts.filter((a) => !commentAccounts.some((c) => c.id === a.id)).map((a) => a.nickname);
  if (bannedNames.length > 0) console.log(`已规避(禁评): ${bannedNames.join(', ')}`);

  let exp: { id: string; status: string } | null;
  if (expIdArg) {
    exp = await maybeOne('experiment_runs', { id: expIdArg });
  } else {
    const today = new Date().toISOString().split('T')[0];
    exp = await maybeOne('experiment_runs', { experiment_date: today, status: 'ready' });
  }
  if (!exp) {
    console.log('❌ 未找到当天 status=ready 的实验');
    return null;
  }
  const experimentId = String(exp.id);
  console.log(`目标实验: ${experimentId}`);

  const t0at = now();
  await captureBaseline(experimentId, allAccounts);
  await updateOne('experiment_runs', { id: experimentId }, { t0_at: t0at });

  const { rows: logs } = await query<LogRow>('intervention_logs', {
    experiment_id: experimentId,
    status: 'pending',
  });
  console.log(`\n待发送评论: ${logs.length} 条`);

  const { rows: spares } = await query<PostRow>('posts', { experiment_id: experimentId, is_spare: true });
  const sparePool = [...spares];
  console.log(`备选池: ${sparePool.length} 篇\n`);

  let sent = 0;
  let failed = 0;
  let ai = 0;

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const post = await maybeOne<PostRow>('posts', { id: log.post_id });
    if (!post) {
      failed++;
      continue;
    }

    console.log(`[${i + 1}/${logs.length}] ${post.post_id} [${log.post_group}] @${commentAccounts[ai % commentAccounts.length].nickname}`);
    const r = await tryAllAccounts(post.post_id, log.comment_content, commentAccounts, ai);
    ai = (r.usedIdx + 1) % commentAccounts.length;

    if (r.ok) {
      await updateOne('intervention_logs', { id: log.id }, {
        status: 'sent', comment_id: r.replyId, sent_at: now(),
      });
      sent++;
      console.log(`    ✅ 成功 replyId=${r.replyId}`);
    } else {
      await updateOne('intervention_logs', { id: log.id }, { status: 'failed', error: r.err });
      failed++;
      console.log(`    ❌ 全部 ${commentAccounts.length} 个账号均失败(${r.err})`);

      if (sparePool.length > 0) {
        const spare = sparePool.shift()!;
        console.log(`    🔄 备选回补: ${spare.post_id} [${spare.author_name}]`);
        try {
          await updateOne('posts', { id: spare.id }, { is_spare: false, post_group: log.post_group });
          const spareLog = await insert<{ id: string }>('intervention_logs', {
            experiment_id: experimentId,
            post_id: String(spare.id),
            post_group: log.post_group,
            comment_template: log.comment_template,
            comment_content: log.comment_content,
            status: 'pending',
          });
          if (spareLog) {
            const sr = await tryAllAccounts(spare.post_id, log.comment_content, commentAccounts, ai);
            ai = (sr.usedIdx + 1) % commentAccounts.length;
            if (sr.ok) {
              await updateOne('intervention_logs', { id: spareLog.id }, {
                status: 'sent', comment_id: sr.replyId, sent_at: now(),
              });
              sent++;
              failed--;
              console.log(`    ✅ 回补成功 replyId=${sr.replyId}`);
            } else {
              await updateOne('intervention_logs', { id: spareLog.id }, { status: 'failed', error: sr.err });
              console.log(`    ❌ 回补仍失败(${sr.err})`);
            }
          }
        } catch (e: any) {
          console.log(`    ⚠️ 回补异常: ${e.message}`);
        }
      }
    }
    await sleep(3000 + Math.random() * 5000);
  }

  await updateOne('experiment_runs', { id: experimentId }, { status: 'running' });

  console.log(`\n✅ 评论发送完成: 成功 ${sent} / 失败 ${failed}`);
  console.log(`   实验 ${experimentId} → status=running，t0_at=${t0at}`);
  return { sent, failed };
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/commenter.ts')) {
  runDailyComment(process.argv[2])
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('评论异常:', e);
      process.exit(1);
    });
}
