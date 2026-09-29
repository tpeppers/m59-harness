#!/usr/bin/env node

import assert from 'node:assert/strict';
import { dashboardRedirectUrl, isDashboardOnlyPath } from './m59-dashboard-route.mjs';

assert.equal(isDashboardOnlyPath('/tougher'), true);
assert.equal(isDashboardOnlyPath('/hero/Kermit'), true);
assert.equal(isDashboardOnlyPath('/health'), false);
assert.equal(isDashboardOnlyPath('/fleet'), false);
assert.equal(dashboardRedirectUrl('/tougher?hours=24', '127.0.0.1', 8902),
  'http://127.0.0.1:8902/tougher?hours=24');
assert.equal(dashboardRedirectUrl('/skills', '::ffff:192.168.1.7', 8902),
  'http://192.168.1.7:8902/skills');
assert.equal(dashboardRedirectUrl('/stats', '::1', 8902),
  'http://[::1]:8902/stats');
assert.equal(dashboardRedirectUrl('/health', '127.0.0.1', 8902), null);

assert.equal(dashboardRedirectUrl('/communications?date=2026-09-29', '127.0.0.1', 8902),
  'http://127.0.0.1:8902/communications?date=2026-09-29');
console.log('9 passed, 0 failed');
