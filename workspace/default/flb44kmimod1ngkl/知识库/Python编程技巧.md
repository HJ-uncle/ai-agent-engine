# 🐍 Python编程技巧知识库

## 常用代码片段

### 1. 列表推导式
```python
# 生成平方数
squares = [x**2 for x in range(10)]

# 条件过滤
even_squares = [x**2 for x in range(10) if x % 2 == 0]
```

### 2. Lambda函数
```python
# 排序时指定key
students.sort(key=lambda s: s['score'], reverse=True)
```

### 3. 装饰器
```python
def timer(func):
    def wrapper(*args, **kwargs):
        import time
        start = time.time()
        result = func(*args, **kwargs)
        print(f"耗时: {time.time()-start:.2f}秒")
        return result
    return wrapper
```

## 最佳实践
- 使用 `with` 语句管理资源
- 优先使用 `enumerate` 而不是 `range(len())`
- 使用 `zip` 并行遍历多个列表
