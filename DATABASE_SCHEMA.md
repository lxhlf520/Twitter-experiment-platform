# Twitter 实验平台 - MongoDB 数据字典

> **数据库**: `twitter_experiment` | **连接**: `mongodb://localhost:27017/`
> 
> 集合前缀 `twitter_` 由 `src/lib/db.ts` 的 `cn()` 函数自动添加。部分共用集合（`posts`、`experiment_runs`、`intervention_logs`、`post_snapshots`、`comment_templates`）无此前缀。

---

## 一、账号层

### `twitter_accounts` — Twitter 账号

认证方式为 Cookie 凭据（`auth_token` + `ct0`），而非 OAuth 1.0a。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `twitter_handle` | string | ✅ | Twitter 句柄（数字 ID 字符串） |
| `auth_token` | string | ✅ | Twitter Cookie `auth_token` 值 |
| `ct0` | string | ✅ | Twitter Cookie `ct0` 值（X-CSRF-Token） |
| `nickname` | string | ✅ | 账号昵称 |
| `status` | string | ✅ | `active` \| `inactive` \| `banned` |
| `user_id` | string | ✅ | 关联用户标识 |
| `daily_comment_count` | number | ✅ | 当日已发评论数（每日 0 点重置） |
| `max_daily_comments` | number | ✅ | 每日评论上限 |
| `can_comment` | boolean | ✅ | 是否有评论权限 |

**示例**:
```json
{
  "nickname": "Experimental Interaction AI Assistant 04",
  "twitter_handle": "id1739220491661873152",
  "auth_token": "50dc86c011c4340a5bd83ec7c38aa105045231c1",
  "ct0": "97f1c97f86...",
  "status": "active",
  "can_comment": true,
  "max_daily_comments": 100
}
```

**凭据获取**: `shared.ts` 中 `getCredentials(account)` 将 `auth_token` 和 `ct0` 拼装为 `TwitterCredentials` 对象，供所有 API 调用使用。

---

## 二、实验运行层

### `experiment_runs` — 实验运行记录

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `user_id` | string | ✅ | 操作用户标识 |
| `date` | string | ✅ | 实验创建日期 (`YYYY-MM-DD`) |
| `experiment_date` | string | ✅ | 实验执行日期 (`YYYY-MM-DD`) |
| `status` | string | ✅ | `screening` → `ready` → `running` → `completed` |
| `total_posts` | number | ✅ | 实验帖子总数 |
| `control_count` | number | | control 组帖子数 |
| `low_count` | number | | low 组帖子数 |
| `high_count` | number | | high 组帖子数 |
| `batch_count` | number | | 分批建池的批次数 |
| `pool_full` | boolean | | 候选池是否已满 |
| `t0_at` | string | | t0 基线快照采集时间 |
| `completed_points` | string[] | | 已完成监控时间点 |
| `seen_mids` | string[] | | 已见帖子 ID（筛选去重用） |
| `created_at` | string | ✅ | 创建时间 |

### `intervention_logs` — 评论干预日志

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | ObjectId | ✅ | 关联 `experiment_runs._id` |
| `post_id` | ObjectId | ✅ | 关联 `posts._id` |
| `post_group` | string | ✅ | 干预分组：`control` \| `low` \| `high` |
| `comment_template` | ObjectId | ✅ | 关联 `comment_templates._id` |
| `comment_content` | string | ✅ | 实际发送的评论内容 |
| `status` | string | ✅ | `pending` → `sent` → `failed` |
| `comment_id` | string | | Twitter reply ID（发送成功后写入） |
| `sent_at` | string | | 评论发送时间 |
| `account_nickname` | string | | 实际发出评论的账号昵称（sent 时写入） |
| `account_id` | string | | 实际发出评论的 Twitter handle（sent 时写入） |
| `error` | string | | 失败原因（仅 status = failed） |

**注意**: `account_nickname` 和 `account_id` 仅在 `status=sent` 时有值，用于追踪哪个账号成功发出了回复。

---

## 三、帖子与模板层

### `posts` — 实验帖子

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `user_id` | string | ✅ | 操作用户 |
| `experiment_id` | ObjectId | ✅ | 关联 `experiment_runs._id` |
| `post_id` | string | ✅ | Twitter tweet `rest_id`（纯数字字符串） |
| `post_url` | string | ✅ | 帖子 URL，格式 `https://twitter.com/i/status/{rest_id}` |
| `content` | string | ✅ | 推文正文 |
| `author_uid` | string | ✅ | 作者 Twitter 用户 ID（`rest_id`） |
| `author_name` | string | ✅ | 作者 `screen_name`（@handle） |
| `followers` | number | | 作者粉丝数 |
| `comments_count` | number | | 评论数（入池时） |
| `reposts_count` | number | | 转发数（入池时） |
| `likes_count` | number | | 点赞数（入池时） |
| `post_group` | string | | 干预分组，筛选时分配 |
| `is_spare` | boolean | ✅ | 是否为备选帖 |
| `published_at` | string | ✅ | 推文发布时间 |

### `candidate_pool` — 候选帖子池

筛选阶段的临时池，通过硬性条件 + AI 三层过滤后的帖子暂存于此。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | ObjectId | ✅ | 关联 `experiment_runs._id` |
| `post_id` | string | ✅ | tweet `rest_id` |
| `post_url` | string | ✅ | 推文 URL |
| `content` | string | ✅ | 推文正文 |
| `author_uid` | string | ✅ | 作者 ID |
| `author_name` | string | ✅ | 作者 @handle |
| `followers` | number | | 粉丝数 |
| `comments_count` | number | | 评论数 |
| `reposts_count` | number | | 转发数 |
| `likes_count` | number | | 点赞数 |
| `published_at` | string | | 发布时间 |
| `created_at` | string | ✅ | 入池时间 |

### `comment_templates` — 评论模板

low 组 4 条 + high 组 4 条（high 组为 AI 语气标记模板，内容更长、语气更正式）。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `post_group` | string | ✅ | 适用分组：`low` \| `high` |
| `content` | string | ✅ | 评论内容（英语） |
| `is_active` | boolean | ✅ | 是否启用 |
| `sort_order` | number | | 排序权重 |

---

## 四、溯源与快照层（实验核心数据）

> **数据流**: 一次 `getTweetDetailRaw` API 调用同时产出 post 详情和全部评论。`twitter_post_detail` 存原始 JSON，`twitter_post_comment_meta` 存同一份原始 JSON（便于分别溯源）。评论结构提取为 `twitter_comment_snapshots`，用户信息提取为 `twitter_post_user_meta`。

### `twitter_post_detail` — 帖子详情原始溯源

存储 `TweetDetail` GraphQL 接口的完整 JSON 响应。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | string | ✅ | 实验 ID |
| `post_id` | string | ✅ | tweet `rest_id`（唯一键） |
| `tweet_id` | string | ✅ | tweet `rest_id`（冗余） |
| `raw_response` | string | ✅ | `TweetDetail` API 完整 JSON 响应（~8KB+） |
| `captured_at` | string | ✅ | 采集时间 |
| `created_at` | string | ✅ | 写入时间 |

**写入时机**: analyzer.ts 调用 `getTweetDetailRaw` 后写入 `raw` 对象。

### `twitter_post_comment_meta` — 评论原始溯源

与 `post_detail` 同源（同一个 `getTweetDetailRaw` 调用），存的是 `threaded_conversation_with_injections_v2` 完整结构，包含主帖和所有评论。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | string | ✅ | 实验 ID |
| `post_id` | string | ✅ | tweet `rest_id`（唯一键） |
| `tweet_id` | string | ✅ | tweet `rest_id`（冗余） |
| `raw_response` | string | ✅ | 同 `post_detail` 的完整 JSON（~8KB+），含评论线程 |
| `captured_at` | string | ✅ | 采集时间 |
| `created_at` | string | ✅ | 写入时间 |

**原始 JSON 结构** (`raw_response` 关键路径):
```
raw.data.threaded_conversation_with_injections_v2.instructions[]
  ├── entries[].content.itemContent.tweet_results.result    → 主帖/顶层评论
  └── entries[].content.items[].item.itemContent.tweet_results.result → 嵌套回复
```

每条 `tweet_results.result` 结构:
```json
{
  "rest_id": "2077180826219892978",
  "legacy": {
    "full_text": "评论内容",
    "created_at": "Tue Jul 14 23:57:55 +0000 2026",
    "favorite_count": 89,
    "reply_count": 0,
    "retweet_count": 0,
    "lang": "en",
    "in_reply_to_status_id_str": "..."
  },
  "core": {
    "user_results": {
      "result": {
        "rest_id": "1984708107071864836",
        "core": { "screen_name": "YumeKissl" },
        "legacy": { "verified": false, "followers_count": 123 }
      }
    }
  }
}
```

### `twitter_post_user_meta` — 评论用户原始溯源

存储评论用户的 `user_results.result` 完整 JSON，按 `user_id` 去重。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | string | ✅ | 实验 ID |
| `user_id` | string | ✅ | Twitter 用户 `rest_id`（去重唯一键） |
| `raw_response` | string | ✅ | 用户 `result` 对象完整 JSON（~2KB） |
| `captured_at` | string | ✅ | 采集时间 |
| `created_at` | string | ✅ | 写入时间 |

**用户 JSON 结构** (`raw_response` 内容):
```json
{
  "rest_id": "1984708107071864836",
  "core": {
    "screen_name": "YumeKissl",
    "name": "Yume Kissl 🌸"
  },
  "legacy": {
    "description": "Digital creator...",
    "followers_count": 12345,
    "friends_count": 567,
    "verified": false
  }
}
```

### `twitter_comment_snapshots` — 结构化评论快照（结果表）

从 `getTweetDetailRaw.entries` 提取的结构化评论，支持评论树构建。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | string | ✅ | 实验 ID |
| `post_id` | string | ✅ | 帖子 `rest_id` |
| `tweet_id` | string | ✅ | 帖子 `rest_id`（冗余） |
| `comment_id` | string | ✅ | 评论 tweet `rest_id`（唯一键） |
| `parent_comment_id` | string\|null | | 父评论 ID，null = 直接评论帖子（一级评论） |
| `author_uid` | string | ✅ | 评论者 Twitter `rest_id` |
| `author_name` | string | ✅ | 评论者 `screen_name` |
| `content` | string | ✅ | 评论正文（`full_text`） |
| `likes_count` | number | | 评论点赞数 |
| `comment_time` | string | | 评论发布时间 (`created_at`) |
| `captured_at` | string | ✅ | 采集时间 |
| `created_at` | string | ✅ | 写入时间 |

**评论树构建逻辑** (`analyzer.ts` → `twitter-api.ts` 的 `getTweetDetailRaw`):
- 顶层 `entries[]` 的直接评论 → `parent_comment_id = null`
- `items[]` 嵌套回复 → `parent_comment_id = tr.legacy.in_reply_to_status_id_str`

### `twitter_post_snapshots` — 帖子指标快照（结果表）

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | string | | 实验 ID |
| `post_id` | string | ✅ | tweet `rest_id` |
| `tweet_id` | string | ✅ | tweet `rest_id`（冗余） |
| `time_point` | string | ✅ | 时间点：`t0`, `t2h`, `t4h`, `t8h`, `t12h`, `t24h`, `t48h`, `t72h` |
| `comments_count` | number | ✅ | 评论数 |
| `reposts_count` | number | ✅ | 转发数 |
| `likes_count` | number | ✅ | 点赞数 |
| `captured_at` | string | ✅ | 采集时间 |
| `created_at` | string | ✅ | 写入时间 |

---

## 五、遗留集合

### `post_snapshots` — 旧版指标快照（部分实验使用）

与 `twitter_post_snapshots` 结构相同，早期实验数据无 `tweet_id` 字段。

---

## 六、数据流全景

```
                     ┌──────────────────────┐
                     │   twitter_accounts     │  auth_token + ct0
                     └──────────┬───────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
     experiment_runs        posts           comment_templates
     (实验运行)            (实验帖子)          (评论模板)
              │                 │
              │    ┌────────────┘
              │    │  analyzer.ts 采集
              │    │  getTweetDetailRaw(creds, post_id)
              ▼    ▼
     ┌──────────────────────────────────────────┐
     │  threaded_conversation_with_injections_v2 │ ← 一次 API 调用
     │  ├── raw (完整 JSON)                      │
     │  └── entries[] (评论条目)                  │
     └──────────┬───────────────────────────────┘
                │
    ┌───────────┼───────────┬──────────────────┐
    ▼           ▼           ▼                  ▼
post_detail  post_comment  post_user_meta  comment_snapshots
(帖子原始)   _meta         (用户原始JSON)   (结构化评论+树)
             (评论原始JSON)
              
              post_snapshots
              (指标时间序列 t0~t72h)
```

**关键 API 对应关系**:
| 溯源表 | 来源函数 | GraphQL Query ID |
|--------|---------|-----------------|
| `twitter_post_detail` | `getTweetDetailRaw` → `raw` | `TweetDetail` |
| `twitter_post_comment_meta` | `getTweetDetailRaw` → `raw` | `TweetDetail` |
| `twitter_post_user_meta` | `getTweetDetailRaw` → `entries[].author_raw` | `TweetDetail` |
| `twitter_comment_snapshots` | `getTweetDetailRaw` → `entries` | `TweetDetail` |

**注意**: Twitter 与微博的关键差异：
- Twitter **一个 API 调用**（`TweetDetail`）返回帖子详情 + 全部评论线程
- 微博需要 **三个独立 API**：`statuses/show`（帖子）+ `buildComments`（评论）+ 用户信息接口
- Twitter `UserResult.screen_name` 在 `core` 层（`user.core.screen_name`），而非顶层
- Twitter 评论发送走 `CreateTweet` mutation，可能返回 200 但 `tweet_results` 为空（静默拒绝）
