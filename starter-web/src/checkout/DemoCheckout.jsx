import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/useAuth.js';
import { workspaceIdentity } from '../auth/state.js';
import { checkoutRequest } from './api.js';
import { displayPrice, intentKey, readIntent, saveIntent } from './state.js';
import './checkout.css';

const disclaimer = 'Synthetic demo only. No money is collected, no payment is processed, and no credits are granted.';

export function DemoCheckout() {
  const auth = useAuth();
  const identity = workspaceIdentity(auth);
  const signedIn = auth.enabled && auth.sessionStatus === 'authenticated' && Boolean(auth.session?.profile?.id);
  return <section className="demo-checkout" aria-labelledby="demo-title">
    <p className="eyebrow">Checkout sandbox</p>
    <h1 id="demo-title">Demo credit packs</h1>
    <p className="demo-disclaimer">{disclaimer}</p>
    {signedIn ? <SignedInCheckout key={identity} identity={identity} refreshSession={auth.refreshSession} />
      : <p role="status">Sign in to a self-hosted account to view demo packs and your demo order history. This demo is unavailable in other authentication modes.</p>}
  </section>;
}

function SignedInCheckout({ identity, refreshSession }) {
  const [availability, setAvailability] = useState('loading');
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [intent, setIntent] = useState(null);
  const [confirmedRequest, setConfirmedRequest] = useState(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(false);
  const locked = useRef(false);
  const controller = useRef(null);

  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; controller.current?.abort(); };
  }, []);
  const owns = (request) => alive.current && controller.current === request && !request.signal.aborted;

  function recoverIntent() {
    try { const saved = readIntent(window.localStorage, identity); setIntent(saved); setStorageBlocked(false); return saved; }
    catch { setStorageBlocked(true); setError('Browser storage is unavailable or the saved request is unreadable. Creating an order is disabled to prevent an unsafe retry. Existing orders can still be refreshed.'); return undefined; }
  }

  async function perform(operation) {
    if (locked.current || !alive.current) return;
    locked.current = true;
    const request = new AbortController();
    controller.current = request;
    setBusy(true); setError('');
    try { await operation(request); }
    catch (failure) {
      if (!owns(request)) return;
      setError(failure.status === 401 ? 'Your session expired. Sign in again to continue.'
        : failure.code === 'invalid_request:order_not_pending' ? 'This order is no longer pending. Refresh its details.'
          : 'We could not confirm the result. Refresh orders or retry the saved request. A retry uses the same request ID.');
      if (failure.status === 401) refreshSession().catch(() => {});
    } finally {
      if (owns(request)) { locked.current = false; setBusy(false); }
    }
  }

  async function load(request) {
    let catalog;
    try { catalog = await checkoutRequest('/products', { signal: request.signal }); }
    catch (failure) {
      if (owns(request)) {
        setAvailability(failure.status === 404 ? 'disabled' : 'unavailable');
        setProducts([]); setOrders([]); setSelected(null);
      }
      if (failure.status !== 404) throw failure;
      return;
    }
    if (!owns(request)) return;
    setProducts(catalog.products.filter((product) => product.synthetic === true));
    setAvailability('enabled');
    const result = await checkoutRequest('/orders?limit=20', { signal: request.signal });
    if (!owns(request)) return;
    setOrders(result.orders);
  }

  useEffect(() => {
    recoverIntent();
    perform(load);
    const onStorage = (event) => {
      if (event.key === null || event.key === intentKey(identity)) {
        recoverIntent(); setConfirmedRequest(null);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      controller.current?.abort(); locked.current = false;
    };
  }, [identity]);

  function rememberOrder(order) {
    setSelected(order);
    setOrders((current) => [order, ...current.filter((item) => item.orderId !== order.orderId)].slice(0, 20));
    // Only a server response for this exact request resolves an ambiguous POST.
    setConfirmedRequest(order.requestId);
  }

  function createOrder(product) {
    perform(async (request) => {
      if (!navigator.locks?.request) {
        setStorageBlocked(true);
        setError('This browser cannot safely coordinate demo requests across tabs. Order creation is disabled; you can still view existing orders.');
        return;
      }
      // Selection and persistence must be atomic across tabs. A waiting tab
      // reuses the saved operation rather than overwriting an uncertain one.
      let next;
      try {
        next = await navigator.locks.request(intentKey(identity), { signal: request.signal }, () => {
          if (!owns(request)) return null;
          const saved = readIntent(window.localStorage, identity);
          if (saved && saved.requestId !== confirmedRequest) return saved;
          return saveIntent(window.localStorage, identity, { productId: product.id, requestId: crypto.randomUUID() });
        });
      } catch (failure) {
        if (!owns(request)) return;
        setStorageBlocked(true);
        setError('The request ID could not be safely saved. No order request was sent. Existing orders can still be refreshed.');
        return;
      }
      if (!next || !owns(request)) return;
      setIntent(next); setConfirmedRequest(null);
      const order = await checkoutRequest('/orders', { body: next, signal: request.signal });
      if (owns(request)) rememberOrder(order);
    });
  }

  function showOrder(orderId) {
    perform(async (request) => {
      const order = await checkoutRequest(`/orders/${encodeURIComponent(orderId)}`, { signal: request.signal });
      if (owns(request)) rememberOrder(order);
    });
  }

  function cancelOrder(orderId) {
    perform(async (request) => {
      const order = await checkoutRequest(`/orders/${encodeURIComponent(orderId)}/cancel`, { body: {}, signal: request.signal });
      if (owns(request)) rememberOrder(order);
    });
  }

  const unresolved = intent && confirmedRequest !== intent.requestId;
  return <>
    <div className="demo-actions">
      <button className="secondary-button" disabled={busy} onClick={() => perform(load)}>Refresh packs and history</button>
      {busy && <span role="status">Loading demo orders…</span>}
    </div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {availability === 'loading' && <p role="status">Checking demo availability…</p>}
    {availability === 'disabled' && <p role="status">Demo checkout is disabled on this server. An operator must explicitly enable the synthetic demo.</p>}
    {availability === 'unavailable' && <p role="status">Demo checkout is temporarily unavailable.</p>}
    {availability === 'enabled' && <>
      {unresolved && <div className="demo-disclaimer" role="status">
        <p>A saved request may already have created an order. Check it before starting another.</p>
        <button className="secondary-button" disabled={busy || storageBlocked} onClick={() => createOrder({ id: intent.productId })}>Check saved request</button>
      </div>}
      <div className="demo-pack-grid">
        {products.map((product) => <article className="demo-card" key={product.id}>
          <span className="panel-kicker">Synthetic pack</span>
          <h2>{product.label}</h2>
          <p>{product.credits} illustrative credits · {displayPrice(product)}</p>
          <p>No credits will be added to your balance.</p>
          <button className="primary-button" disabled={busy || storageBlocked || Boolean(unresolved)} onClick={() => createOrder(product)}>Create demo order</button>
        </article>)}
      </div>
      <section className="demo-history" aria-labelledby="demo-history-title">
        <h2 id="demo-history-title">Recent demo orders</h2>
        <p>The latest 20 orders for this account. Refresh to load saved server records.</p>
        {!orders.length && <p>No demo orders yet.</p>}
        <ul>{orders.map((order) => <li key={order.orderId}>
          <button className="secondary-button" disabled={busy} onClick={() => showOrder(order.orderId)}>{order.product?.label || 'Demo order'} · {statusLabel(order.status)}</button>
          <small>{order.createdAt}</small>
        </li>)}</ul>
      </section>
      {selected && <section className="demo-card" aria-labelledby="demo-order-title" aria-live="polite">
        <h2 id="demo-order-title">Demo order details</h2>
        <dl>
          <dt>Order</dt><dd>{selected.orderId}</dd>
          <dt>Status</dt><dd>{statusLabel(selected.status)}</dd>
          <dt>Pack snapshot</dt><dd>{selected.product?.label}</dd>
          <dt>Illustrative price</dt><dd>{displayPrice(selected.product)}</dd>
          <dt>Illustrative credits</dt><dd>{selected.product?.credits}</dd>
          <dt>Credits granted</dt><dd>0</dd>
          <dt>Created</dt><dd>{selected.createdAt}</dd>
          {selected.cancelledAt && <><dt>Cancelled</dt><dd>{selected.cancelledAt}</dd></>}
        </dl>
        <p>{disclaimer}</p>
        <div className="demo-actions">
          <button className="secondary-button" disabled={busy} onClick={() => showOrder(selected.orderId)}>Refresh details</button>
          {selected.status === 'pending' && selected.product?.synthetic === true && <button className="secondary-button" disabled={busy} onClick={() => cancelOrder(selected.orderId)}>Cancel demo order</button>}
        </div>
      </section>}
    </>}
  </>;
}

function statusLabel(status) {
  return ({ pending: 'Pending (no payment)', cancelled: 'Cancelled', reconciliation_required: 'Needs operator review' })[status] || 'Unavailable';
}
