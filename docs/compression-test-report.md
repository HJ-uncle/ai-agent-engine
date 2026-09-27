# 性能测试报告 (Performance Test Report)

测试时间: 2026-04-26T06:20:00.994Z

## 测试用例 1: 中文长需求描述 (Extractive)
- **策略 (Strategy):** extractive
- **耗时 (Time):** 19.70 ms
- **压缩比 (Compression Ratio):** 77.18%
- **准确率/语义保留度 (Accuracy):** 82.95%
- **原始长度:** 241 字符
- **压缩后长度:** 186 字符

**压缩后文本:**
> 设计并实现一个上下文消息精简化系统，该系统能够在保持80%准确率（该阈值可作为可调参数配置）的前提下，对原始上下文消息进行智能压缩和提炼。 要求支持多种压缩策略（如关键词提取、句子压缩、语义摘要），具备实时处理能力，并提供压缩前后的语义相似度对比和准确率计算功能。 最终交付完整的系统架构设计、核心算法实现、参数配置接口、性能测试报告，以及详细的准确率评估方法和调优指南。

## 测试用例 2: 中文长需求描述 (Keyword)
- **策略 (Strategy):** keyword
- **耗时 (Time):** 1.10 ms
- **压缩比 (Compression Ratio):** 94.61%
- **准确率/语义保留度 (Accuracy):** 70.45%
- **原始长度:** 241 字符
- **压缩后长度:** 228 字符

**压缩后文本:**
> 压缩, 系统, 准确, 率, 的, 消息, 和, 语, 义, 设计, 并, 实现, 上下文, 该, 可, 调, 参数, 配置, 核心, 功能, 评估, 算法, 一个, 精简, 化, 能够, 在, 保持, 80, 阈, 值, 作为, 前提, 下, 对, 原始, 进行, 智能, 提炼, 需要, 包含, 以下, 模, 块, 重要性, 保留, 分析, 引擎, 比例, 动态, 调节, 器, 验证, 机制, 要求, 支持, 多种, 策略, 如, 关键, 词, 提取

## 测试用例 3: 英文段落 (Extractive)
- **策略 (Strategy):** extractive
- **耗时 (Time):** 1.04 ms
- **压缩比 (Compression Ratio):** 99.00%
- **准确率/语义保留度 (Accuracy):** 100.00%
- **原始长度:** 402 字符
- **压缩后长度:** 398 字符

**压缩后文本:**
> The quick brown fox jumps over the lazy dog. This is a simple test sentence to see if the extraction algorithm works properly. It should be able to identify the most important words and sentences in this short paragraph. If the compression ratio is too low, we might lose important details like the quick brown fox. However, maintaining a high accuracy is crucial for the performance of the system.

