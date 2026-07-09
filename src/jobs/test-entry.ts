/**
 * 测试入口 - 3账号采集 → 3+3+3 实验 → 评论发送（Twitter 适配版）
 * ============================================================================
 * 用法: npx tsx src/jobs/test-entry.ts
 *
 * 流程:
 *   1. 读取前 3 个 active 账号
 *   2. 用 Twitter API 搜索约 1000 条候选推文
 *   3. 逐条获取详情硬性筛选 → 入候选池 candidate_pool
 *   4. 选 9 篇实验帖（3 control + 3 low + 3 high），写 posts + intervention_logs
 *   5. 采集 t0 基线 + 发送评论（low/high 组各 3 条）
 *
 * 相比正式调度系统的差异：
 *   - 不按 16/18/20 分批，一次性跑完采集→选帖→评论全流程
 *   - 仅使用前 3 个账号
 *   - 候选目标 1000 条 tweet（实际合格数取决于筛选通过率）
 */

process.env.CANDIDATE_BATCH = '1000';
process.env.TARGET_QUALIFIED = '9';
process.env.EXPERIMENT_POSTS = '9';
process.env.MAX_PAGES = '5';

async function main() {
  console.log('='.repeat(65));
  console.log('  Twitter Test Entry - 3 accounts · 1000 samples · 3+3+3 experiment');
  console.log('  Start:', new Date().toLocaleString());
  console.log('='.repeat(65));

  const { getActiveAccounts } = await import('./shared');
  const { query } = await import('../lib/db');
  const { getDb } = await import('../lib/db');

  // Clean old experiments from today
  const today = new Date().toISOString().split('T')[0];
  const { rows: oldExps } = await query<{ id: string }>('experiment_runs', { experiment_date: today });
  if (oldExps.length > 0) {
    const oldIds = oldExps.map((e) => e.id);
    const { ObjectId } = await import('mongodb');
    const database = await getDb();
    await database.collection('experiment_runs').deleteMany({ _id: { $in: oldIds.map((id) => new ObjectId(id)) } });
    await database.collection('candidate_pool').deleteMany({ experiment_id: { $in: oldIds } });
    await database.collection('posts').deleteMany({ experiment_id: { $in: oldIds } });
    await database.collection('intervention_logs').deleteMany({ experiment_id: { $in: oldIds } });
    await database.collection('post_snapshots').deleteMany({ experiment_id: { $in: oldIds } });
    console.log(`  Cleaned ${oldIds.length} old experiments from today`);
  }

  // 1. Get first 3 active accounts
  const allAccounts = await getActiveAccounts();
  if (allAccounts.length < 3) {
    console.log(`❌ Not enough accounts (${allAccounts.length}), need at least 3`);
    console.log('   Please add accounts via the admin interface with OAuth credentials');
    process.exit(1);
  }
  const accounts = allAccounts.slice(0, 3);
  console.log(`\n✅ Selected 3 accounts: ${accounts.map((a) => a.nickname).join(', ')}`);

  // Ensure comment templates exist (for first-time empty DB)
  const { count, insert } = await import('../lib/db');
  const existingTemplates = await count('comment_templates');
  if (existingTemplates === 0) {
    const defaults = [
      { post_group: 'low', content: 'Well written, thanks for sharing', is_active: true, sort_order: 1 },
      { post_group: 'low', content: 'Nice, keep it up', is_active: true, sort_order: 2 },
      { post_group: 'low', content: 'That makes sense', is_active: true, sort_order: 3 },
      { post_group: 'high', content: 'This is a brilliant point! Bookmarked, looking forward to more content like this', is_active: true, sort_order: 1 },
      { post_group: 'high', content: 'Perfectly summarized, learned a lot! Shared with friends', is_active: true, sort_order: 2 },
      { post_group: 'high', content: 'Really inspiring, very detailed, thumbs up!', is_active: true, sort_order: 3 },
    ];
    for (const t of defaults) await insert('comment_templates', t);
    console.log(`  Initialized ${defaults.length} default English comment templates`);
  } else {
    console.log(`  Comment templates already: ${existingTemplates}`);
  }

  // ── Phase 1: Collect ────────────────────────────────────
  console.log('\n' + '-'.repeat(65));
  console.log('  Phase 1: Collect candidate tweets');
  console.log('-'.repeat(65));

  const { runCollectBatch } = await import('./collector');
  const batchResult = await runCollectBatch();

  if (!batchResult) {
    console.log('❌ Collection failed, aborting');
    process.exit(1);
  }
  console.log(`\n  Collection complete: ${batchResult.qualified} qualified in pool`);

  // ── Phase 2: Finalize experiment ─────────────────────────
  console.log('\n' + '-'.repeat(65));
  console.log('  Phase 2: Finalize experiment (3+3+3)');
  console.log('-'.repeat(65));

  const { finalizeExperiment } = await import('./collector');
  const finalResult = await finalizeExperiment();

  if (!finalResult) {
    console.log('❌ Finalize failed, aborting');
    process.exit(1);
  }
  const experimentId = finalResult.experimentId;
  console.log(`\n  Experiment created: experimentId=${experimentId}`);

  // ── Phase 3: Comment ─────────────────────────────────────
  console.log('\n' + '-'.repeat(65));
  console.log('  Phase 3: Send comments + t0 baseline');
  console.log('-'.repeat(65));

  const { runDailyComment } = await import('./commenter');
  const commentResult = await runDailyComment(experimentId);

  if (commentResult) {
    console.log(`\n  Comments complete: ${commentResult.sent} sent / ${commentResult.failed} failed`);
  } else {
    console.log('❌ Comment phase not executed (insufficient account permissions)');
  }

  // ── Summary ──────────────────────────────────────────────
  console.log('\n' + '='.repeat(65));
  console.log('  Test Complete!');
  console.log(`  Experiment ID: ${experimentId}`);
  console.log(`  Qualified pool: ${batchResult.qualified} tweets`);
  console.log(`  Experiment: 9 posts (control=3, low=3, high=3)`);
  if (commentResult) {
    console.log(`  Comments: ${commentResult.sent} sent / ${commentResult.failed} failed`);
  }
  console.log('  Open http://localhost:3000 to view dashboard');
  console.log('='.repeat(65));

  process.exit(0);
}

main().catch((e) => {
  console.error('Test entry error:', e);
  process.exit(1);
});
