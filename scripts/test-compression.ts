import { ContextCompressor } from '../src/core/compression/compressor.js';
import * as fs from 'fs';
import * as path from 'path';

// 准备测试数据
const sampleText1 = `
设计并实现一个上下文消息精简化系统，该系统能够在保持80%准确率（该阈值可作为可调参数配置）的前提下，对原始上下文消息进行智能压缩和提炼。
系统需要包含以下核心功能模块：消息重要性评估算法、语义保留分析引擎、压缩比例动态调节器、准确率验证机制。
要求支持多种压缩策略（如关键词提取、句子压缩、语义摘要），具备实时处理能力，并提供压缩前后的语义相似度对比和准确率计算功能。
最终交付完整的系统架构设计、核心算法实现、参数配置接口、性能测试报告，以及详细的准确率评估方法和调优指南。
`;

const sampleText2 = `
The quick brown fox jumps over the lazy dog. 
This is a simple test sentence to see if the extraction algorithm works properly. 
It should be able to identify the most important words and sentences in this short paragraph.
If the compression ratio is too low, we might lose important details like the quick brown fox.
However, maintaining a high accuracy is crucial for the performance of the system.
`;

async function runTests() {
  console.log('==========================================');
  console.log('上下文智能压缩系统 - 性能测试与准确率评估');
  console.log('==========================================\n');

  const compressorExtractive = new ContextCompressor({ strategy: 'extractive', targetAccuracy: 0.8 });
  const compressorKeyword = new ContextCompressor({ strategy: 'keyword', targetAccuracy: 0.8 });

  const tests = [
    { name: '测试用例 1: 中文长需求描述 (Extractive)', text: sampleText1, compressor: compressorExtractive },
    { name: '测试用例 2: 中文长需求描述 (Keyword)', text: sampleText1, compressor: compressorKeyword },
    { name: '测试用例 3: 英文段落 (Extractive)', text: sampleText2, compressor: compressorExtractive },
  ];

  let report = `# 性能测试报告 (Performance Test Report)\n\n`;
  report += `测试时间: ${new Date().toISOString()}\n\n`;

  for (const test of tests) {
    console.log(`正在运行: ${test.name}...`);
    const start = performance.now();
    const result = test.compressor.compress(test.text);
    const end = performance.now();

    const timeMs = (end - start).toFixed(2);
    
    report += `## ${test.name}\n`;
    report += `- **策略 (Strategy):** ${result.strategyUsed}\n`;
    report += `- **耗时 (Time):** ${timeMs} ms\n`;
    report += `- **压缩比 (Compression Ratio):** ${(result.compressionRatio * 100).toFixed(2)}%\n`;
    report += `- **准确率/语义保留度 (Accuracy):** ${(result.accuracy * 100).toFixed(2)}%\n`;
    report += `- **原始长度:** ${result.originalLength} 字符\n`;
    report += `- **压缩后长度:** ${result.compressedLength} 字符\n`;
    report += `\n**压缩后文本:**\n> ${result.compressedText}\n\n`;
    
    console.log(`  完成! 耗时: ${timeMs}ms, 准确率: ${(result.accuracy * 100).toFixed(2)}%, 压缩比: ${(result.compressionRatio * 100).toFixed(2)}%\n`);
  }

  const reportPath = path.resolve(process.cwd(), 'docs', 'compression-test-report.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  console.log(`测试报告已生成: ${reportPath}`);
}

runTests().catch(console.error);
