# 上下文消息智能压缩系统设计文档 (Context Compression System Design)

## 1. 系统架构概述 (System Architecture)

上下文消息智能压缩系统是一个流水线 (Pipeline) 架构，旨在将冗长的对话历史（Tokens）进行高保真度的压缩，在保证核心语义（准确率 >= 80%）的前提下，最大化降低大语言模型 (LLM) 的上下文输入成本。

系统包含以下四个核心模块：
1. **输入与预处理模块 (Preprocessor):** 负责清洗、分词、去除停用词。
2. **消息重要性评估引擎 (Importance Evaluator):** 使用 TF-IDF 或 TextRank 算法对每个句子/词汇进行权重打分。
3. **动态压缩引擎 (Dynamic Compression Engine):** 提供多种策略（提取式摘要、关键词提取、生成式摘要）和动态压缩比例 (Compression Ratio) 调节器。
4. **准确率验证机制 (Accuracy Verifier):** 基于 N-gram Jaccard 相似度或余弦相似度计算压缩前后的语义保留度。

## 2. 核心功能模块设计

### 2.1 消息重要性评估算法 (Importance Evaluation)
- **词频-逆文档频率 (TF-IDF):** 计算上下文中每个词的重要性，对于频繁在全局出现但局部稀有的词赋予高权重。
- **句子打分:** 句子的重要性分数为其包含词汇的 TF-IDF 分数总和除以句子长度（进行长度惩罚，防止长句天然得分高）。

### 2.2 多种压缩策略 (Compression Strategies)
1. **关键词提取 (Keyword Extraction):** 仅保留 TF-IDF 权重最高的前 N 个词汇。适合极度压缩（如压缩率 0.1）。
2. **提取式压缩 (Extractive Compression):** 按照句子重要性得分进行排序，保留得分最高的前 N 个句子，然后按原文顺序重组。适合中度压缩（如压缩率 0.3-0.7）。
3. **生成式摘要 (Abstractive Summarization - 可选):** 将历史消息发送给轻量级本地或云端 LLM 进行语义总结。

### 2.3 压缩比例动态调节器 (Dynamic Ratio Adjuster)
- 闭环反馈机制：初始设置目标压缩率为 `R_init`。
- 压缩后，立即送入“准确率验证机制”。
- 若相似度 `S < 0.8` (阈值)，则增大压缩率（例如 `R = R + 0.1`，保留更多内容），并重新进行压缩，直至满足准确率要求或达到最大重试次数。

### 2.4 准确率验证机制 (Verification Mechanism)
在没有昂贵的 Embedding 模型时，采用 **N-gram Jaccard 相似度** 评估语义保留度。
- **Unigram/Bigram 集合:** 将原文 $T_{orig}$ 和压缩文 $T_{comp}$ 分别转换为 N-gram 集合 $S_{orig}$ 和 $S_{comp}$。
- **Jaccard 相似度:** $J(S_{orig}, S_{comp}) = \frac{|S_{orig} \cap S_{comp}|}{|S_{orig} \cup S_{comp}|}$
- 为消除文本长度对分母的过度影响，可采用**覆盖率 (Coverage)**: $C = \frac{|S_{orig} \cap S_{comp}|}{|S_{orig}|}$。本项目采用加权覆盖率作为准确率指标。

## 3. 参数配置接口 (Configuration Interface)

系统暴露 `CompressionConfig` 接口，支持灵活配置：
```typescript
interface CompressionConfig {
  targetAccuracy: number;       // 目标准确率阈值，默认 0.8 (80%)
  minCompressionRatio: number;  // 最小压缩比，默认 0.1
  maxCompressionRatio: number;  // 最大压缩比，默认 0.9
  strategy: 'extractive' | 'keyword'; // 默认采用提取式
  maxRetries: number;           // 动态调节最大重试次数，默认 3
}
```

## 4. 准确率评估方法与调优指南 (Tuning Guide)

### 准确率评估方法
1. **测试集准备:** 准备 10-20 段真实的 LLM 历史对话数据。
2. **指标计算:** 运行测试脚本，统计平均压缩比 (Average Compression Ratio) 和平均准确率 (Average Accuracy)。
3. **人工抽样:** 抽取相似度在 75%-85% 之间的样本进行人工阅读，验证核心意图是否丢失。

### 调优指南 (Tuning)
- **如果准确率过低 (< 80%):**
  1. 提高 `minCompressionRatio`，强制保留更多原始句子。
  2. 调整打分函数，减少对长句的过度惩罚。
  3. 增加停用词表，去除无意义虚词对 Jaccard 分母的干扰。
- **如果压缩效果不明显 (压缩率 > 0.8):**
  1. 降低 `targetAccuracy` 至 0.7，允许损失部分边缘细节。
  2. 切换策略为 `keyword` 提取。
