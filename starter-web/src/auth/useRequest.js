import { useCallback, useEffect, useRef, useState } from 'react';
import { createRequestScope } from './state.js';

export function useRequest() {
  const scope = useRef(createRequestScope());
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);

  const cancel = useCallback(() => {
    scope.current.cancel();
    locked.current = false;
  }, []);
  useEffect(() => cancel, [cancel]);

  const run = useCallback(async (operation, onSuccess, onError) => {
    if (locked.current) return;
    locked.current = true;
    const ticket = scope.current.begin();
    setBusy(true);
    try {
      const result = await operation(ticket.controller.signal);
      if (scope.current.isCurrent(ticket)) onSuccess?.(result);
    } catch (error) {
      if (scope.current.isCurrent(ticket) && error.name !== 'AbortError') onError?.(error);
    } finally {
      if (scope.current.isCurrent(ticket)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }, []);

  return { busy, run, cancel };
}
