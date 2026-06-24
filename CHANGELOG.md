# Changelog

## 0.1.4

- Fix: Claude empty SSE stream now retries once with `stream=false` instead of failing.
- Fix: OpenAI-compatible non-SSE JSON responses are now parsed and reported.
- Fix: Claude tool call arguments no longer corrupt when `input_json_delta` follows `content_block_start`.
- Fix: Model vision capabilities are not overridden by API-returned `false` for known vision models.
- Enhance: Image data parts in nested or non-standard object shapes are now recognized.

## 0.1.0

- Initial public preview.
- Add Magic Router as a GitHub Copilot Chat language model provider.
- Add BYOK setup with Base URL and API Key commands.
- Store API keys in VS Code SecretStorage.
- Load models dynamically from `{baseUrl}/openai/v1/models`.
- Route Claude requests to `{baseUrl}/claude/v1/messages` with the Anthropic Messages payload shape; route other chat completions to `{baseUrl}/openai/v1/chat/completions`.
- Support Copilot Agent mode tool calls, image input, and reasoning output.
- Add model picker metadata for vision, thinking, context windows, and model costs.
- Add optional public metadata enrichment for AIXRouter and AgileRouter model catalogs.
- Add first-run setup guidance and clearer HTTP error messages.
