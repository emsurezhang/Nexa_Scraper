/**
 * 抖音登录状态检测
 */

import type { Page } from 'playwright';
import type { LoginState } from '../../../core/plugin-contract.js';

export async function checkLoginState(page: Page): Promise<LoginState> {
  // 未登录时抖音会显示登录弹窗或登录按钮
  const loginBtn = await page.$(
    '[data-e2e="user-login-button"], .login-guide-container, [class*="loginGuide"]',
  );
  if (loginBtn) return 'logged-out';

  // 已登录标志：左侧导航中的头像、个人中心入口
  const avatar = await page.$(
    '[data-e2e="user-info-avatar"], .avatar-wrapper, [class*="headerAvatar"]',
  );
  if (avatar) return 'logged-in';

  return 'unknown';
}
