export class CompressionMetrics {
  /**
   * 将文本分词并移除简单的标点符号，返回小写词汇数组
   * 优化：支持中文分词，避免中文长句被当成一个巨型单词
   */
  public static tokenize(text: string): string[] {
    // 优先使用原生的 Intl.Segmenter 进行智能分词 (支持中英文)
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
      const segments = segmenter.segment(text);
      const words: string[] = [];
      for (const seg of segments) {
        if (seg.isWordLike) {
          words.push(seg.segment.toLowerCase());
        }
      }
      return words;
    }

    // 降级方案：正则拆分英文，并在中文字符前后加空格以便拆分
    return text.toLowerCase()
      .replace(/[.,!?;:()\[\]{}""''。！？，、；：“”‘’（）《》]/g, ' ')
      .replace(/([\u4e00-\u9fa5])/g, ' $1 ')
      .split(/\s+/)
      .filter(w => w.length > 0);
  }

  /**
   * 基于 Jaccard 相似度的改进版：计算词汇的语义保留覆盖率（准确率）
   * 衡量压缩后文本保留了多少原文本的核心词汇信息。
   */
  public static calculateAccuracy(originalText: string, compressedText: string): number {
    const origWords = this.tokenize(originalText);
    const compWords = this.tokenize(compressedText);

    if (origWords.length === 0) return 1.0;

    // 简单过滤停用词 (这里仅作为示例，实际可引入完整的 stop words list)
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'for', 'with', 'on', 'at', 'by']);
    const origSet = new Set(origWords.filter(w => !stopWords.has(w)));
    const compSet = new Set(compWords.filter(w => !stopWords.has(w)));

    if (origSet.size === 0) return 1.0;

    let intersectionCount = 0;
    for (const word of compSet) {
      if (origSet.has(word)) {
        intersectionCount++;
      }
    }

    // 保留率 (Coverage)
    return intersectionCount / origSet.size;
  }
}
