# Yuva Agent Starter

一个用于快速创建垂直 AI Web App 的开源脚手架。内置 React 工作台、Express API、PostgreSQL 积分账本、流式响应、认证接入点和管理员审计能力。

[English](README.md) · [文档入口](docs/README.md) · [架构说明](ARCHITECTURE.md)

## 已包含的能力

- React 19 + Vite 的响应式工作台，支持亮色和暗色主题
- Express API，包含存活/就绪探针、安全响应头、CORS 白名单和安全错误输出
- 请求级隔离的 AI 流式运行时，支持 OpenAI 兼容接口、Anthropic、DeepSeek、Ollama 和本地 mock
- PostgreSQL 积分发放、原子预占与结算、幂等重放、用户自动建档、限流和管理员审计
- 清晰的领域定制边界：事实、提示词、校验和定价
- 项目生成器、Docker Compose、本地数据库命令、CI，以及 Node.js 22/24 验证

## 最快启动

推荐使用 Node.js 24、npm 10 和 PostgreSQL 16 或更高版本。

```bash
cp starter-app/.env.example starter-app/.env
npm ci
npm run db:setup
npm run dev
```

打开 `http://localhost:5173`。默认的 `mock` AI provider 不需要 API Key，并且在生产环境中会被禁用。

如果本地还没有 PostgreSQL，可以先启动 Compose 中的数据库：

```bash
docker compose up -d postgres
npm run db:setup
npm run dev
```

全容器验证：

```bash
docker compose up --build
```

然后打开 `http://localhost:8080`。

## 创建新项目

在本仓库执行：

```bash
npm run create -- my-agent --domain "Legal operations" --domain-key legal
cd my-agent
npm ci
npm run db:setup
npm run dev
```

生成器会复制可复用源码，改写项目名，创建本地环境文件，并把项目元数据写入 `.starter.json`。增加 `--install` 可以在生成时安装依赖。

## 主要定制位置

| 关注点 | 文件 |
| --- | --- |
| 确定性事实和输入结构 | `starter-app/server/domain/adapter.js` |
| 系统提示词和分析提示词 | `starter-app/server/domain/prompts.js` |
| 功能积分价格 | `starter-app/server/domain/pricing.config.js` |
| 产品名称和描述 | `starter-web/.env` |

Provider 凭证和部署配置放在 `starter-app/.env`，不要提交这个文件。

## 验证

```bash
npm run check
```

该命令会执行包测试、真实 HTTP 集成测试、边界检查和生产构建。完整使用说明见 [文档入口](docs/README.md)。

## 许可证

[MIT](LICENSE)
