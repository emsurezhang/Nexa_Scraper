/**
 * X.com 登录状态检测
 */

import type { Page } from 'playwright';
import type { LoginState } from '../../../core/plugin-contract.js';

export async function checkLoginState(page: Page): Promise<LoginState> {
  // 未登录时 X 会展示登录/注册引导
  const signUpPrompt = await page.$(
    'a[href="/i/flow/signup"], a[href="/i/flow/login"], [data-testid="loginButton"]',
  );
  if (signUpPrompt) return 'logged-out';

  // 已登录标志：侧栏账号按钮、头像、发帖按钮等
  const accountBtn = await page.$(
    '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_More_Menu"], a[data-testid="AppTabBar_Profile_Link"]',
  );
  if (accountBtn) return 'logged-in';

  return 'unknown';
}
