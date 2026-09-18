# sub2api 接入与业务计费分离调研

日期：2026-09-18。结论：方向可行，复用 sub2api 的供应商接入、账号/Key 管理、消耗统计和运营后台；主站保留报价、用户账本、交付和可靠结算。匹配层负责身份、业务、调用与用量关联，不直接以 sub2api 余额替代主站积分。

本次是源码静态核查与实施前调研清单，没有部署、调用接口或进行付费测试。复用先前检出的官方 Wei-Shaw/sub2api commit `efe9aab1e4ec89a42ba45e8dac20e882c5409a6a`，不是声称已检查 9月18日最新main或实际部署版本。实施前须对目标版本复核。前次媒体研究保存在 `/Users/luke/Documents/Codex/2026-09-17/yuva-core-v1-2-release/outputs/media-billing-research-2026-09-17.md`。

## 1. 已确定的职责

| 层 | 权威数据与职责 |
|---|---|
| 主站账户与业务 | 登录身份、业务权限、套餐、订单、用户积分 |
| 主站业务账本 | 冻结用户报价、预占、固定价/Token价策略、交付后收费、退款、终态重放 |
| 服务端匹配层 | 主账号→影子账号、业务→Key、Operation→call→网关request→usage记录；用量归一化及对账 |
| sub2api | 上游路由、模型/渠道配置、网关用量与收费记录、影子账户技术额度、运营管理后台 |
| 前端 | 发起授权业务请求，展示主站报价/账单和后端筛选过的用量 |

sub2api 的 actual_cost 是其计价规则下的扣费额；不是天然等于最终供应商账单，也不是我们的用户售价。保留 provider_cost（可未知）、gateway_charge、user_charge 三个口径及来源/币种。报价可独立，也可未来选择冻结的成本转换策略，但不得在完结时读取实时倍率改写在途合同。

影子余额是上游使用预算，不与主站充值自动一比一同步。主站账本不因管理员在 sub2api 手工加额/扣额而改变。两个后台分别负责供应商运营与业务财务；sub2api 后台无法替代主站订单、套餐与退款管理。

## 2. 源码确认的能力和缺口

下列路径均相对于上述固定commit，链接列于末尾。

| 需求 | 已核查事实 | 后续验证 |
|---|---|---|
| 创建影子账号 | 管理员 `POST /api/v1/admin/users`，要求email/password，可配置余额、并发、RPM、允许分组；用户可disabled [S1,S2] | 稳定外部身份如何落地；创建超时后的查回；是否有部署级登录/邮件限制 |
| 服务端管理认证 | 管理路由接受 `x-api-key` 或管理员JWT [S3] | 管理凭证权限范围、轮换、网络隔离；不把全权凭证交给浏览器或普通调用路径 |
| 创建业务Key | 用户路由实际为 `POST /api/v1/keys`；Create从登录subject取得user ID，具备幂等协调 [S4,S5] | 已读管理员Key路由只有PUT分组修改，不能假定存在admin替用户创建Key。handler旧注释写api-keys，与实际路由不同，以路由为准 |
| Key预算/限制 | name、group_id、IP白名单、quota（USD）、过期、5h/1d/7d额度窗口 [S5] | 分组与模型限制能否满足每项业务；窗口额度不是RPM，不能混同 |
| 按业务查统计 | admin usage支持user_id、api_key_id、request_id过滤，另有stats和批量Key统计 [S1,S6] | 分页/时区/保留期/清理、日志延迟、金额舍入、准确总数与失败调用覆盖 |
| 用量字段 | request ID、用户/Key、model、输入输出及缓存tokens、费用倍率、图片数量/尺寸/图片tokens [S7] | 数字0是否表示缺失；真实provider字段与网关估算/回退如何区分；不能把字段存在当作可计费完整性证明 |
| 关联单次调用 | gateway返回 `X-Client-Request-ID`；已读middleware自行生成或使用内部context值，未读取同名入站header [S8] | 不可假设我们传Operation ID即可透传。必须落库响应header并核对各调用路径 |
| 网关扣费request ID | 普通路径优先 `client:<id>`，再local/upstream/generated；特定媒体/tool事件有强制ID [S9] | 按端点核实与usage查询一致；ACK丢失、无响应header时能否精确查回 |
| 技术额度调整 | admin `POST /users/:id/balance` 支持set/add/subtract，使用管理员幂等协调与Idempotency-Key [S2] | 幂等TTL/存储故障/过期重放及并发add的实际行为；不能只靠notes文本去重 |

**关键判断：Key适合业务分组，不足以定位一次Operation。** 同一Key上并发多次请求时，不能用时间窗口、余额差或每日统计推算某次用户应付金额。响应头丢失的精确关联能力是首个验证门槛。

## 3. 推荐匹配模型与流程

建议影子账号按 `(gateway_instance, tenant/product, main_account_id)` 唯一；业务Key按 `(shadow_account, business_code, credential_version)` 管理。多产品默认隔离，用户不直接持有影子账号凭证。Key名称便于运营识别，但不是权限依据。

最少保存以下关系（是逻辑模型，不预设必须新增独立表）：

- 身份：主账号、sub2api实例/用户ID、开通状态、凭证引用、最近同步错误。
- Key：业务标识、上游Key ID、分组、加密密钥引用、状态和轮换版本；旧Key对应历史用量仍可查。
- 调用：Operation ID、attempt/call ID、当次Key ID、模型、网关响应关联ID、上游ID（如有）、提交/响应状态。
- 用量观察：实例+usage记录ID去重，归属调用、原始事实的受控快照、来源/完整性、观察版本和时间；日志更新可补充事实而不能反复累计。
- 对账：游标/重叠时间窗、重复去重、未知关联、差异原因、人工处理记录；存量数据由主站保留，避免上游清日志破坏已出账审计。

请求流程：主站鉴权与能力预检 → 冻结报价/预算并预占 → 后端选择业务Key → 记录call后请求sub2api → 尽早保存响应关联ID及结果 → 从响应和可信服务端日志补用量 → 按业务交付合同决定收费 → 现有账本原子结算。所有请求路径均经过相同授权；前端不能指定任意Key/分组/上游URL、余额、usage或结算状态。

业务样例：报告内部调用3次，归属同一Operation、3个call，网关记录消耗，用户按报告合同收1次；Token聊天按冻结的业务费率和合格用量结算；单图按保存并验证后的固定价结算。业务Key长期复用，不为每次调用新建Key。

同步响应usage与日志是同一事实的不同观察，不能各加一次。内部网关重试/切换是否逐次公开，必须验证；缺少失败调用日志时成本覆盖率保留unknown，不声称已掌握每次上游真实成本。

## 4. 自动开户与额度的可选接法

优先验证不修改sub2api的路径：管理员创建普通影子用户 → 后端以其机器生成凭证登录 → 调用户接口幂等创建业务Key → 加密保存Key，按需管理会话。登录端点存在，但验证码、2FA、refresh和backend mode策略可能影响无人值守，尚未验收，不能承诺直接可用。

若现有API无法稳定服务化，再评估小范围、可审计的受限管理扩展，按外部身份创建/查询Key；禁止直接写sub2api数据库。不要先假定需要fork，也不要把管理员JWT登录当作普通影子用户身份。

主站开通流程使用持久状态与唯一约束，重试先核对已创建账号/Key；响应丢失时不盲增用户或Key。影子账号采用不暴露真实邮箱的稳定别名需验证邮箱唯一性、长度、删除/重建规则。

额度先采用有上限的技术预算，低额告警，失败时阻止新上游调用；不以“设无限余额”消除对账。预算补给是独立运维事件，使用稳定幂等键并保存结果，不是用户充值回调的副作用。API金额为float64时，边界用十进制规范化与明确精度规则，不将浮点值直接参与主站积分运算。

## 5. 必做验证清单与判定

| 阶段 | 实验 | 通过标准 |
|---|---|---|
| A 账号/Key | 并发首次使用、创建ACK丢失、登录失效、Key轮换、主账号禁用 | 唯一映射；不会用错用户Key；旧Key历史可对账；禁用阻止新调用 |
| B 调用关联 | 同Key并发、流式/非流式/图片、请求超时与响应头丢失、网关内部重试 | 成功能精确关联；无法查回的调用保持unknown，绝不用聚合差额代替 |
| C 计量/结算 | 缓存tokens、显式零/缺失、日志迟到/修订/重复、收费中途调价 | 不重复累计；按原报价结算；来源和缺失不丢失；终态后不自动追扣 |
| D 隔离/恢复 | 篡改business/model/key/usage、跨用户查询、重复提交、结算ACK丢失 | 越权在后端拒绝；账本不重复收费；上游消耗受调用/并发/预算约束 |
| E 图片交付 | 网关已扣款但转存失败、下载过期、主站崩溃 | 先恢复已有产物；不能恢复时按用户合同处理，供应商成本由产品承担或记待核对 |
| F 管理与对账 | 后台手动调余额/分组/价格，清日志，统计延迟 | 不改主站历史账单；能解释上下游差异；不因日志清理丢本地审计 |

先用本地隔离sub2api+fake upstream与隔离数据库执行，不用真实用户和付费API。真实供应商测试需要明确目标、账号与费用上限。当前未执行这些实验。

前端被篡改不应能决定账本事实，但这不等于“绝无成本风险”：被盗会话仍可提交合法请求；后端鉴权、限流、预算、模型白名单和幂等必须保留。sub2api全权后台被攻破也不属于前端隔离能解决的范围。

## 6. 建议排期与 #14 调整

1. **先做接口兼容性验证**：只验证A/B/C关键路径，形成目标部署版本的能力矩阵。自动Key创建与丢失关联必须先有结论。
2. **实现通用sub2api适配器**：身份/业务Key映射、请求代理、用量归一化与对账；产品规则通过接口注入，不把sub2api写死进公共账本。
3. **先接一个文本业务验收匹配层**：固定价报告和Token业务通过fixture验证分离，不默认切换所有线上产品。
4. **接图片V1**：沿用已规划的一次单图、冻结固定价、耐久保存后结算；供应商路由和用量统计通过sub2api，存储/交付恢复仍由产品负责。
5. **运营与消费者升级**：复用sub2api管理后台，同时保留主站业务账本审计和差异查询，测试通过后按版本发布/逐消费者升级流程推进。

这次调整减少供应商配置、模型路由、上游统计与管理UI重复开发，不删除已完成的Operation、定价、预占、结算和恢复机制。视频仍是后续独立选型。

## 固定源码证据

- [S1 管理路由](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/server/routes/admin.go#L301)
- [S2 用户创建/余额接口](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/handler/admin/user_handler.go#L61)
- [S3 管理认证](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/server/middleware/admin_auth.go#L25)
- [S4 用户Key路由](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/server/routes/user.go#L76)
- [S5 Key创建/限制](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/handler/api_key_handler.go#L182)
- [S6 用量查询过滤](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/handler/admin/usage_handler.go#L76)
- [S7 用量DTO](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/handler/dto/types.go#L587)
- [S8 响应关联ID](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/server/middleware/client_request_id.go#L14)
- [S9 扣费关联规则](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/service/gateway_usage_billing.go#L206)
- [S10 登录/刷新路由](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/server/routes/auth.go#L39)
