/**
 * YouTube 登录状态检测
 */

import type { Page } from 'playwright';
import type { LoginState } from '../../../core/plugin-contract.js';

export async function checkLoginState(page: Page): Promise<LoginState> {
  // 未登录则显示 "Sign in" 按钮
  const signInBtn = await page.$('a[href*="accounts.google.com"], tp-yt-paper-button#sign-in');
  if (signInBtn) return 'logged-out';

  // 已登录用户会有头像按钮
  const avatar = await page.$('#avatar-btn, button#avatar-btn');
  if (avatar) return 'logged-in';

  return 'unknown';
}
