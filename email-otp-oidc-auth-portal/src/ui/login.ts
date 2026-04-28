import { esc, page } from './html.js'

export function loginPage(params: { csrfToken: string; email?: string; error?: string; message?: string }) {
  const { csrfToken, email, error, message } = params
  const msgHtml = message ? `<div class="hint">${esc(message)}</div>` : ''
  const errHtml = error ? `<div class="err">${esc(error)}</div>` : ''
  return page(
    '邮箱验证码登录',
    `<h1>邮箱验证码登录</h1>
     ${msgHtml}
     ${errHtml}
     <form method="post" action="/otp/send">
       <input type="hidden" name="csrf_token" value="${esc(csrfToken)}"/>
       <input name="email" type="email" autocomplete="email" placeholder="输入邮箱" value="${email ? esc(email) : ''}" required/>
       <button type="submit">发送验证码</button>
       <div class="hint">我们将向该邮箱发送一次性验证码。</div>
     </form>
     <form method="post" action="/otp/verify">
       <input type="hidden" name="csrf_token" value="${esc(csrfToken)}"/>
       <input name="email" type="email" autocomplete="email" placeholder="邮箱" value="${email ? esc(email) : ''}" required/>
       <input name="token" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码" required/>
       <button type="submit">验证并继续</button>
     </form>`
  )
}
