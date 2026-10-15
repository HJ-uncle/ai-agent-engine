# Excel 创建与保真编辑

## 数据、类型与公式

先按任务确定 sheet、列头和已有数据。编号/手机号/编码为文本，保留前导零；金额/数量为数值；比例使用小数（0.12 表示 12%）或工具支持的百分数字符串；日期列使用 ISO 日期（如 `2026-10-15`），带时间时须有时区。不编造缺失行、数量、日期或结果。模板可以空行/空值交付并说明待填信息。

需随输入变化而重算的结果使用显式对象 `{ "formula": "SUM(B2:B3)" }`。普通字符串 `"=SUM(B2:B3)"` 保持文字，不会自动执行；用户提供的文本不提升为公式。避免外部工作簿引用或自动获取网络数据。

工具仅为受支持的同表基础聚合提供可校验缓存：SUM、AVERAGE、MIN、MAX、COUNT。复杂/跨表/循环等公式可能保留公式但清空旧缓存，并在 `warnings` / `pendingFormulas` 显示待计算状态；工作簿设置为打开时重算。不能把空缓存当 0、不能声称所有公式均已校验。精确结果必需时使用实际可用的计算路径核对，缺能力就明确剩余限制。

## 创建工作簿

```json
{
  "operation": "create",
  "path": "交付/进展统计.xlsx",
  "expectedHash": "missing",
  "workbook": { "sheets": [{
    "name": "项目进展",
    "columns": [
      { "header": "事项", "key": "item", "type": "text", "width": 24 },
      { "header": "工时", "key": "hours", "type": "number" },
      { "header": "完成率", "key": "progress", "type": "percent" },
      { "header": "计划日期", "key": "date", "type": "date" }
    ],
    "rows": [
      { "item": "联调", "hours": 8, "progress": 1, "date": "2026-10-15" },
      { "item": "验证", "hours": 6, "progress": 0.5, "date": null },
      { "item": "合计", "hours": { "formula": "SUM(B2:B3)" }, "progress": null, "date": null }
    ]
  }] }
}
```

这是 API 用法示例，数字不是可复用的业务事实。`columns.key` 对应每行对象字段，sheet 名及列 key 唯一，不允许漏定义列。工具提供冻结首行、表头样式、筛选、数字格式、列宽、打印设置；要在读取实际输出后才描述最终效果。

## 编辑现有工作簿

先 `inspect` 获取真实 sheet/单元格结构、公式与当前 `expectedHash`，然后：

```json
{
  "operation": "edit",
  "path": "交付/进展统计.xlsx",
  "expectedHash": "使用工具刚返回的 sha256 版本",
  "edits": [
    { "sheet": "项目进展", "cell": "B2", "value": 10 },
    { "sheet": "项目进展", "cell": "B4", "value": { "formula": "SUM(B2:B3)" } }
  ]
}
```

只定点修改所列单元格，保留未修改 ZIP parts 和样式，不把整本工作簿重写当作“保留所有原始对象”。工具对数字签名、合并从属单元格、共享/数组公式区域、结构化表等不支持的目标修改会拒绝；不要解锁安全设置或删掉原结构强行完成。编辑后通过 inspect 复查目标值、依赖公式缓存和待计算 warnings。inspect 不展示相邻样式细节；工具内部保留结构不等于模型已独立验证样式，视觉检查需要实际可用的打开或渲染路径。

目前支持 `.xlsx`，CSV 可用现有读取工具取数据后明确新建 `.xlsx`；不能在同路径上悄悄改格式。大型数据按实际限额缩小任务或分文件，不用缺失行伪造完整交付。
