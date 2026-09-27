import React from 'react'
import { List } from 'antd-mobile'
import { AppNavBar } from '../components/AppNavBar'
import styles from './KnowledgePage.module.css'

export default function KnowledgePage() {
  return (
    <div className={styles.page}>
      <AppNavBar title="知识库" />
      <div className={`${styles.content} scroll-area`}>
        <List>
          <List.Item description="知识库管理功能即将在移动端上线">
            知识库列表
          </List.Item>
        </List>
      </div>
    </div>
  )
}
