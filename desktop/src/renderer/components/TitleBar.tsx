import { MinusOutlined, BorderOutlined, CloseOutlined, RobotOutlined } from '@ant-design/icons'
import styles from './TitleBar.module.css'

export function TitleBar() {
  const api = (window as any).electronAPI

  return (
    <div className={styles.titleBar}>
      <div className={styles.left}>
        <RobotOutlined className={styles.logo} />
        <span className={styles.title}>Agent Desktop</span>
      </div>
      <div className={styles.controls}>
        <button onClick={() => api?.windowMinimize()} className={styles.btn} title="最小化">
          <MinusOutlined />
        </button>
        <button onClick={() => api?.windowMaximize()} className={styles.btn} title="最大化">
          <BorderOutlined />
        </button>
        <button onClick={() => api?.windowClose()} className={`${styles.btn} ${styles.close}`} title="关闭">
          <CloseOutlined />
        </button>
      </div>
    </div>
  )
}
