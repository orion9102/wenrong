'use strict';

/**
 * 简单的内存滑动窗口限流器（零依赖）。
 * 按 key（通常是 API Key id）限制单位时间窗口内的请求数。
 * 进程重启后计数清零——本期是内部工具，足够用；如需跨进程持久化限流，后续再升级。
 */

class RateLimiter {
  constructor({ windowMs = 60000, maxRequests = 60 } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.buckets = new Map(); // key -> number[] timestamps
  }

  /** 返回 { allowed, remaining, resetMs } */
  check(key) {
    const now = Date.now();
    let arr = this.buckets.get(key);
    if (!arr) {
      arr = [];
      this.buckets.set(key, arr);
    }
    // 丢弃窗口外的记录
    while (arr.length && now - arr[0] > this.windowMs) arr.shift();

    if (arr.length >= this.maxRequests) {
      return { allowed: false, remaining: 0, resetMs: this.windowMs - (now - arr[0]) };
    }
    arr.push(now);
    return { allowed: true, remaining: this.maxRequests - arr.length, resetMs: this.windowMs };
  }

  /** 定期清理空桶，避免内存无限增长（key 很多但早已不活跃时） */
  sweep() {
    const now = Date.now();
    for (const [key, arr] of this.buckets) {
      while (arr.length && now - arr[0] > this.windowMs) arr.shift();
      if (arr.length === 0) this.buckets.delete(key);
    }
  }
}

module.exports = { RateLimiter };
