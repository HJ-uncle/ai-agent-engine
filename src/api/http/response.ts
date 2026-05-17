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

export function paginateArray<T>(items: T[], current?: number, pageSize?: number): StandardResponse<T[]> {
  if (current != null && pageSize != null) {
    const total = items.length
    const totalPages = Math.ceil(total / pageSize)
    const start = (current - 1) * pageSize
    const paginatedItems = items.slice(start, start + pageSize)
    return successWithPagination(paginatedItems, {
      current: Number(current),
      pageSize: Number(pageSize),
      total,
      totalPages,
    })
  }
  return success(items)
}
