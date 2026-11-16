# Advisor channel (grokbot): 定鼎 ⇄ 大娃 consult channel

A plain HTTP webhook pair that lets a bot on this deployment consult the senior
advisor (大娃) running elsewhere, without a vendor SDK, a container, or a run
pipeline. One provider (`grokbot`), one tool (`ask_grokbot`).

## Mental model

- **日常工作自己做**： teammate bots are reached with `message_bot` /
  `relay_to_bots`. The advisor channel is only for direction calls, stuck
  investigations, and arbitration.
- **不是聊天，不是汇报**: nothing is mirrored to the advisor — no run
  transcripts, no routine outputs, no statuses. Only an explicit `ask_grokbot`
  question goes out, and only its reply comes back.
- **回环不可能**: inbound replies resolve the open ask *before* any run
  logic, and the follow-up run a reply may start is an ordinary chat run on the
  asking bot, never a messaging run on this channel: no question is posted back
  out, no ack/receipt is pushed, and anything uncorrelated or at hop ≥ 1 is
  dropped with a log line.

## Blocking by default, and a follow-up run when the wait ends

`ask_grokbot` **blocks** until the advisor answers: the call sits on its ask row
(no generic tool deadline applies) and returns the answer as the tool result, so
the same turn carries on with it. The wait is bounded by the ask's own lifetime —
`MESSAGING_GROKBOT_REPLY_TIMEOUT_MS`, 10 minutes by default, 30 minutes at most.

A caller that only wants to drop the question off passes `wait: false`. Then, as
for any reply no run is waiting on, the answer is written into the asking thread
(marked 「顾问（大娃）答复」) **and** a normal `follow_up` run is started on the
bot that asked, in its own thread, prompted to act on the answer. That is the
path that keeps a bot moving when its turn already ended, when the wait was cut
by an interruption, or when the reply lands after the ask's own timeout.

An interrupted wait does not close the ask: the row becomes `abandoned` rather
than `expired`, so the correlation stays answerable and the reply that arrives
later is delivered instead of being refused as `unknown_correlation`.

**A Stop is not an interruption.** The worker only learns about a Stop on its
next lease renewal — a silent abort, indistinguishable at the tool level from a
lease loss — so the row is classified by the run's own status: `cancelled` when a
person stopped it, `abandoned` otherwise. Both stay answerable, but only
`abandoned` wakes the bot. A `cancelled` ask's reply is written into the thread
and nothing else: starting a run there would resume the work the Stop ended.

| Mode | Ask row status | Who reads the reply |
| --- | --- | --- |
| default (blocking) | `pending` | the polling tool call returns it; no second run |
| `wait: false` | `accepted` | the thread, plus a follow-up run |
| wait cut by an interruption | `abandoned` | the thread, plus a follow-up run |
| wait cut by Stop | `cancelled` | the thread only — no run |
| past its timeout | `expired` | the thread, plus a follow-up run (late, within grace; none if the run was stopped) |

## Environment (all three secrets required together)

| Variable | Meaning |
| --- | --- |
| `MESSAGING_GROKBOT_OUTBOUND_URL` | 大娃's「Rakazo顾问通道」routine webhook URL (POST target) |
| `MESSAGING_GROKBOT_OUTBOUND_TOKEN` | Bearer sent on outbound question POSTs |
| `MESSAGING_GROKBOT_INBOUND_TOKEN` | Bearer 大娃's routine must send when replying |
| `MESSAGING_GROKBOT_ADDRESS` | Our wire label (default `rakazo`) |
| `MESSAGING_GROKBOT_PEER_ADDRESS` | 大娃's wire label (default `dawa`) |
| `MESSAGING_GROKBOT_PEER_LABEL` | 大娃's display label (default `大娃`) |
| `MESSAGING_GROKBOT_REPLY_TIMEOUT_MS` | Ask lifetime (default 600000, max 1800000). It is both the longest a blocking call waits and how late a reply is still delivered |

When the three secrets are set, `messagingPlatformsFromEnv` mounts the
`grokbot` platform; `isMessagingSurfaceEnabled` then sees a non-empty platform
list, so the messaging runtime (and the public inbound route
`/api/v1/messaging/webhook/grokbot`) mounts with **no** Lark credentials present.
With no secrets, nothing mounts and the route stays a plain 404.

## Wire contract

**Outbound question** — POST `MESSAGING_GROKBOT_OUTBOUND_URL` with
`Authorization: Bearer <OUTBOUND_TOKEN>`:

```json
{
  "type": "question",
  "threadId": "grokbot:dawa",
  "from": "rakazo",
  "to": "dawa",
  "toLabel": "大娃",
  "correlation": "re-<uuid>",
  "content": "<question text>",
  "hop": 0,
  "sentAt": "2026-11-12T08:00:00.000Z"
}
```

**Inbound reply** — POST `/api/v1/messaging/webhook/grokbot` with
`Authorization: Bearer <INBOUND_TOKEN>`:

```json
{
  "type": "reply",
  "from": "dawa",
  "fromLabel": "大娃",
  "correlation": "re-<uuid echoed verbatim>",
  "content": "<answer text>",
  "hop": 1
}
```

Rules:

1. `correlation` must be echoed verbatim; replies that match no open ask
   (`pending` or `accepted`) are dropped (`unknown_correlation`).
2. `type: "status"` and `type: "ack"` are accepted and ignored — never answered
   with a pushback, and an ack never consumes the ask it names.
3. `hop >= 1` without a matching correlation is dropped (`hop_limit`).
4. Uncorrelated posts (advisor-initiated topics) are dropped
   (`uncorrelated_not_supported`); the channel is pull-only by design.
5. Non-200 replies from Rakazo mean "not delivered"; 大娃's routine may retry
   the POST — duplicates are harmless because only one open ask matches a
   correlation (`status` guard in the store).

## 大娃 side (the「Rakazo顾问通道」routine)

The routine's trigger is its platform webhook; its prompt should be:

> 收到 POST 即为总管（rakazo）的求助提问。正文 JSON：correlation 是回执编号，content
> 是问题。作为高级顾问：先给结论，再给理由与风险，保持简短（≤500字）。回答完成后，把
> 最终答复文本用 HTTP POST 发回 replyTo 通道：
> URL = `<本部署公网>/api/v1/messaging/webhook/grokbot`，头 `Authorization: Bearer
> <INBOUND_TOKEN>`，JSON body：`{"type":"reply","from":"dawa","fromLabel":"大娃",
> "correlation":"<原样回填收到的 correlation>","content":"<答复全文>","hop":1}`。
> correlation 不改写、不加前缀；发完即结束，不做例行汇报。

The routine's webhook URL and its outbound bearer are the two values the user
copies from 大娃's panel into `MESSAGING_GROKBOT_OUTBOUND_URL` /
`MESSAGING_GROKBOT_OUTBOUND_TOKEN`. The inbound bearer lives only in this
deployment's `.env`; copy it from there into 大娃's routine config — never
through chat.

## Operations

- **Self-check without business**: with the runtime mounted,
  `POST /api/v1/messaging/webhook/grokbot` without a bearer → Rakazo JSON 401;
  with the bearer and `{}` → JSON 400; the route must not be an HTML login page
  or a plain-text 404 (404 = runtime not mounted).
- **Ask lifecycle**: rows in `grokbot_asks` are operational scratch
  (`pending`/`accepted`/`abandoned`/`cancelled` → `answered` / `expired` /
  `failed`). Truncating the table is safe; a reply whose row is gone gets
  `unknown_correlation`.
- **Timeouts**: a blocking call that reaches the ask's lifetime returns
  `ok: false` and the row expires; an interruption marks it `abandoned`, a
  person's Stop marks it `cancelled`. Both keep the correlation answerable, so a
  reply that arrives afterwards is not lost: it is appended to the thread that
  asked (meta reads `顾问（…）答复（迟到）` when the ask had expired) and the
  webhook reports `resolved`. A follow-up run starts on the bot that asked unless
  the run was stopped — a Stop is a decision, and re-running it is not the
  platform's call. The grace window is 24 h (`LATE_REPLY_GRACE_MS`); past that
  the row stays `expired` and the reply gets `unknown_correlation`. Measured peer
  latency on the live channel is 16–25 s.
- **No files, no groups, no history**: questions and replies are text only, one
  1:1 thread per peer.

## 评审与加固记录（2026-11-12）

- 创新评审结论：有条件通过（无阻断缺陷）。当场修复：①迁移目录 20261211120000→20261112120000（日期笔误）；②413 限长改为读后校验（原仅信 content-length 声明头，chunked 请求可绕过；现 request.arrayBuffer() 后按字节长度判再 JSON.parse）；③peerLabel 代码默认值 "Dawa"→"大娃"，与 .env.example 一致。挂账后续：#5 advisorThreadId 改走 env 注入惯例替代直读 process.env；#6 自动化单测（bearerMatches/parseInbound/resolveReply 幂等/waitGrokbotReply 中止路径）。
- GrokbotAsk 表清理节奏：行量=求助频次级；查询路径恒带 status=pending 且 expiresAt>now，answered/expired 行不参与任何逻辑。人工清理：每月一次 DELETE FROM "GrokbotAsk" WHERE "expiresAt" < NOW() - INTERVAL '30 days'; 或直接 TRUNCATE（无长保留价值）。低频清理例程为可选后续。
- 自测证据（2026-11-12 实现时执行，全部通过）：adapters/core/api/worker 四包 tsc --noEmit 全绿；行为自棃=Bearer 矩阵（缺头/错 token→401）、非 POST→405、413 限长、坏 JSON→400、status 消息短路、correlation 回填幂等（重复投递仅首份生效）、store miss 与无 store 丢弃、hop≥1 无 correlation 丢弃、工厂三密钥齐才挂载（半配置不挂）、无 LARK 凭证时 grokbot 单独挂载、postMessage payload 逐字段核对；biome 全净。
