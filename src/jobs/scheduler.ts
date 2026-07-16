/**
 * 正式实验 - 常驻调度器（Twitter 适配版，Node 原生定时，零外部依赖）
 * ============================================================================
 * ⏰ 所有时间均以纽约时间（America/New_York）为基准
 *
 * 采集分批建池策略（纽约时间）：
 *   16:00 / 18:00 / 20:00  runCollectBatch  每 2 小时采一批候选追加池，
 *                          跨批筛选累计；合格 ≥150 即停后续批次。
 *   20:00 批次采完后        finalizeExperiment 从池选 90 实验帖建实验
 *                          → runDailyComment 采 t0 基线 + 发评论
 *   每 30 分钟              runMonitorTick  扫描 running 实验补采到点快照
 *
 * 启动：npx tsx src/jobs/scheduler.ts
 */

import { runCollectBatch, finalizeExperiment } from './collector';
import { runDailyComment } from './commenter';
import { runMonitorTick } from './monitor';
import { runCommentPermissionCheck } from './checker';
import { runAnalyzer } from './analyzer';
import { runStartupMigration } from '../lib/startup-migration';
import { ensureTemplates } from '../lib/seed-templates';
import { closeDb } from '../lib/db';
import { COLLECT_HOURS, ts, getNYDate, nyDateStr } from './shared';

const COMMENT_HOUR = 20;  // 纽约时间 20:00 发评论
const CHECK_HOUR = 19;    // 纽约时间 19:30 权限检测
const CHECK_MINUTE = 30;
const MONITOR_INTERVAL_MIN = 30;
const ANALYZER_INTERVAL_MIN = 120; // 每 2 小时采集评论数据

let busy = false;
const firedHours = new Map<string, Set<number>>();
let lastMonitorMinute = -1;
let checkedCommentPermToday = '';
let lastAnalyzerMinute = -1;

async function guarded(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (busy) {
    console.log(`[调度] ${name} 跳过（有任务运行中）  [${ts()}]`);
    return;
  }
  busy = true;
  try {
    await fn();
  } catch (e) {
    console.error(`[调度] ${name} 异常  [${ts()}]:`, e);
  } finally {
    busy = false;
  }
}



function claimHour(today: string, hour: number): boolean {
  let set = firedHours.get(today);
  if (!set) {
    set = new Set();
    firedHours.set(today, set);
    for (const k of firedHours.keys()) if (k !== today) firedHours.delete(k);
  }
  if (set.has(hour)) return false;
  set.add(hour);
  return true;
}

async function runCommentPipeline(): Promise<void> {
  await runCollectBatch();
  const fin = await finalizeExperiment();
  if (fin) {
    await runDailyComment(fin.experimentId);
  }
}

async function heartbeat(): Promise<void> {
  const ny = getNYDate();
  const today = nyDateStr();
  const hour = ny.getHours();
  const minute = ny.getMinutes();

  if (hour === CHECK_HOUR && minute === CHECK_MINUTE && today !== checkedCommentPermToday) {
    checkedCommentPermToday = today;
    await guarded(`${CHECK_HOUR}:${CHECK_MINUTE} 评论权限检测`, runCommentPermissionCheck);
    return;
  }

  if (minute < MONITOR_INTERVAL_MIN && COLLECT_HOURS.includes(hour) && claimHour(today, hour)) {
    if (hour === COMMENT_HOUR) {
      await guarded(`${COMMENT_HOUR}点采集+选帖+评论`, runCommentPipeline);
    } else {
      await guarded(`${hour}点采集批次`, runCollectBatch);
    }
    return;
  }

  const totalMin = Math.floor(ny.getTime() / 60000);
  if (totalMin % MONITOR_INTERVAL_MIN === 0 && totalMin !== lastMonitorMinute) {
    lastMonitorMinute = totalMin;
    await guarded('监控tick', runMonitorTick);
  }

  // 每 2 小时采集评论数据
  if (totalMin % ANALYZER_INTERVAL_MIN === 0 && totalMin !== lastAnalyzerMinute) {
    lastAnalyzerMinute = totalMin;
    await guarded('评论数据采集', runAnalyzer);
  }
}

function main(): void {
  console.log(`${'='.repeat(60)}`);
  console.log(`Twitter 正式实验调度器启动（纽约时间） [${ts()}]`);
  console.log(`  采集批次: ${COLLECT_HOURS.join('/')}点 | ${CHECK_HOUR}:${CHECK_MINUTE} 权限检测 | ${COMMENT_HOUR}点批后选帖+评论 | 每${MONITOR_INTERVAL_MIN}min 监控`);
  console.log(`  当前纽约时间: ${nyDateStr()} ${String(getNYDate().getHours()).padStart(2,'0')}:${String(getNYDate().getMinutes()).padStart(2,'0')}`);
  console.log(`  数据迁移: 启动时自动`);
  console.log(`${'='.repeat(60)}`);

  // 启动时：数据迁移（PREFIX 适配 + post_group 回填）
  guarded('启动数据迁移', async () => {
    const { postsMigrated, postGroupBackfilled, skipped } = await runStartupMigration();
    if (!skipped) {
      console.log(`[启动迁移] 帖子迁移 ${postsMigrated} 条, post_group 回填 ${postGroupBackfilled} 条`);
    }
  });

  // 启动时同步评论模板
  guarded('模板同步', async () => {
    const { created, existing } = await ensureTemplates();
    console.log(`[模板同步] 新增 ${created} 条, 已有 ${existing} 条`);
  });

  setInterval(() => {
    heartbeat().catch((e) => console.error('[调度] 心跳异常:', e));
  }, 60_000);

  guarded('启动监控', runMonitorTick);
}

async function shutdown(): Promise<void> {
  console.log(`\n[调度] 收到退出信号，关闭连接...  [${ts()}]`);
  try {
    await closeDb();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
