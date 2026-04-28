import React, { useState } from 'react'
import { Button, Input, Card, message } from 'antd'
import { MailOutlined, EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons'
import { useAuthStore } from '../store/auth'

const OIDC_ISSUER_URL = process.env.REACT_APP_OIDC_ISSUER_URL ?? 'http://localhost:3000'
const REDIRECT_URI = window.location.origin + '/callback'

async function sha256(plain: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(plain)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const uint8Array = new Uint8Array(hash)
  let result = ''
  for (let i = 0; i < uint8Array.length; i++) {
    result += String.fromCharCode(uint8Array[i])
  }
  return btoa(result)
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

async function getCsrfToken(): Promise<string> {
  const codeVerifier = 'dev-challenge-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9)
  const codeChallenge = await sha256(codeVerifier)
  
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.REACT_APP_OIDC_CLIENT_ID || 'multi-agent-console',
    redirect_uri: REDIRECT_URI,
    scope: 'openid email',
    state: crypto.randomUUID(),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  
  localStorage.setItem('pkce_code_verifier', codeVerifier)
  
  const res = await fetch(`${OIDC_ISSUER_URL}/authorize?${params}`, {
    credentials: 'include',
    redirect: 'manual',
  })
  
  if (res.type === 'opaqueredirect') {
    throw new Error('Already logged in, redirecting...')
  }
  
  const html = await res.text()
  const match = html.match(/name="csrf_token" value="([^"]+)"/)
  if (!match) throw new Error('Failed to get CSRF token')
  return match[1]
}

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [step, setStep] = useState<'email' | 'verify'>('email')
  const [loading, setLoading] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [csrfToken, setCsrfToken] = useState('')
  const login = useAuthStore((state) => state.login)

  const handleSendOtp = async () => {
    if (!email.trim()) {
      message.error('请输入邮箱地址')
      return
    }

    setLoading(true)
    try {
      const fetchedCsrfToken = await getCsrfToken()
      setCsrfToken(fetchedCsrfToken)
      const res = await fetch(`${OIDC_ISSUER_URL}/otp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: email.trim(), csrf_token: fetchedCsrfToken }),
        credentials: 'include',
      })
      const text = await res.text()
      if (text.includes('发送失败') || text.includes('error') || !res.ok) {
        message.error('发送失败，请稍后重试')
      } else {
        message.success('验证码已发送，请查收邮箱')
        setStep('verify')
      }
    } catch (error: any) {
      if (error.message?.includes('Already logged in')) {
        message.info('检测到您已登录，正在获取认证信息...')
        setTimeout(async () => {
          const codeVerifier = 'dev-challenge-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9)
          const codeChallenge = await sha256(codeVerifier)
          localStorage.setItem('pkce_code_verifier', codeVerifier)
          
          const params = new URLSearchParams({
            response_type: 'code',
            client_id: process.env.REACT_APP_OIDC_CLIENT_ID || 'multi-agent-console',
            redirect_uri: REDIRECT_URI,
            scope: 'openid email',
            state: crypto.randomUUID(),
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
          })
          window.location.href = `${OIDC_ISSUER_URL}/authorize?${params}`
        }, 500)
        return
      }
      message.error('网络错误，请检查OIDC服务是否运行')
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyOtp = async () => {
    if (!email.trim() || !token.trim()) {
      message.error('请填写邮箱和验证码')
      return
    }

    if (token.trim().length !== 6) {
      message.error('验证码为6位数字')
      return
    }

    setLoading(true)
    try {
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = `${OIDC_ISSUER_URL}/otp/verify`
      form.target = '_self'
      
      const emailInput = document.createElement('input')
      emailInput.type = 'hidden'
      emailInput.name = 'email'
      emailInput.value = email.trim()
      form.appendChild(emailInput)
      
      const tokenInput = document.createElement('input')
      tokenInput.type = 'hidden'
      tokenInput.name = 'token'
      tokenInput.value = token.trim()
      form.appendChild(tokenInput)
      
      const csrfInput = document.createElement('input')
      csrfInput.type = 'hidden'
      csrfInput.name = 'csrf_token'
      csrfInput.value = csrfToken
      form.appendChild(csrfInput)
      
      document.body.appendChild(form)
      form.submit()
    } catch (error) {
      message.error('验证失败，请重试')
      setLoading(false)
    }
  }

  const exchangeCodeForToken = async (code: string) => {
    try {
      const res = await fetch(`${OIDC_ISSUER_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: process.env.REACT_APP_OIDC_CLIENT_ID || 'multi-agent-console',
          redirect_uri: REDIRECT_URI,
          code,
          code_verifier: 'dev-verifier-' + Date.now(),
        }),
      })
      const data = await res.json()
      if (data.access_token) {
        login({
          accessToken: data.access_token,
          idToken: data.id_token,
          expiresAt: Date.now() + (data.expires_in * 1000),
          email: email,
        })
        message.success('登录成功')
        window.location.reload()
      } else {
        message.error(data.error_description || '登录失败，请重试')
      }
    } catch (error) {
      message.error('Token获取失败')
    }
  }

  const handleBack = () => {
    setStep('email')
    setToken('')
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #1e1e1e 0%, #2d2d2d 100%)',
    }}>
      <Card
        style={{
          width: 420,
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
          border: '1px solid #3c3c3c',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{
            width: 64,
            height: 64,
            margin: '0 auto 16px',
            background: 'linear-gradient(135deg, #0e639c 0%, #1a8cd8 100%)',
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <MailOutlined style={{ fontSize: 32, color: '#fff' }} />
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 4 }}>邮箱登录</h1>
          <p style={{ color: '#8b949e', fontSize: 14 }}>使用邮箱验证码登录系统</p>
        </div>

        {step === 'email' ? (
          <div>
            <Input
              type="email"
              prefix={<MailOutlined />}
              placeholder="请输入邮箱地址"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ marginBottom: 16 }}
              size="large"
              onPressEnter={handleSendOtp}
            />

            <Button
              type="primary"
              block
              size="large"
              loading={loading}
              onClick={handleSendOtp}
              style={{
                background: 'linear-gradient(135deg, #0e639c 0%, #1a8cd8 100%)',
                border: 'none',
              }}
            >
              发送验证码
            </Button>

            <p style={{
              textAlign: 'center',
              color: '#8b949e',
              fontSize: 12,
              marginTop: 12,
            }}>
              验证码将发送到您的邮箱
            </p>
          </div>
        ) : (
          <div>
            <Input
              type="email"
              prefix={<MailOutlined />}
              placeholder="邮箱地址"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ marginBottom: 16 }}
              size="large"
            />

            <Input
              type={showToken ? 'text' : 'password'}
              prefix={<span style={{ fontSize: 14 }}>🔢</span>}
              suffix={
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 4,
                  }}
                >
                  {showToken ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                </button>
              }
              placeholder="请输入6位验证码"
              value={token}
              onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
              style={{ marginBottom: 16 }}
              size="large"
              maxLength={6}
              onPressEnter={handleVerifyOtp}
            />

            <Button
              type="primary"
              block
              size="large"
              loading={loading}
              onClick={handleVerifyOtp}
              style={{
                marginBottom: 12,
                background: 'linear-gradient(135deg, #0e639c 0%, #1a8cd8 100%)',
                border: 'none',
              }}
            >
              验证并登录
            </Button>

            <Button
              type="default"
              block
              size="large"
              onClick={handleBack}
            >
              返回
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}