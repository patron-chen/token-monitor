'use strict';

// Keeps deferred main-window stats:push payloads separated by lane when hidden or
// minimized so high-frequency session-activity patches cannot overwrite full stats.
function createDeferredMainWindowPush({
  delayMs = 50,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {})
{
  let statusPayload = null;
  let statsPayload = null;
  let activityPayload = null;
  let flushTimer = null;

  function cancelFlush()
  {
    if (flushTimer === null)
    {
      return;
    }
    clearTimer(flushTimer);
    flushTimer = null;
  }

  function hasPending()
  {
    return Boolean(statusPayload || statsPayload || activityPayload);
  }

  function defer(payload)
  {
    if (!payload)
    {
      return;
    }
    if (payload.event === 'status')
    {
      statusPayload = payload;
      return;
    }
    if (payload.event === 'session-activity')
    {
      activityPayload = payload;
      return;
    }
    statsPayload = payload;
    // A newer full stats snapshot supersedes any older queued activity diff.
    activityPayload = null;
  }

  function clearDeliveredLane(payload)
  {
    if (!payload)
    {
      return;
    }
    if (payload.event === 'status')
    {
      statusPayload = null;
    }
    else if (payload.event === 'session-activity')
    {
      activityPayload = null;
    }
    else
    {
      statsPayload = null;
      activityPayload = null;
    }
    if (!hasPending())
    {
      cancelFlush();
    }
  }

  function deliver(payload, { isVisible, send } = {})
  {
    if (!payload)
    {
      return;
    }
    if (typeof isVisible === 'function' && isVisible())
    {
      // Prevent a still-pending reveal timer from delivering an older snapshot after a live push.
      clearDeliveredLane(payload);
      if (typeof send === 'function')
      {
        send(payload);
      }
      return;
    }
    defer(payload);
  }

  function flush({ canSend, send } = {})
  {
    cancelFlush();
    if (!hasPending() || typeof canSend !== 'function' || typeof send !== 'function')
    {
      return;
    }
    // Defer briefly after reveal so the painted frame settles, retaining queued payloads
    // unless the window is still actively visible when the timer runs.
    flushTimer = setTimer(() =>
    {
      flushTimer = null;
      if (!canSend())
      {
        return;
      }
      const nextStatus = statusPayload;
      const nextStats = statsPayload;
      const nextActivity = activityPayload;
      statusPayload = null;
      statsPayload = null;
      activityPayload = null;
      if (nextStatus)
      {
        send(nextStatus);
      }
      if (nextStats)
      {
        send(nextStats);
      }
      if (nextActivity)
      {
        send(nextActivity);
      }
    }, delayMs);
  }

  function clear()
  {
    cancelFlush();
    statusPayload = null;
    statsPayload = null;
    activityPayload = null;
  }

  return {
    defer,
    deliver,
    flush,
    cancelFlush,
    clear,
    hasPending
  };
}

module.exports = {
  createDeferredMainWindowPush
};
