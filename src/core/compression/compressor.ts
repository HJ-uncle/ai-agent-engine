import { CompressionConfig, CompressionResult, SentenceScore } from './types.js';
import { CompressionMetrics } from './metrics.js';

export class ContextCompressor {
  private config: CompressionConfig;

  constructor(config?: Partial<CompressionConfig>) {
    this.config = {
      targetAccuracy: 0.8,
      minCompressionRatio: 0.1,
      maxCompressionRatio: 0.9,
      strategy: 'extractive',
      maxRetries: 3,
      ...config,
    } as CompressionConfig;
  }

  /**
   * 压缩入口：对长文本应用智能压缩策略并验证结果
   */
  public compress(text: string): CompressionResult {
    let currentRatio = this.config.minCompressionRatio;
    let bestResult: CompressionResult | null = null;
    let retries = 0;

    // 动态压缩率调节闭环 (Dynamic Ratio Adjuster)
    while (retries <= this.config.maxRetries && currentRatio <= this.config.maxCompressionRatio) {
      let compressedText = '';
      
      if (this.config.strategy === 'extractive') {
        compressedText = this.extractiveCompression(text, currentRatio);
      } else {
        compressedText = this.keywordCompression(text, currentRatio);
      }

      // 防止压缩后文本因标点空格等原因超过原文长度
      if (compressedText.length >= text.length) {
        compressedText = text;
      }

      const accuracy = CompressionMetrics.calculateAccuracy(text, compressedText);

      const result: CompressionResult = {
        originalText: text,
        compressedText: compressedText,
        originalLength: text.length,
        compressedLength: compressedText.length,
        compressionRatio: compressedText.length / (text.length || 1),
        accuracy,
        strategyUsed: this.config.strategy,
      };

      if (!bestResult || result.accuracy > bestResult.accuracy) {
        bestResult = result;
      }

      // 准确率达标则提前返回
      if (accuracy >= this.config.targetAccuracy) {
        break;
      }

      // 若未达标，增大压缩比（保留更多文本），重新尝试
      currentRatio += 0.2; 
      retries++;
    }

    return bestResult!;
  }

  /**
   * 策略 1: 提取式压缩 (Extractive Compression)
   * 将文本拆分句子，通过词频打分保留重要句子。
   */
  private extractiveCompression(text: string, ratio: number): string {
    const sentences = text.split(/([。！？.!?]+)/).filter(Boolean);
    const combinedSentences: string[] = [];
    
    // 恢复句子及其标点
    for (let i = 0; i < sentences.length; i += 2) {
      const sentence = sentences[i];
      const punctuation = sentences[i + 1] || '';
      combinedSentences.push(sentence + punctuation);
    }

    if (combinedSentences.length <= 1) return text;

    // 简单词频统计作为 TF (Term Frequency)
    const words = CompressionMetrics.tokenize(text);
    const wordFreq: Record<string, number> = {};
    words.forEach((w: string) => wordFreq[w] = (wordFreq[w] || 0) + 1);

    // 识别关键词 (频次较高但不是最频繁的词，通常是领域词汇)
    const sortedFreq = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]);
    const keywords = new Set(sortedFreq.slice(3, 15).map(([w]) => w));

    const scoredSentences: SentenceScore[] = combinedSentences.map((s, idx) => {
      const sentenceWords = CompressionMetrics.tokenize(s);
      let score = 0;
      sentenceWords.forEach((w: string) => {
        score += wordFreq[w] || 0;
        // 关键词加成
        if (keywords.has(w)) {
          score += 2.0; 
        }
      });
      
      // 长度惩罚，防止长句天然得分高
      if (sentenceWords.length > 0) {
        score = score / Math.sqrt(sentenceWords.length);
      }
      
      // 位置权重 (Position Weight): 首句和末句加成
      const positionWeight = idx === 0 || idx === combinedSentences.length - 1 ? 1.5 : 1.0;
      score *= positionWeight;
      
      return { text: s, score, index: idx };
    });

    // 排序选出得分最高的前 N 个句子
    const keepCount = Math.max(1, Math.ceil(combinedSentences.length * ratio));
    const selected = scoredSentences
      .sort((a, b) => b.score - a.score)
      .slice(0, keepCount)
      .sort((a, b) => a.index - b.index); // 恢复原文顺序

    let resultText = selected.map(s => s.text.trim()).join(' ');
    // 移除中文字符之间的多余空格，避免增加长度
    resultText = resultText.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2');
    
    return resultText;
  }

  /**
   * 策略 2: 关键词提取 (Keyword Extraction)
   * 仅保留出现频率最高的关键词，极大缩减体积。
   */
  private keywordCompression(text: string, ratio: number): string {
    const words = CompressionMetrics.tokenize(text);
    if (words.length <= 1) return text;

    const wordFreq: Record<string, number> = {};
    words.forEach((w: string) => wordFreq[w] = (wordFreq[w] || 0) + 1);

    // 过滤简单的停用词
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'for', 'with', 'on', 'at', 'by']);
    const uniqueWords = Array.from(new Set(words)).filter((w: string) => !stopWords.has(w));

    // 按频率降序排序
    const sortedWords = uniqueWords.sort((a: string, b: string) => wordFreq[b] - wordFreq[a]);
    
    const keepCount = Math.max(1, Math.ceil(sortedWords.length * ratio));
    return sortedWords.slice(0, keepCount).join(', ');
  }
}
