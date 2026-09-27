export interface CompressionConfig {
  targetAccuracy: number;       // 目标准确率阈值，例如 0.8
  minCompressionRatio: number;  // 最小压缩比例，例如 0.1
  maxCompressionRatio: number;  // 最大压缩比例，例如 0.9
  strategy: 'extractive' | 'keyword'; // 压缩策略
  maxRetries: number;           // 动态调节最大重试次数，默认 3
}

export interface CompressionResult {
  originalText: string;
  compressedText: string;
  originalLength: number;
  compressedLength: number;
  compressionRatio: number;
  accuracy: number;
  strategyUsed: string;
}

export interface SentenceScore {
  text: string;
  score: number;
  index: number;
}
