# Yuva Agent Starter

用于构建领域 AI Web 应用的通用 JavaScript 脚手架：React、Express、PostgreSQL、模型适配、认证接入点和积分账本。

仓库包含可运行的文本助手模板。替换事实计算、提示词、定价和界面，即可开发客服助手、文档分析等自己的产品。本地运行不需要 YUVA 服务或账号。

[English](README.md) · [快速开始](docs/quickstart.md) · [完整文档](docs/README.md) · [架构](ARCHITECTURE.md)

## 应用自托管认证

应用内 Better Auth 适配器提供邮箱注册、验证、密码重置、Cookie 会话、设备退出及仅本机可用的开发收件箱。
选择 `AUTH_MODE=self-hosted`，按[自托管认证指南](docs/self-hosted-auth.md)配置；原 Clerk 模式继续保留。
此版本不提供 OAuth issuer，也不会自动配置真实第三方登录或迁移已有账号。同邮箱旧账号不会被自动认领。

## 包含什么

- **Web 界面：** React 19 + Vite，结构化输入、事实预览、亮暗主题、请求状态和积分反馈
- **AI 运行时：** 请求级编排、上下文预算、OpenAI Responses / Anthropic 适配器和无需凭据的本地 mock
- **积分与恢复：** PostgreSQL 积分发放、预占、固定价或 token 定价、幂等重放、用量记录和恢复机制
- **应用安全基础：** 认证与用户建档接入点、限流组件、安全响应头、CORS 白名单和公开错误脱敏
- **可复用模块：** AI、上下文、计费、认证、管理员操作与审计，配有应用/核心边界检查
- **开发工具：** 项目生成器、版本化核心包、数据库迁移、测试和本地开发容器

默认应用通过 SSE 返回文本，先在服务端缓存并校验完整输出，再交付答案。领域业务逻辑、生产登录界面、支付收银台和真实图像/视频生成需要由产品自行实现。管理员操作与审计目前是库能力，未附带管理后台界面。

## 快速开始

### 环境要求

- Git
- 必须使用 **Node.js 24.x**（`>=24 <25`，`.nvmrc` 指定 24）；不再支持 Node.js 22
- 项目声明的包管理器为 **npm 10**（`npm@10.9.8`）
- **PostgreSQL 16+**，或安装 Docker 与 **Compose v2**，使用仓库提供的 PostgreSQL 16 容器

以下命令使用 POSIX shell；PowerShell 可将 `cp` 换成 `Copy-Item`。

```bash
git clone https://github.com/LukeJiaoR/yuva-agent-starter.git
cd yuva-agent-starter

cp starter-app/.env.example starter-app/.env
cp starter-web/.env.example starter-web/.env
npm ci

docker compose up -d --wait postgres
npm run db:setup
npm run dev
```

已有 PostgreSQL 时，先为应用创建独立数据库，把 `starter-app/.env` 中的 `DATABASE_URL` 改为该数据库地址，再跳过 Docker 命令。数据库用户需要创建应用表和函数的权限，详见[数据库配置](docs/quickstart.md#database-setup)。

打开 **http://localhost:5173**，等待 **API ready**，保留示例输入并点击 **Prepare and continue**。首次成功请求会返回确定性的 mock 答案，扣除 **2 个本地积分**；开发账号初始获得 **25 个积分**。这条本地流程不需要模型 API Key，不会调用付费模型或支付服务。

API 地址为 `http://localhost:3000`。在另一个终端验证：

```bash
curl --fail http://localhost:3000/health
curl --fail http://localhost:3000/ready
```

`/health` 只检查进程存活；`/ready` 应返回 HTTP 200，并包含 `"status":"ready"` 和 `"database":"connected"`。异常情况见[故障排查](docs/quickstart.md#troubleshooting)。

> 默认访客、示例数据库密码和 mock 仅用于本地开发，不应暴露到互联网。生产环境拒绝 mock，需要自行配置认证、密钥和部署环境。

### 全容器运行

安装 Docker 与 Compose v2 后，在仓库根目录执行：

```bash
docker compose up --build
```

服务就绪后打开 **http://localhost:8080**。该流程构建 Web/API 镜像并初始化数据库，仍使用本地 mock，宿主机无需安装 Node.js。`docker compose down` 停止服务并保留数据库卷。

## 配置

| 文件 | 用途 |
| --- | --- |
| `starter-app/.env` | 服务端数据库、模型、认证与运行参数 |
| `starter-web/.env` | 公开产品名称、描述与 Vite 开发代理配置 |

从[服务端示例](starter-app/.env.example)与[前端示例](starter-web/.env.example)开始：

| 变量 | 默认值或用途 |
| --- | --- |
| `DATABASE_URL` | `postgresql://starter:starter@localhost:5432/starter_agent`，对应 Compose 数据库 |
| `AI_PROVIDER` | 默认 `mock`；应用支持 `mock`、`openai`、`anthropic` |
| `ALLOW_DEV_GUEST` | 本地为 `true`，生产应设为 `false` |
| `DEV_GUEST_CREDITS` | 默认 `25`，开发 seed 仅发放一次 |
| `PORT` | API 默认 `3000` |
| `CORS_ORIGIN` | 逗号分隔的前端来源白名单 |
| `VITE_API_PROXY_TARGET` | 本地 API 代理默认 `http://127.0.0.1:3000` |

不要提交凭据。`VITE_*` 值可能打包进浏览器代码，必须可以公开。修改后重启相关服务。

### 使用真实模型（可选）

在 `starter-app/.env` 填入自己的模型凭据与可用模型 ID：

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=your-provider-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=your-responses-compatible-model-id
```

OpenAI 适配器调用 **`/responses`**。自定义 `OPENAI_BASE_URL` 必须支持该协议，仅兼容 `/chat/completions` 并不足够。应用没有独立的 `deepseek` 或 `ollama` provider 模式。

使用 Anthropic 时，改设 `AI_PROVIDER=anthropic`、`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`，模型 ID 以自己账号实际可用范围为准。真实模型费用与本应用的积分账本彼此独立。

## 生成自己的项目

在本仓库的**干净工作区**中运行：

```bash
npm run create -- my-agent --domain "Customer support" --domain-key support --install
cd ../my-agent

docker compose up -d --wait postgres
npm run db:setup
npm run dev
```

默认生成位置是仓库的**同级目录**，可用 `--target /path/to/my-agent` 指定位置。不要让模板和生成项目的数据库容器同时占用同一个宿主机端口；不同产品应使用独立数据库。

生成器会创建应用工作区和本地环境文件，将核心包固定为 `vendor/yuva-core/` 中经过校验的 tarball，不复制可编辑的核心源码。该流程无需私有 npm 仓库或 GitHub token。详见[项目生成](docs/creating-a-project.md)和[核心升级](docs/releases.md)。

## 架构与定制

```text
React UI -> Express API -> 领域事实 + 提示词/上下文
                              |
                         模型适配器
                              |
                         校验 + 积分结算
                              |
                    PostgreSQL -> SSE 响应
```

| 位置 | 职责或定制内容 |
| --- | --- |
| `starter-web/` | 产品界面、品牌与 API 客户端 |
| `starter-app/server/domain/adapter.js` | 输入、事实、快照与上下文 |
| `starter-app/server/domain/prompts.js` | 领域提示词 |
| `starter-app/server/domain/pricing.config.js` | 默认固定功能价格 |
| `starter-app/server/domain/aiProduct.js` | 固定/token 定价、执行预算、交付与持久化 |
| `starter-app/server/index.js` | 依赖注入、认证、路由与输出校验接入点 |
| `packages/` | 可复用 AI、上下文、计费、认证和管理员核心 |
| `scripts/schema.sql`、`scripts/migrations/` | 初始结构与有序数据库迁移 |
| `examples/customer-support/` | 独立安装的消费端示例 |

业务行为应留在应用工作区。默认事实适配器是最小示例，没有实现实际领域计算；发布产品前请完成[定制清单](docs/customization.md)。

## 开发与验证

```bash
npm run verify:boundaries  # 核心包边界检查
npm run build             # 构建 Web
npm run check             # 边界检查、测试、Web 构建
```

数据库测试需要**独立、可丢弃的 PostgreSQL 数据库**。严格验收必须显式提供地址：

```bash
TEST_DATABASE_URL=postgresql://starter:starter@localhost:5432/starter_agent npm run test:acceptance
```

示例地址只应用于本地可丢弃数据库。无可用数据库时，部分本地测试会跳过，另一些会失败；局部测试或前端构建通过不代表数据库和端到端验证通过。完整流程与浏览器验收见[测试文档](docs/testing.md)。

## 文档导航

- [快速开始与排障](docs/quickstart.md)
- [生成独立项目](docs/creating-a-project.md)
- [领域、认证、定价和 UI 定制](docs/customization.md)
- [HTTP / SSE API](docs/api.md)
- [架构与包边界](ARCHITECTURE.md)
- [测试](docs/testing.md)与[生产部署](docs/deployment.md)
- [核心发布与升级](docs/releases.md)
- [全部文档](docs/README.md)

## 贡献、支持与安全

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。可通过 [GitHub Issues](https://github.com/LukeJiaoR/yuva-agent-starter/issues) 提交可复现问题、使用疑问和功能建议；请先移除日志中的凭据和私人数据。

疑似漏洞或凭据泄露请遵循 [SECURITY.md](SECURITY.md)，不要在公开 issue 中贴出漏洞利用细节或密钥。

## 许可证

[MIT](LICENSE)。第三方依赖遵循各自许可证。

### 本地 MOCK 图片闭环

可显式启用需登录的 **1×1 合成 PNG 演示**，验证持久化产物、固定积分结算及限定当前账号/操作的重启恢复，不调用真实图片供应商。默认关闭，生产环境禁止启用。配置与 API 见[本地 MOCK 图片说明](docs/mock-image-product.md)。

### 可选的本地合成结账演示

[本地合成订单说明](docs/mock-checkout.md)：默认关闭，仅显式启用、已验证登录和回环连接可用。使用现有 payments 表保存待处理/已取消的合成订单，不收款、不发放积分，套餐数值仅为测试示例。启用前须独立确认数据库可丢弃，并配置数据库确认标记和本地可信浏览器来源；确认标记不代表技术隔离证明。
