# 魔法路由（Magic Router for Copilot）

[English](README.md) | [简体中文](README.zh-cn.md)

在 GitHub Copilot Chat 模型选择器中直接使用魔法路由支持的模型，无需离开 Copilot Agent 模式。

喜欢魔法路由的统一中转能力，但不想放弃 GitHub Copilot 的 Agent 模式、工具调用、Instructions、MCP 和成熟的交互体验？本扩展将 OpenAI 兼容模型接入 Copilot Chat 模型选择器，支持视觉输入、思考模式和自带 API Key。

## 为什么选这个扩展？

- 不是替换 Copilot，而是增强 Copilot。没有新的侧边栏，没有新的聊天界面，只是在模型选择器中多出魔法路由模型。
- Agent 模式、工具调用、Instructions、MCP、Skills 仍然由 Copilot Chat 驱动，模型请求转发到你的 OpenAI 兼容路由接口。
- API Key 存在 VS Code SecretStorage 中，不写入 `settings.json`。
- 魔法路由模型列表默认从 `/models` 动态读取，也可以用设置固定展示指定模型。
- 对 AIXRouter / AgileRouter Base URL，成本、多模态和上下文信息会从公开模型页补齐，并显示在 Copilot 的模型选择器中；也可以关闭该增强。
- 多模态模型会接收 Copilot Chat 中的图片附件，并按 OpenAI `image_url` 内容格式发送给路由接口。
- 支持 OpenAI 兼容流式输出、工具调用和 `reasoning_content` 思考内容；Claude、GPT、Gemini 等主流模型会按 Copilot 风格显示思考工作量选项。

## 前置条件

- VS Code 1.116 及以上版本。
- 已安装并登录 GitHub Copilot / Copilot Chat。
- OpenAI 兼容路由 API Key。

## 快速开始

1. 在 VS Code 中安装并启用扩展。
2. 运行命令 `Magic Router: Set Base URL`，输入你的 OpenAI 兼容 Base URL。
3. 运行命令 `Magic Router: Set API Key`，粘贴你的 API Key。
4. 打开 Copilot Chat，点击模型选择器。
5. 选择 Magic Router 提供的模型，开始使用 Agent 模式。

常用 Base URL：

| 服务 | Base URL |
| --- | --- |
| AIXRouter | `https://api.aixrouter.com/openai/v1` |
| AgileRouter | `https://api.agilerouter.com/openai/v1` |

## 设置项

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `magicrouter.baseUrl` | 空 | OpenAI 兼容 API Base URL，首次安装后由用户输入 |
| `magicrouter.models` | `[]` | 固定模型列表。留空时从 `/models` 动态读取 |
| `magicrouter.maxTokens` | `0` | 最大输出 Token，`0` 表示不限制 |
| `magicrouter.temperature` | `null` | 可选温度参数 |
| `magicrouter.reasoningEffort` | `high` | 支持思考模型的默认思考强度 |
| `magicrouter.enrichPublicModelMetadata` | `true` | 对 AIXRouter / AgileRouter Base URL，从公开模型页补齐成本、多模态和上下文信息 |
| `magicrouter.debug` | `false` | 输出调试日志，不记录完整提示词 |

## 推荐模型元数据

`{baseUrl}/models` 是模型列表和模型能力的权威来源。为了让 Copilot 模型选择器显示更完整，建议每个模型返回能力、上下文和价格字段：

```json
{
  "id": "claude-opus-4.6",
  "owned_by": "Anthropic",
  "type": "Multimodal",
  "contextWindow": 1000000,
  "maxOutputTokens": 32000,
  "capabilities": {
    "toolCalling": true,
    "vision": true,
    "thinking": true
  },
  "pricing": {
    "currencyCode": "USD",
    "inputPer1M": 5,
    "outputPer1M": 25,
    "cacheHitPer1M": 0.5,
    "cacheCreationPer1M": 0
  }
}
```

固定模型示例：

```json
{
  "magicrouter.models": [
    {
      "id": "gpt-4o",
      "name": "GPT-4o via Magic Router",
      "family": "openai",
      "maxInputTokens": 128000,
      "maxOutputTokens": 8192,
      "toolCalling": true,
      "vision": true,
      "thinking": false
    },
    {
      "id": "deepseek-r1",
      "name": "DeepSeek R1 via Magic Router",
      "family": "deepseek",
      "maxInputTokens": 128000,
      "maxOutputTokens": 8192,
      "toolCalling": true,
      "vision": false,
      "thinking": true
    }
  ]
}
```

## 开发

```bash
pnpm install
pnpm run compile
```

然后在 VS Code 中按 `F5` 启动 Extension Development Host。

## 说明

认证方式为 `Authorization: Bearer <your-api-key>`。本扩展按 OpenAI 兼容协议调用 `{baseUrl}/models` 和 `{baseUrl}/chat/completions`。公开模型页只用于补充元数据：当 Base URL 属于 `aixrouter.com` 时访问 `https://www.aixrouter.com/models`，属于 `agilerouter.com` 时访问 `https://www.agilerouter.com/models`；其他域名不会访问这两个页面。
