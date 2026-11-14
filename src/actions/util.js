export const ok = (message) => ({ ok: true, message });
export const fail = (message) => ({ ok: false, message });

export function posText(pos) {
  const p = pos.floored ? pos.floored() : pos;
  return `${p.x} ${p.y} ${p.z}`;
}

export function botPos(bot) {
  return `now at ${posText(bot.entity.position)}`;
}

// A short random wait, so actions don't happen with inhuman speed (opening a chest and
// slamming it shut in the same tick, and so on).
export function pause(minMs, maxMs = minMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The name from a name tag, or null. Players don't count, they have usernames.
export function customName(entity) {
  if (entity.type === 'player' || entity.metadata?.[2] == null) return null;
  try {
    return entity.getCustomName()?.toString().trim() || null;
  } catch {
    return null;
  }
}

export class TimeoutError extends Error {}
export class AbortedError extends Error {}
export class StalledError extends Error {}

// Runs task(), giving up after ms, when stalled() returns true (checked every second), or when
// signal aborts. onCancel() undoes whatever task started.
export function guarded(task, { ms, signal, onCancel, stalled }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      onCancel?.();
      finish(reject, new AbortedError('stopped'));
    };
    const timer = setTimeout(() => {
      onCancel?.();
      finish(reject, new TimeoutError('timed out'));
    }, ms);
    const watch = stalled
      ? setInterval(() => {
          if (!stalled()) return;
          onCancel?.();
          finish(reject, new StalledError('stalled'));
        }, 1000)
      : null;

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);
    task().then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}
