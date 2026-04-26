/**
 * 统一 Token 估算逻辑
 * 
 * 估算规则：
 * 1. 英文/数字/符号：约 4 个字符 = 1 Token (0.25 Token/字符)
 * 2. 中文字符：约 1 个字符 = 1.5 ~ 2 Tokens (按 1.5 Token/字符保守估算)
 * 3. 多模态内容 (图片等)：固定估算值
 */
export function estimateTokens(content: string | any[] | null | undefined): number {
  if (!content) return 0;
  
  // 处理多模态数组内容
  if (Array.isArray(content)) {
    return content.reduce((acc, part) => {
      if (part.type === 'text' && part.text) {
        return acc + estimateTokens(part.text);
      }
      if (part.type === 'image_url') {
        // OpenAI GPT-4o 视图片分辨率而定，这里取一个平均保守值
        return acc + 300; 
      }
      if (part.file) {
        // 附件描述信息的消耗
        return acc + estimateTokens(part.file.name || '');
      }
      return acc;
    }, 0);
  }

  // 确保是字符串
  let text = '';
  if (typeof content !== 'string') {
    try {
      text = JSON.stringify(content);
    } catch {
      return 0;
    }
  } else {
    text = content;
  }

  if (!text) return 0;

  // 匹配中文字符
  const chineseChars = text.match(/[\u4e00-\u9fa5]/g) || [];
  const chineseCount = chineseChars.length;
  const otherCount = text.length - chineseCount;

  // 估算公式
  return Math.ceil(chineseCount * 1.5 + otherCount * 0.25);
}
