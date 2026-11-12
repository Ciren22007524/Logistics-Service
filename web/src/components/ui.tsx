import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { STATUS_LABEL, errorText, type ShipmentStatus } from '../api';

const STATUS_TONE: Record<ShipmentStatus, string> = {
  CREATED: '',
  LABEL_PENDING: 'info',
  READY_TO_SHIP: 'brand',
  PICKED_UP: 'info',
  IN_TRANSIT: 'info',
  OUT_FOR_DELIVERY: 'info',
  ARRIVED_AT_STORE: 'warn',
  DELIVERED: 'ok',
  EXCEPTION: 'danger',
  RETURNING: 'warn',
  RETURNED: '',
  CANCELLED: '',
  FAILED: 'danger',
};

export function StatusBadge({ status }: { status: ShipmentStatus }) {
  return (
    <span className={`badge ${STATUS_TONE[status]}`} title={status}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Badge({ tone = '', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(fn, deps);
  const reload = useCallback(() => {
    setLoading(true);
    run()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [run]);
  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="alert error">{error}</div> : null;
}

export function Loading() {
  return <div className="muted">載入中…</div>;
}

export function Time({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  const d = new Date(value);
  return (
    <time dateTime={value} title={value}>
      {d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}
    </time>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

/** 執行動作並顯示結果訊息 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, okText?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (okText) setMessage({ tone: 'ok', text: okText });
      return true;
    } catch (e) {
      setMessage({ tone: 'error', text: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const view = message ? <div className={`alert ${message.tone}`}>{message.text}</div> : null;
  return { busy, run, view, setMessage };
}
