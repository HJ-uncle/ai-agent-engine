# llm-adapter Specification

## Purpose
TBD - created by archiving change ai-agent-engine. Update Purpose after archive.
## Requirements
### Requirement: Multi-Provider Support

The LLM Adapter SHALL support OpenAI, Anthropic, and Ollama as LLM providers, switchable via configuration without code changes.

#### Scenario: Switch to OpenAI provider
- **WHEN** the configuration sets `provider: "openai"` and provides a valid `apiKey`
- **THEN** the adapter SHALL route all `complete()` and `stream()` calls to the OpenAI API endpoint

#### Scenario: Switch to Anthropic provider
- **WHEN** the configuration sets `provider: "anthropic"` and provides a valid `apiKey`
- **THEN** the adapter SHALL route all calls to the Anthropic Messages API, translating the common message format to Anthropic's format

#### Scenario: Switch to Ollama provider
- **WHEN** the configuration sets `provider: "ollama"` and provides a valid `baseUrl`
- **THEN** the adapter SHALL route all calls to the Ollama local API without requiring an API key

#### Scenario: Unknown provider configuration
- **WHEN** the configuration specifies an unknown `provider` value
- **THEN** the adapter SHALL throw an `UnsupportedProviderError` at initialization time

---

### Requirement: Streaming Output

The LLM Adapter SHALL provide a `stream()` method that returns an `AsyncIterable<string>` delivering response tokens incrementally.

#### Scenario: Successful streaming
- **WHEN** `stream(messages, options)` is called with valid messages
- **THEN** the adapter SHALL return an `AsyncIterable<string>` that yields each token chunk as it is received from the provider

#### Scenario: Stream completion
- **WHEN** the provider signals end of stream
- **THEN** the `AsyncIterable` SHALL complete (iterator `done: true`) and the adapter SHALL record the final token counts

#### Scenario: Stream error mid-flight
- **WHEN** the provider connection drops during streaming
- **THEN** the adapter SHALL throw a `StreamInterruptedError` from the async iterator and attempt retry according to the retry policy

---

### Requirement: Non-Streaming Completion

The LLM Adapter SHALL provide a `complete()` method that returns the full LLM response as a single resolved value.

#### Scenario: Successful completion
- **WHEN** `complete(messages, options)` is called with valid messages
- **THEN** the adapter SHALL return a `CompletionResult` object containing `content`, `promptTokens`, and `completionTokens`

#### Scenario: Empty response
- **WHEN** the provider returns an empty content string
- **THEN** the adapter SHALL return a `CompletionResult` with `content: ""` and SHALL NOT throw an error

---

### Requirement: Automatic Retry with Exponential Backoff

The LLM Adapter SHALL automatically retry failed requests using exponential backoff, up to a maximum of 3 attempts, when a timeout or HTTP 5xx error occurs.

#### Scenario: Retry on 5xx error
- **WHEN** the provider returns an HTTP 5xx response on the first attempt
- **THEN** the adapter SHALL wait `baseDelay * 2^(attempt-1)` milliseconds and retry, up to 3 total attempts

#### Scenario: Success on second attempt
- **WHEN** the first attempt fails with a 5xx and the second attempt succeeds
- **THEN** the adapter SHALL return the successful result without surfacing the first failure to the caller

#### Scenario: All retries exhausted
- **WHEN** all 3 attempts fail with 5xx or timeout errors
- **THEN** the adapter SHALL throw a `LLMProviderError` containing the last error details and the number of attempts made

#### Scenario: Non-retryable error
- **WHEN** the provider returns an HTTP 4xx error (e.g., 401 Unauthorized, 400 Bad Request)
- **THEN** the adapter SHALL NOT retry and SHALL immediately throw the error to the caller

---

### Requirement: Fallback Strategy

The LLM Adapter SHALL support a fallback provider list so that if the primary model fails all retries, it automatically switches to the next available model in priority order.

#### Scenario: Fallback to secondary model
- **WHEN** the primary model exhausts all retries and a `fallbackModels` list is configured
- **THEN** the adapter SHALL attempt the request on the first entry in `fallbackModels`

#### Scenario: All fallback models exhausted
- **WHEN** all models in the `fallbackModels` list also fail
- **THEN** the adapter SHALL throw a `AllModelsFailedError` listing the names of all attempted models

#### Scenario: No fallback configured
- **WHEN** `fallbackModels` is not configured and the primary model fails all retries
- **THEN** the adapter SHALL throw a `LLMProviderError` without attempting any fallback

---

### Requirement: Token Counting

The LLM Adapter SHALL record `promptTokens` and `completionTokens` after every successful `complete()` or completed `stream()` call.

#### Scenario: Token counts recorded after complete()
- **WHEN** `complete()` returns successfully
- **THEN** the adapter SHALL emit a `tokenUsage` event (or update the returned `CompletionResult`) with `promptTokens` and `completionTokens` as non-negative integers

#### Scenario: Token counts recorded after stream()
- **WHEN** the stream from `stream()` finishes
- **THEN** the adapter SHALL emit a `tokenUsage` event with the accumulated `promptTokens` and `completionTokens` for the entire stream

#### Scenario: Token counts on retry
- **WHEN** a request succeeds after one or more retries
- **THEN** the adapter SHALL record only the token counts from the successful attempt, not the failed attempts

