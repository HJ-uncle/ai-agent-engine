export interface Pagination {
  current: number
  pageSize: number
  total: number
  totalPages: number
}

export interface StandardResponse<T = any> {
  code: number
  message: string
  data: T | null
  pagination?: Pagination
  metadata?: Record<string, any>
  timestamp: number
}

export function success<T>(data: T, msg: string = '操作成功'): StandardResponse<T> {
  return {
    code: 200,
    message: msg,
    data,
    timestamp: Date.now(),
  }
}

export function successWithPagination<T>(data: T[], pagination: Pagination, msg: string = '查询成功'): StandardResponse<T[]> {
  return {
    code: 200,
    message: msg,
    data,
    pagination,
    timestamp: Date.now(),
  }
}

export function fail(code: number, msg: string, data: any = null): StandardResponse<any> {
  return {
    code,
    message: msg,
    data,
    timestamp: Date.now(),
  }
}

export function paginateArray<T>(items: T[], current?: number | string, pageSize?: number | string): StandardResponse<T[]> {
  if (current != null && pageSize != null) {
    // Query strings arrive as strings on routes without a coercing schema.
    // Normalize before arithmetic: start + "200" otherwise concatenates.
    const page = Number(current)
    const size = Number(pageSize)
    if (!['number', 'string'].includes(typeof current) || !['number', 'string'].includes(typeof pageSize)
      || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1) {
      return fail(40001, '参数验证失败：current 和 pageSize 必须是正整数')
    }
    const total = items.length
    const totalPages = Math.ceil(total / size)
    const start = (page - 1) * size
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(start + size)) {
      return fail(40001, '参数验证失败：分页范围超出安全整数范围')
    }
    const paginatedItems = items.slice(start, start + size)
    return successWithPagination(paginatedItems, {
      current: page,
      pageSize: size,
      total,
      totalPages,
    })
  }
  return success(items)
}
