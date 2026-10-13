const ACTIVE = new Set(['reserved', 'uncertain']);
const bucketOf = task => Number(task?.duration) === 15 ? '15s' : 'standard';
function accountUsage(account, attempts, day, busy, bucket = 'standard', now = Date.now()) {
  const all = attempts.filter(x => x.accountId === account.id);
  const accepted = all.filter(x => x.day === day && x.phase === 'accepted');
  const held = all.filter(x => ACTIVE.has(x.phase));
  const totalUsed = accepted.length + (account.adjustments?.[day] || 0) + Object.values(account.quotaAdjustments?.[day] || {}).reduce((a, b) => a + b, 0);
  const relation = account.quotaRelation || 'unknown';
  const buckets = {};
  for (const key of ['standard', '15s']) {
    const used = accepted.filter(x => (x.quotaBucket || 'standard') === key).length + (account.quotaAdjustments?.[day]?.[key] || 0);
    const reserved = held.filter(x => (x.quotaBucket || 'standard') === key).length;
    const limit = account.quotaLimits?.[key] ?? account.dailyLimit;
    const ownAvailable = Math.max(0, limit - used - reserved);
    const sharedAvailable = Math.max(0, account.dailyLimit - totalUsed - held.length);
    const blockedUntil = Math.max(account.blockedUntil || 0, account.quotaBlocks?.[key]?.until || 0) || null;
    buckets[key] = { used, reserved, limit, available: blockedUntil && blockedUntil > now ? 0 : relation === 'independent' ? ownAvailable : Math.min(ownAvailable, sharedAvailable), blockedUntil };
  }
  const current = buckets[bucket];
  return { day, used: totalUsed, reserved: held.length, limit: account.dailyLimit, available: current.available, busy, blockedUntil: current.blockedUntil, quotaRelation: relation, selectedBucket: bucket, buckets };
}
module.exports = { bucketOf, accountUsage };
