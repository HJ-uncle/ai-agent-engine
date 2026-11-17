# LLM Adapter Specification

## Purpose

Describe provider selection, wire compatibility, retries and observable request attempts. Source audit: 2026-11-17.

## Requirements

### Requirement: Protocol precedes inferred family

Adapter creation SHALL respect explicit protocol configuration before model-name inference.

#### Scenario: Explicit transport

- **WHEN** apiFormat=openai is specified
- **THEN** an OpenAI adapter SHALL be selected even for a DeepSeek/Qwen model name.
- **WHEN** an Anthropic endpoint/protocol is explicitly selected
- **THEN** the Anthropic path SHALL precede family routing.
- **WHEN** native Ollama is configured
- **THEN** it SHALL precede DeepSeek/Qwen inference.

Unrecognized provider strings currently fall back to OpenAI compatibility; they do not produce a universal UnsupportedProviderError. The synchronous factory fallback model is gpt-4o-mini, while stored configuration and other route defaults may differ.

### Requirement: Bounded retry without stream replay

The default retry wrapper SHALL allow 3 retries after the original attempt, with exponential delay starting at 1000 ms and capped at 30000 ms.

#### Scenario: Retriable failure

- **WHEN** an eligible 408/429/5xx or connection error occurs before stream output
- **THEN** the wrapper MAY retry within its configured bound.
- **WHEN** cancellation occurs or any stream chunk has already been emitted
- **THEN** it SHALL NOT replay that stream as a fresh attempt.

### Requirement: Fallback and physical attempt accounting

Fallback adapters SHALL preserve request intent while respecting the effective model's capabilities and context window. Physical attempts SHALL distinguish success, known failure and unknown outcome rather than count only successful final calls.

#### Scenario: Ambiguous upstream failure

- **WHEN** a transport failure prevents knowing whether the upstream completed/billed a request
- **THEN** local usage/accounting SHALL NOT invent an exact successful or zero-cost result.

### Requirement: Thinking and images use actual adapter contracts

Explicit thinking-off intent SHALL be resolved at the actual adapter, including child/fallback paths. Unsupported families SHALL NOT receive an invented universal off switch.

#### Scenario: Compatible family limitation

- **WHEN** Anthropic-compatible MiniMax/GLM requires enable_thinking=true
- **THEN** the limitation SHALL be documented instead of promising provider-level reasoning is disabled.
- **WHEN** an image tool payload is invalid or vision is disabled
- **THEN** the adapter SHALL NOT silently treat it as valid visual input.

Detailed wire mappings and limitations are in [thinking configuration](../../../docs/thinking-mode-config.md) and [multimodal inputs](../../../docs/multimodal-design.md).

## Source map

[Factory](../../../src/core/llm-adapter/factory.ts), [retry/fallback](../../../src/core/llm-adapter/retry.ts), [thinking](../../../src/core/llm-adapter/thinking.ts), [OpenAI](../../../src/core/llm-adapter/openai.ts), [Anthropic](../../../src/core/llm-adapter/anthropic.ts), [tests](../../../src/core/llm-adapter/__tests__/). This source audit did not establish current online compatibility for every provider/model.
