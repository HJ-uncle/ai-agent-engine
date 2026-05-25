import React, { useEffect, useState, useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import { memoryApi } from '@core/api'
import { ReloadOutlined } from '@ant-design/icons'

export function MemoryGraphPanel() {
  const [graphData, setGraphData] = useState<{ nodes: any[]; edges: any[] } | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchData = () => {
    setLoading(true)
    memoryApi
      .getGraph()
      .then((res) => setGraphData(res))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchData()
  }, [])

  const option = useMemo(() => {
    if (!graphData) return {}

    // 给不同的类别不同的颜色
    const categories = Array.from(new Set(graphData.nodes.map((n) => n.type)))
    const colors = ['#0e639c', '#4ade80', '#f59e0b', '#ef4444', '#8b5cf6']

    const echartsCategories = categories.map((c, i) => ({
      name: c,
      itemStyle: { color: colors[i % colors.length] },
    }))

    const nodes = graphData.nodes.map((n) => ({
      id: n.id,
      name: n.summary.length > 15 ? n.summary.slice(0, 15) + '...' : n.summary,
      value: n.summary,
      category: categories.indexOf(n.type),
      symbolSize: Math.max(10, (n.strength || 0.5) * 40),
      label: {
        show: true,
        color: '#ccc',
        fontSize: 10,
      },
      tooltip: {
        formatter: `[{b}]<br/>{c}`,
      },
    }))

    const links = graphData.edges.map((e) => ({
      source: e.source,
      target: e.target,
      value: e.description,
      label: {
        show: true,
        formatter: e.type,
        fontSize: 9,
        color: '#888',
      },
      lineStyle: {
        width: Math.max(1, (e.strength || 0.5) * 3),
        curveness: 0.2,
        color: 'source',
      },
    }))

    return {
      tooltip: {},
      legend: [{
        data: categories,
        textStyle: { color: '#888', fontSize: 10 },
        bottom: 0,
      }],
      animationDurationUpdate: 1500,
      animationEasingUpdate: 'quinticInOut',
      series: [
        {
          type: 'graph',
          layout: 'force',
          data: nodes,
          links: links,
          categories: echartsCategories,
          roam: true,
          label: {
            position: 'right',
            formatter: '{b}',
          },
          force: {
            repulsion: 200,
            edgeLength: [50, 200],
          },
        },
      ],
    }
  }, [graphData])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#1e1e1e', borderTop: '1px solid #2d2d2d' }}>
      <div style={{ padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #2d2d2d' }}>
        <span style={{ fontSize: 12, color: '#888' }}>记忆认知图谱 (Beta)</span>
        <ReloadOutlined onClick={fetchData} style={{ cursor: 'pointer', color: '#555', transition: 'color 0.2s' }} onMouseEnter={e => e.currentTarget.style.color = '#fff'} onMouseLeave={e => e.currentTarget.style.color = '#555'} />
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        {loading ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ReloadOutlined spin style={{ color: '#555', fontSize: 24 }} />
          </div>
        ) : graphData?.nodes.length ? (
          <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: 12 }}>
            暂无图谱数据
          </div>
        )}
      </div>
    </div>
  )
}
