# Kế hoạch chiến lược triển khai Persona Assistant

## 1. Mục tiêu

Xây dựng một **Personal AI Assistant có persona riêng**, có khả năng:

- Trò chuyện và duy trì ngữ cảnh với người dùng.
- Quản lý task, reminder và lịch công việc.
- Tự động thực hiện hành động theo **time trigger**, **event trigger** và **condition trigger**.
- Tích hợp với các dịch vụ bên ngoài như:
  - Notion
  - Google Calendar
  - Gmail
  - GitHub
  - Các dịch vụ khác thông qua API/MCP.
- Có khả năng mở rộng thêm memory, workflow và subagent trong tương lai.
- Giữ chi phí hạ tầng ở mức thấp nhất trong giai đoạn MVP.

---

# 2. Kiến trúc tổng thể

```text
                        ┌────────────────────┐
                        │       User         │
                        └─────────┬──────────┘
                                  │
                                  ▼
                        ┌────────────────────┐
                        │      Vercel        │
                        │                    │
                        │ Frontend           │
                        │ Authentication     │
                        │ Public API         │
                        │ Webhook Receiver   │
                        └─────────┬──────────┘
                                  │
                                  ▼
                  ┌────────────────────────────┐
                  │          Render            │
                  │                            │
                  │     DeepSeek Harness       │
                  │                            │
                  │ Persona                    │
                  │ Agent Loop                 │
                  │ Tools                      │
                  │ Memory Interface           │
                  │ Task Interface             │
                  │ Integrations               │
                  └────────────┬───────────────┘
                               │
              ┌────────────────┼──────────────────┐
              ▼                ▼                  ▼
         PostgreSQL          Notion           LLM APIs
      Tasks / Memory       Calendar           DeepSeek
       Conversations        Gmail             OpenAI
              ▲
              │
              │ trigger
              │
      ┌───────┴────────┐
      │      AWS       │
      │                │
      │ EventBridge    │
      │ Scheduler      │
      │      ↓         │
      │    Lambda      │
      └────────────────┘
```

---

# 3. Vai trò của từng thành phần

## 3.1. DeepSeek Harness — Agent Runtime

DeepSeek Harness đóng vai trò là **bộ não điều phối agent**.

Trách nhiệm:

- Quản lý agent loop.
- Xây dựng system prompt và persona.
- Gọi LLM.
- Quyết định khi nào cần sử dụng tool.
- Giao tiếp với task system.
- Giao tiếp với Notion, Calendar, Gmail...
- Quản lý conversation/session.
- Sau này có thể sử dụng subagent cho các công việc phức tạp.

DeepSeek Harness **không phải source of truth cho task hoặc scheduler**.

Đặt Harness sau một `AgentRuntime` interface do ứng dụng sở hữu (ví dụ `runChat`,
`runTriggeredWorkflow`, `planToolCalls`). Task engine và tool layer không phụ thuộc
trực tiếp vào implementation của Harness, để có thể thay model/runtime khi cần mà
không phải chuyển đổi dữ liệu hoặc scheduler.

Nguyên tắc:

```text
LLM decides WHAT to do.

Infrastructure decides WHEN and WHETHER it runs reliably.
```

---

# 4. Persona Layer

Persona được định nghĩa độc lập với business logic.

Ví dụ:

```text
Identity
- Personal AI Assistant của Duy

Behavior
- Ngắn gọn
- Chủ động
- Ưu tiên công việc quan trọng
- Không tự ý thực hiện hành động nhạy cảm

Task behavior
- Theo dõi deadline
- Phát hiện task bị trì hoãn
- Chủ động nhắc việc
- Đề xuất ưu tiên

Communication
- Không spam notification
- Gộp thông báo khi có thể
- Chỉ interrupt khi thực sự cần thiết
```

Persona nên được quản lý như configuration/plugin để có thể thay đổi mà không ảnh hưởng đến các phần còn lại.

---

# 5. Task Management

Task phải được lưu trong database thay vì chỉ nằm trong conversation.

## Data model ban đầu

```text
Task
──────────────────────────
id
user_id
title
description

status
- todo
- doing
- blocked
- done
- cancelled

priority

due_at
remind_at

timezone
recurrence_rrule

source
external_id

created_at
updated_at
```

Các bảng vận hành cần có ngay từ MVP:

```text
trigger_runs              -- một lần thực thi reminder/condition
notification_deliveries   -- trạng thái gửi, provider message ID, retry
event_inbox               -- webhook đã nhận, event ID, payload, trạng thái xử lý
outbox                    -- event nội bộ chờ worker xử lý
agent_runs                -- trace, model, tool call, chi phí và kết quả
approval_requests         -- action nhạy cảm chờ user xác nhận
```

Mỗi bản ghi thực thi phải có `idempotency_key`, trạng thái (`pending`, `processing`,
`succeeded`, `failed`) và thông tin retry. Lưu `timezone` theo user; recurrence dùng
chuẩn RRULE thay vì tự định nghĩa chuỗi riêng.

Ví dụ:

```text
User:
"Nhắc tôi review CV lúc 8h tối mai."

             ↓

Harness

             ↓

create_task({
    title: "Review CV",
    remind_at: ...
})

             ↓

PostgreSQL
```

---

# 6. Trigger Architecture

Trigger được chia thành ba loại.

## 6.1. Time Trigger

Ví dụ:

```text
"Nhắc tôi lúc 20:00."

"Mỗi sáng 8h tổng hợp task."

"Mỗi thứ Hai review kế hoạch tuần."
```

Flow:

```text
EventBridge Scheduler (một lịch dispatcher định kỳ)
        ↓
Dispatcher / Worker
        ↓
PostgreSQL: claim các trigger đến hạn, theo transaction
        ↓
Outbox / job queue
        ↓
Notification hoặc Harness
```

Không tạo một EventBridge schedule cho từng reminder ở MVP. Database là lịch thực
thi thực tế: worker claim atomically các item đến hạn (ví dụ `FOR UPDATE SKIP LOCKED`),
tạo delivery idempotent và retry khi lỗi. Điều này vẫn hoạt động sau restart, không gửi
trùng khi scheduler retry, và dễ hỗ trợ recurrence.

---

## 6.2. Event Trigger

Ví dụ:

```text
Notion page updated

Email received

Calendar changed

GitHub issue created
```

Flow:

```text
External service
       ↓
     webhook
       ↓
     Vercel
       ↓
verify signature → event_inbox → trả 2xx nhanh
       ↓
worker normalize/deduplicate → outbox
       ↓
     Harness
```

Webhook không được chờ LLM xử lý. Với Notion, event chỉ là tín hiệu thay đổi; worker
phải đọc trạng thái mới nhất qua Notion API. Xác thực chữ ký, deduplicate theo event ID
và chịu được retry/lệch thứ tự là bắt buộc.

---

## 6.3. Condition Trigger

Ví dụ:

```text
Task overdue > 2 ngày

Có email từ recruiter

Calendar ngày mai quá nhiều meeting

Có task priority cao chưa bắt đầu
```

Flow:

```text
Periodic trigger
      ↓
query current state
      ↓
evaluate condition
      ↓
condition true
      ↓
Harness
      ↓
notification/action
```

---

# 7. Vai trò của AWS

AWS không chạy toàn bộ assistant.

AWS chỉ đảm nhiệm **trigger infrastructure**.

## Thành phần

```text
EventBridge Scheduler
        ↓
Lambda
        ↓
Render API
```

### Vai trò 1 — Đánh thức dispatcher

EventBridge Scheduler chỉ đánh thức dispatcher/worker theo nhịp cố định. Scheduler,
Lambda và HTTP target đều có thể retry, vì thế downstream bắt buộc idempotent; cấu hình
retry policy và DLQ để điều tra các lần delivery thất bại.

---

### Vai trò 2 — Recurring triggers

Ví dụ:

```text
08:00 mỗi ngày
        ↓
POST /triggers/daily-review
```

---

### Vai trò 3 — One-time reminders

Ví dụ:

```text
2026-08-17 20:00
        ↓
Lambda
        ↓
Render
        ↓
Assistant reminder
```

Task vẫn phải tồn tại trong database để đảm bảo durability.

---

# 8. Database là Source of Truth

Không phụ thuộc vào:

```text
setTimeout()

Node process memory

Render filesystem

LLM conversation history
```

Mọi state quan trọng phải nằm trong database.

```text
PostgreSQL

users

tasks

triggers

conversations

memories

integrations

integration_events

agent_runs
```

Nếu Render restart:

```text
Render dies
     ↓
restart
     ↓
read database
     ↓
continue
```

Task không bị mất.

### Outbox và worker

Mọi thay đổi tạo side effect (gửi Telegram, gọi Harness, đồng bộ Notion) phải ghi cùng
transaction với domain state vào `outbox`. Worker đọc outbox, thực hiện side effect,
ghi kết quả và retry có backoff. Nhờ đó không có khoảng hở giữa “task đã lưu” và “job
chưa từng được gửi”.

---

# 9. Notion Integration

Notion nên đóng hai vai trò.

## 9.1. Notion như interface quản lý thông tin

Assistant có thể:

```text
search Notion

read page

create task

update task

write research

update project status
```

Ví dụ:

```text
"Tạo task nghiên cứu DeepSeek Harness
trong Notion, deadline thứ Sáu."

                ↓

Harness
                ↓
Notion tool
                ↓
Create page/task
                ↓
store Notion page ID
```

---

## 9.2. Notion như event source

```text
Notion
   ↓
Webhook
   ↓
Vercel
   ↓
verify signature → event_inbox → trả 2xx
   ↓
worker deduplicate → read Notion API → outbox
   ↓
Harness / notification worker
```

Ví dụ:

```text
Task tagged "research"
        ↓
Notion webhook
        ↓
Assistant
        ↓
Research workflow
        ↓
Write result back to Notion
```

---

# 10. Memory Strategy

Không nên triển khai complex vector memory ngay từ MVP.

Chia memory thành ba cấp.

## Level 1 — Conversation Memory

DeepSeek Harness session.

```text
Recent conversation
```

## Level 2 — Structured Personal Memory

PostgreSQL.

```text
preferences

projects

people

routines

important facts
```

Ví dụ:

```text
User preference:
- dùng Linux
- thích câu trả lời ngắn
```

## Level 3 — Semantic Memory

Chỉ bổ sung khi thực sự cần.

```text
Vector DB / embeddings
        ↓
retrieve relevant memories
```

Không cần thiết trong phiên bản đầu tiên.

---

# 11. Notification Layer

Assistant cần một kênh để chủ động liên hệ với user.

MVP chỉ nên chọn **một kênh**.

Ưu tiên:

```text
Telegram
   hoặc
Web Push
```

Ví dụ:

```text
AWS Trigger
     ↓
Notification worker
     ↓
template bền vững hoặc Harness tạo bản tóm tắt
     ↓
Telegram
```

Reminder quan trọng phải gửi được bằng template quyết định được, không phụ thuộc việc
LLM/API đang sẵn sàng. LLM chỉ làm giàu nội dung, đề xuất ưu tiên hoặc gộp thông báo.
Mỗi lần gửi được ghi vào `notification_deliveries`; retry không được tạo thông báo trùng.

Không nên tích hợp đồng thời quá nhiều channel trong MVP.

---

# 12. Security Model

Tool phải được chia thành các mức permission.

```text
READ

Notion read
Calendar read
Email read

────────────

WRITE

Create task
Update Notion
Create calendar event

────────────

SENSITIVE

Send email
Delete data
Cancel meeting
Execute external action
```

Các action nhạy cảm nên yêu cầu confirmation.

Ví dụ:

```text
Assistant:
"Tôi đã soạn email cho recruiter.
Bạn có muốn gửi không?"

[Send]
[Cancel]
```

Không cho LLM unrestricted shell/filesystem nếu persona assistant không cần chúng.

Token OAuth của integration phải được mã hóa khi lưu, quyền tool cấp theo user và scope
tối thiểu. Mọi tool call ghi audit log gồm actor, input đã redaction, kết quả, thời điểm
và `agent_run_id`. Approval phải là bản ghi server-side, hết hạn được và chỉ dùng một lần.

---

# 13. MVP — Phase 1

Mục tiêu:

> Chứng minh assistant có thể quản lý công việc hàng ngày tốt hơn một chatbot thông thường.

Chỉ xây:

```text
Persona

Chat

Task management

Reminder

Time trigger

Notion integration

Notification

Basic memory
```

MVP nên được triển khai theo một vertical slice trước khi mở rộng integration:

```text
Chat → create task → PostgreSQL → dispatcher → Telegram → delivery log
```

Vertical slice này phải chịu được restart, retry và không gửi trùng trước khi thêm Notion
webhook hoặc proactive workflow.

Không làm:

```text
Multi-agent

complex workflow

vector memory

Gmail automation

Calendar automation

voice

mobile app

autonomous browsing
```

---

# 14. Phase 1 Architecture

```text
Vercel
│
├── Web UI
├── Auth
└── Webhook API
        │
        ▼
Render
│
└── DeepSeek Harness
       │
       ├── Persona
       ├── Task tools
       ├── Notion tools
       └── Memory tools
              │
              ▼
          PostgreSQL

AWS
│
└── EventBridge
       ↓
     Lambda
       ↓
     Render

Telegram
   ↑
notification
```

---

# 15. Phase 2 — Personal Productivity Agent

Sau khi Phase 1 hoạt động ổn định:

Thêm:

```text
Google Calendar

Gmail

Daily planning

Weekly review

Automatic prioritization

Overdue task detection

Context-aware reminders
```

Ví dụ:

```text
08:00

Calendar
   +
Tasks
   +
Notion
   +
Personal goals
        ↓
Assistant
        ↓

"Hôm nay bạn có 3 việc quan trọng.

1. Hoàn thành X trước 11h.
2. Meeting lúc 14h.
3. Task Y đã quá hạn 2 ngày.

Tôi đề xuất làm X trước."
```

---

# 16. Phase 3 — Autonomous Workflows

Sau khi task/integration layer đủ ổn định:

```text
Research workflows

Document processing

Email triage

Project monitoring

Background agents

Subagents
```

Ví dụ:

```text
Notion:

Task = "Research competitor X"
Tag = research

          ↓

Webhook

          ↓

Harness

          ↓

Research Agent

          ↓

collect information

          ↓

summarize

          ↓

write result into Notion

          ↓

notify user
```

DeepSeek Harness bắt đầu phát huy lợi thế rõ nhất ở giai đoạn này.

---

# 17. Phase 4 — Proactive Personal Agent

Mục tiêu cuối:

Assistant không chỉ phản ứng với command.

Nó hiểu trạng thái hiện tại:

```text
Tasks

Calendar

Projects

Messages

Personal goals

Past behavior
```

và chủ động phát hiện:

```text
conflicts

deadlines

forgotten tasks

opportunities

unusual events
```

Ví dụ:

```text
"Ngày mai bạn có 5 meeting liên tục từ 13h–18h.

Task 'Prepare presentation' deadline 17h nhưng hiện vẫn Todo.

Tôi đề xuất dành 9h–11h để hoàn thành nó."
```

Đây mới là **persona personal agent** thực sự.

---

# 18. Nguyên tắc kiến trúc quan trọng

Toàn bộ hệ thống nên tuân theo:

```text
DETERMINISTIC SYSTEM
────────────────────

Database

Scheduler

Webhook

Retry

Authentication

Permissions

Idempotency


          ↓


PROBABILISTIC SYSTEM
────────────────────

LLM

Reasoning

Planning

Tool selection

Summarization
```

Không giao cho LLM những việc infrastructure có thể đảm bảo chắc chắn.

Ví dụ:

```text
❌ LLM nhớ rằng 8h phải nhắc.

✅ Scheduler đánh thức agent lúc 8h.
```

---

# 19. Chiến lược chi phí

Giai đoạn đầu:

```text
Vercel Hobby
      ↓
Frontend + API

Render Free
      ↓
Harness

AWS Lambda
+
EventBridge
      ↓
Triggers

External PostgreSQL
      ↓
persistent storage

DeepSeek API
      ↓
main variable cost
```

Mục tiêu:

> Tối thiểu hóa chi phí trong khi vẫn đo được độ tin cậy; inference là biến phí chính,
> nhưng database, log, notification, egress và scheduler cũng phải được theo dõi.

Không coi Render Free hoặc keep-alive là cam kết uptime. Khi reminder trở thành chức năng
thiết yếu, dùng worker/hosting có SLA phù hợp và kiểm tra bằng alert thay vì dựa vào ping.

Khi hệ thống có usage thật mới nâng:

```text
Render paid worker

managed PostgreSQL

queue

dedicated scheduler

observability
```

---

# 20. Thứ tự triển khai

```text
1. Định nghĩa schema, timezone, idempotency và permission model

2. Implement task tools và PostgreSQL transaction

3. Implement outbox, worker, retry/backoff và delivery log

4. Setup dispatcher + EventBridge/Lambda + DLQ

5. Implement một notification channel

6. Deploy Agent Runtime sau interface có thể thay thế

7. Tạo persona và chat

8. Integrate Notion read/write

9. Add Notion webhook (verify signature, inbox, dedupe)

10. Implement structured memory

11. Add Calendar

12. Add Gmail

13. Add workflow/subagent
```

Không nên bắt đầu bằng memory phức tạp hay multi-agent.

---

# 21. Tiêu chí MVP thành công

MVP đạt yêu cầu khi assistant có thể thực hiện ổn định các workflow:

### Task creation

```text
"Nhắc tôi làm X vào 8h tối mai."
```

### Recurring task

```text
"Mỗi sáng 8h cho tôi biết hôm nay cần làm gì."
```

### Task management

```text
"Tuần này tôi còn việc gì chưa hoàn thành?"
```

### Notion

```text
"Thêm cái này vào project X trên Notion."
```

### Event reaction

```text
Notion task updated
        ↓
assistant nhận biết
```

### Proactive notification

Assistant có thể chủ động gửi message mà không cần user mở web app.

## Tiêu chí độ tin cậy MVP

Ngoài các workflow trên, đặt các tiêu chí đo được:

```text
- Reminder được phát trong ±1 phút so với thời điểm đã xác nhận, theo timezone của user.
- Retry, restart hoặc webhook redelivery không tạo notification/action trùng.
- 100% action sensitive có approval server-side trước khi chạy.
- Mỗi trigger, tool call và notification có trace/audit log truy vết được.
- Worker lỗi có retry hữu hạn, backoff và alert/DLQ để xử lý thủ công.
```

---

# 22. Mục tiêu dài hạn

Kiến trúc cuối cùng:

```text
                     Personal Agent
                           │
                  DeepSeek Harness
                           │
        ┌──────────────────┼───────────────────┐
        ▼                  ▼                   ▼
      Memory              Tasks             Planning
        │                  │                   │
        └──────────────────┼───────────────────┘
                           │
                           ▼
                       Tool Layer
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
       Notion           Calendar           Gmail
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
                           ▼
                      Event Layer
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
           Time           Event       Condition
         Trigger         Trigger       Trigger
                           │
                           ▼
                    Proactive Agent
```

Mục tiêu không phải xây:

> **“ChatGPT có persona.”**

Mà là xây:

> **“Một personal agent luôn có trạng thái, hiểu công việc của người dùng, phản ứng với sự kiện và có thể chủ động hành động đúng lúc.”**

DeepSeek Harness đóng vai trò là **agent runtime**, trong khi task engine, trigger system, integrations và persistent memory tạo nên phần còn lại của sản phẩm.
